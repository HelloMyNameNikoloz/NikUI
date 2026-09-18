// Apple's own QR detector, used as the independent check on src/qr.js.
import Foundation
import CoreImage

let path = CommandLine.arguments[1]
guard let image = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
    FileHandle.standardError.write("could not read \(path)\n".data(using: .utf8)!)
    exit(2)
}
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(),
                          options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
var found: [String] = []
for feature in detector.features(in: image) {
    if let qr = feature as? CIQRCodeFeature, let message = qr.messageString { found.append(message) }
}
print(found.joined(separator: "\n"))
