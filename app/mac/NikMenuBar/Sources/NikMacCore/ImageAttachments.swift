import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import NikCore
import NikMacIdentity
import AppKit

public enum MacImageSource: Sendable { case file(URL), bytes(Data, name: String) }
public enum MacImageAttachments {
    public static let maximumInputBytes = 30 * 1024 * 1024
    public static let maximumPixelCount = 40_000_000
    public static func validateDimensions(width: Int, height: Int) throws {
        guard width > 0, height > 0, width <= 16384, height <= 16384,
              width <= maximumPixelCount / height else { throw IdentityFailure("IMAGE_DIMENSIONS_TOO_LARGE") }
    }
    @MainActor public static func pasteboardSources(_ pasteboard: NSPasteboard) throws -> [MacImageSource] {
        let items = pasteboard.pasteboardItems ?? []
        guard items.count <= 7 else { throw IdentityFailure("SIX_IMAGES_MAXIMUM") }
        var files: [MacImageSource] = []
        for item in items where item.types.contains(.fileURL) {
            guard let text = item.string(forType: .fileURL), text.utf8.count <= 4096,
                  let url = URL(string: text), url.isFileURL else { throw IdentityFailure("LOCAL_IMAGE_REQUIRED") }
            files.append(.file(url))
        }
        if !files.isEmpty { return files }
        // NSPasteboard provides no byte-length query or streaming data API.
        // Read one representation from one item once, then reject before any
        // decoding/copy to an async task. Never enumerate/read all rasters.
        guard let item = items.first, let type = item.availableType(from: [.png, .tiff]), let data = item.data(forType: type) else { return [] }
        guard data.count <= maximumInputBytes else { throw IdentityFailure("IMAGE_TOO_LARGE") }
        return [.bytes(data, name: "Pasted image")]
    }
    // ImageIO's decoded type, rather than the filename or LaunchServices' type
    // registry (which can be unavailable to a headless process), admits bytes.
    private static let imageTypes: Set<String> = ["public.png", "public.jpeg", "public.tiff", "com.compuserve.gif",
        "org.webmproject.webp", "public.heic", "public.heif", "public.avif", "com.microsoft.bmp", "public.jpeg-2000"]
    public static func prepare(_ source: MacImageSource) async throws -> Attachment {
        try await Task.detached(priority: .userInitiated) {
            let bytes: Data, name: String
            switch source {
            case .bytes(let data, let label): bytes = data; name = label
            case .file(let url):
                guard url.isFileURL else { throw IdentityFailure("LOCAL_IMAGE_REQUIRED") }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values.isRegularFile == true, let size = values.fileSize, size <= maximumInputBytes else { throw IdentityFailure("IMAGE_TOO_LARGE") }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                bytes = try handle.read(upToCount: maximumInputBytes + 1) ?? Data(); name = url.deletingPathExtension().lastPathComponent
            }
            guard bytes.count <= maximumInputBytes else { throw IdentityFailure("IMAGE_TOO_LARGE") }
            guard let image = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let type = CGImageSourceGetType(image), imageTypes.contains(type as String) else {
                throw IdentityFailure("IMAGES_ONLY — Attach up to six images; other files are not supported.")
            }
            guard let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, [kCGImageSourceShouldCache: false] as CFDictionary) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else { throw IdentityFailure("IMAGE_DIMENSIONS_UNAVAILABLE") }
            try validateDimensions(width: width.intValue, height: height.intValue)
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 2048, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { throw IdentityFailure("IMAGE_DECODE_UNAVAILABLE") }
            guard let context = CGContext(data: nil, width: thumbnail.width, height: thumbnail.height, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw IdentityFailure("IMAGE_RENDER_UNAVAILABLE") }
            let rect = CGRect(x: 0, y: 0, width: thumbnail.width, height: thumbnail.height)
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(rect); context.draw(thumbnail, in: rect)
            let output = NSMutableData()
            guard let flattened = context.makeImage(), let encoder = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { throw IdentityFailure("IMAGE_UNAVAILABLE") }
            CGImageDestinationAddImage(encoder, flattened, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            guard CGImageDestinationFinalize(encoder), output.length <= 10 * 1024 * 1024 else { throw IdentityFailure("IMAGE_TOO_LARGE") }
            let data = output as Data
            let clean = String(name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(80))
            return Attachment(.object(["name": .string((clean.isEmpty ? "image" : clean) + ".jpg"), "mediaType": .string("image/jpeg"),
                "data": .string(data.base64EncodedString()), "width": .number(Double(thumbnail.width)), "height": .number(Double(thumbnail.height)),
                "byteCount": .number(Double(data.count)), "sha256": .string(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())]))
        }.value
    }
}
