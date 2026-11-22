import Foundation
import NikMacIdentity

public enum MacLocalResource {
    public static func directory(_ text: String) throws -> URL {
        let url: URL
        if text.hasPrefix("/") { url = URL(fileURLWithPath: text, isDirectory: true) }
        else if let parsed = URL(string: text), parsed.isFileURL, parsed.host == nil || parsed.host == "" || parsed.host == "localhost" {
            guard parsed.query == nil, parsed.fragment == nil, parsed.user == nil, parsed.password == nil else { throw IdentityFailure("LOCAL_RESOURCE_REQUIRED") }
            url = parsed
        } else { throw IdentityFailure("LOCAL_RESOURCE_REQUIRED") }
        guard !text.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { throw IdentityFailure("PROJECT_DIRECTORY_UNAVAILABLE") }
        return url
    }
}
