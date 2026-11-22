import Foundation
import Darwin

#if NIKUI_PRODUCTION && NIKUI_DEVELOPMENT
#error("Select exactly one NikUI build flavour")
#endif

public struct IdentityFailure: Error, Equatable, Sendable, LocalizedError {
    public let code: String
    public init(_ code: String) { self.code = code }
    public var errorDescription: String? { code }
}

/// A compile-time choice. Info.plist and environment never select a flavour.
/// Unqualified `swift test` is development; the production builder passes -D.
public enum BuildFlavour: String, Sendable, CaseIterable {
    case production = "prod", development = "dev"
    public static var current: Self {
        #if NIKUI_PRODUCTION
        .production
        #else
        .development
        #endif
    }
    public var appID: String { self == .production ? "com.nikui.app" : "com.nikui.app.dev" }
    public var engineLabel: String { self == .production ? "com.nikui.engine" : "com.nikui.engine.development" }
    public var appName: String { self == .production ? "NikUI" : "NikUI Dev" }
    public var keychainService: String { "com.nikui.engine.production.selected-store-v1" }
    public static let testBase = "/private/tmp/nik-mac/build"

    public func validateRegistration(label: String) throws {
        guard label == engineLabel else { throw IdentityFailure("FLAVOUR_LABEL_MISMATCH") }
    }
    public func validateKeychain(prefix: String, service: String) throws {
        if self == .production {
            guard prefix == "com.nikui.engine.production.", service == keychainService else { throw IdentityFailure("KEYCHAIN_NAMESPACE") }
        } else {
            guard ["com.nikui.engine.test.", "com.nikui.engine.dev."].contains(prefix), service.hasPrefix(prefix),
                  service.count <= 240,
                  !service.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  String(service.dropFirst(prefix.count)).range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{15,199}$", options: .regularExpression) != nil else {
                throw IdentityFailure("KEYCHAIN_NAMESPACE")
            }
        }
    }
    public func selection(info: [String: Any], accountHome: String) throws -> AppSelection {
        guard info["NikBuildFlavour"] as? String == rawValue,
              info["CFBundleIdentifier"] as? String == appID,
              info["NikEngineLabel"] as? String == engineLabel else { throw IdentityFailure("FLAVOUR_IDENTITY_MISMATCH") }
        if self == .production {
            // The account database, never HOME, determines production storage.
            // No configurable root or test metadata is admitted in this build.
            guard Self.canonical(accountHome), accountHome.hasPrefix("/Users/"),
                  accountHome != "/Users/Shared", !accountHome.hasPrefix("/Users/Shared/"),
                  info["NikEngineTestHome"] == nil, info["NikEngineTestRoot"] == nil else {
                throw IdentityFailure("PRODUCTION_ROOT_INVALID")
            }
            return try checkedSelection(home: accountHome, root: accountHome + "/Library/Application Support/NikUI/engine")
        }
        guard let home = info["NikEngineTestHome"] as? String, let root = info["NikEngineTestRoot"] as? String,
              Self.canonical(home), Self.canonical(root), home.hasPrefix(Self.testBase + "/"),
              root == home + "/profile" else { throw IdentityFailure("EXPLICIT_TEST_HOME_REQUIRED") }
        return try checkedSelection(home: home, root: root)
    }
    private func checkedSelection(home: String, root: String) throws -> AppSelection {
        guard (root + "/c.sock").utf8.count < 104 else { throw IdentityFailure("SOCKET_PATH_TOO_LONG") }
        return AppSelection(flavour: self, home: home, root: root)
    }
    private static func canonical(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) &&
        URL(fileURLWithPath: path).standardized.path == path && !path.hasSuffix("/")
    }
    public static func accountHome() throws -> String {
        guard let user = getpwuid(getuid()), let home = user.pointee.pw_dir else { throw IdentityFailure("ACCOUNT_HOME_UNAVAILABLE") }
        return String(cString: home)
    }
}

public struct AppSelection: Sendable, Equatable {
    public let flavour: BuildFlavour
    public let home: String
    public let root: String
    public var logDirectory: String { flavour == .development ? home : home + "/Library/Logs/NikUI" }
    public var temporaryDirectory: String { flavour == .development ? home + "/tmp" : root + "/home/tmp" }
    public var agentPlist: String { flavour.engineLabel + ".plist" }
    public var isCutoverRehearsal: Bool {
        #if NIKUI_PRODUCTION
        false
        #else
        guard flavour == .development, let resources = Bundle.main.resourceURL,
              let data = try? Data(contentsOf: resources.appendingPathComponent("engine/mac-engine.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return config["acceptanceCutover"] as? Bool == true && config["testHome"] as? String == home && config["root"] as? String == root
        #endif
    }
    public static func selected(bundle: Bundle = .main) throws -> Self {
        try BuildFlavour.current.selection(info: bundle.infoDictionary ?? [:], accountHome: BuildFlavour.accountHome())
    }
    public func validateExistingRoot() throws {
        var at = ""
        for part in root.split(separator: "/") {
            at += "/" + part
            var entry = stat()
            guard lstat(at, &entry) == 0 else { throw IdentityFailure(flavour == .production ? "PRODUCTION_ACTIVATION_REQUIRED" : "EXPLICIT_TEST_HOME_REQUIRED") }
            guard entry.st_mode & S_IFMT == S_IFDIR else { throw IdentityFailure("CONTROL_UNSAFE") }
            if at == root {
                guard entry.st_uid == getuid(), entry.st_mode & 0o777 == 0o700 else { throw IdentityFailure("CONTROL_UNSAFE") }
            }
        }
    }
    public func validateCommittedProduction() throws {
        let file = root + "/production-owner.json"
        var entry = stat()
        guard lstat(file, &entry) == 0 else { throw IdentityFailure("SOURCE_HANDSHAKE_UNAVAILABLE") }
        try validateExistingRoot()
        guard entry.st_uid == getuid(), entry.st_mode & S_IFMT == S_IFREG,
              entry.st_mode & 0o777 == 0o600, entry.st_nlink == 1, entry.st_size > 0, entry.st_size <= 65536,
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: file))) as? [String: Any],
              value["version"] as? Int == 1, value["committed"] as? Bool == true,
              let generation = value["generation"] as? Int, generation > 0,
              value["target"] as? String == flavour.engineLabel else { throw IdentityFailure("SERVICE_OWNERSHIP_REQUIRED") }
        let ownerFile = root + "/o/engine-owner.json"
        var ownerEntry = stat()
        guard lstat(ownerFile, &ownerEntry) == 0, ownerEntry.st_uid == getuid(),
              ownerEntry.st_mode & S_IFMT == S_IFREG, ownerEntry.st_mode & 0o777 == 0o600,
              ownerEntry.st_nlink == 1, ownerEntry.st_size > 0, ownerEntry.st_size <= 65536,
              let owner = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ownerFile))) as? [String: Any],
              owner["mode"] as? String == "service", owner["generation"] as? Int == generation,
              owner["by"] as? String == flavour.engineLabel else { throw IdentityFailure("SERVICE_OWNERSHIP_REQUIRED") }
        // JS additionally verifies the participant lease and selected receipt.
    }
}

/// R1 exposes the opt-in flow without pretending that P2's synthetic source
/// adapter can perform a production migration. No blanket production-off flag.
public struct CutoverReadiness: Equatable, Sendable {
    public var blockers: [String]
    public var mayCommit: Bool { blockers.isEmpty }
    public init(flavour: BuildFlavour, rollback: Bool = false, installed: Bool = false) {
        blockers = flavour == .development ? ["DEVELOPMENT_PROFILE_ONLY"] : rollback
            ? ["SERVICE_OWNERSHIP_REQUIRED", "CURRENT_STATE_EXPORT_REQUIRED"]
            : ["SOURCE_SELECTION_REQUIRED", "SOURCE_HANDSHAKE_UNAVAILABLE"]
        if flavour == .production && !installed { blockers.insert("INSTALL_IN_APPLICATIONS_REQUIRED", at: 0) }
    }
}
