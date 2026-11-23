import Foundation
import Testing
@testable import NikMacIdentity

@Suite("Compiled Mac flavour boundaries") struct BuildIdentityTests {
    @Test func canonicalExecutablePathsKeepTheKernelPrivatePrefixAndRefuseMissingFiles() throws {
        let directory = "/private/tmp/nik-realpath-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let file = directory + "/node with spaces"
        FileManager.default.createFile(atPath: file, contents: Data())
        let alias = file.replacingOccurrences(of: "/private/tmp/", with: "/tmp/")
        #expect(try ExecutablePackage.canonicalPath(file) == file)
        #expect(try ExecutablePackage.canonicalPath(alias) == file)
        #expect(throws: IdentityFailure("PACKAGE_CONFIGURATION")) { try ExecutablePackage.canonicalPath(file + "-missing") }
    }
    @Test func auxiliaryLauncherReadsItsActualContainingPackage() throws {
        let directory = URL(fileURLWithPath: "/private/tmp/nik-mac/build/p3/identity-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let contents = directory.appendingPathComponent("NikUI.app/Contents")
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        let metadata = try PropertyListSerialization.data(fromPropertyList: info(.current), format: .xml, options: 0)
        try metadata.write(to: contents.appendingPathComponent("Info.plist"))
        let executable = contents.appendingPathComponent("MacOS/nikd").path
        let selected = try AppSelection.selected(executable: executable, accountHome: account)
        let expected = try BuildFlavour.current.selection(info: info(.current), accountHome: account)
        #expect(selected == expected)
        #expect(try ExecutablePackage.contents(executable: executable).path == contents.path)
        #expect(throws: IdentityFailure("PACKAGE_CONFIGURATION")) { try ExecutablePackage.contents(executable: "/tmp/nikd") }
        #expect(try ExecutablePackage.runningExecutable().hasPrefix("/"))
    }
    private let account = "/Users/fixture-owner"
    private func info(_ flavour: BuildFlavour) -> [String: Any] {
        var value: [String: Any] = ["CFBundleIdentifier": flavour.appID, "NikBuildFlavour": flavour.rawValue, "NikEngineLabel": flavour.engineLabel]
        if flavour == .development {
            value["NikEngineTestHome"] = BuildFlavour.testBase + "/p3/fixture"
            value["NikEngineTestRoot"] = BuildFlavour.testBase + "/p3/fixture/profile"
        }
        return value
    }
    @Test func compiledIdentityMatchesCompilerFlag() {
        #if NIKUI_PRODUCTION
        #expect(BuildFlavour.current == .production)
        #expect(BuildFlavour.current.appID == "com.nikui.app")
        #else
        #expect(BuildFlavour.current == .development)
        #expect(BuildFlavour.current.appID == "com.nikui.app.dev")
        #endif
    }
    @Test func productionUsesAccountDatabaseHomeOnly() throws {
        let selection = try BuildFlavour.production.selection(info: info(.production), accountHome: account)
        #expect(selection.home == account)
        #expect(selection.root == account + "/Library/Application Support/NikUI/engine")
        #expect(selection.agentPlist == "com.nikui.engine.plist")
        #expect(!selection.root.contains("tmp"))
    }
    @Test(arguments: ["NikEngineTestHome", "NikEngineTestRoot"])
    func productionRefusesAnyTestMetadata(key: String) {
        var value = info(.production); value[key] = BuildFlavour.testBase + "/p3/test"
        #expect(throws: IdentityFailure("PRODUCTION_ROOT_INVALID")) { try BuildFlavour.production.selection(info: value, accountHome: account) }
    }
    @Test(arguments: ["/private/tmp/nik-mac/build/p3/test", "/tmp/test", "/Users/Shared", "/Users/Shared/test", "/Users/owner/../test", "/Users/owner/", "/Users/a\n"])
    func productionRefusesTestOrInvalidAccountHomes(home: String) {
        #expect(throws: IdentityFailure("PRODUCTION_ROOT_INVALID")) { try BuildFlavour.production.selection(info: info(.production), accountHome: home) }
    }
    @Test func devCannotRegisterProductionLabel() throws {
        try BuildFlavour.development.validateRegistration(label: "com.nikui.engine.development")
        #expect(throws: IdentityFailure("FLAVOUR_LABEL_MISMATCH")) { try BuildFlavour.development.validateRegistration(label: "com.nikui.engine") }
        #expect(throws: IdentityFailure("FLAVOUR_LABEL_MISMATCH")) { try BuildFlavour.production.validateRegistration(label: "com.nikui.engine.development") }
    }
    @Test(arguments: BuildFlavour.allCases) func metadataCannotSwitchCompiledFlavour(flavour: BuildFlavour) {
        let other: BuildFlavour = flavour == .production ? .development : .production
        #expect(throws: IdentityFailure("FLAVOUR_IDENTITY_MISMATCH")) { try flavour.selection(info: info(other), accountHome: account) }
        var mixed = info(flavour); mixed["NikEngineLabel"] = other.engineLabel
        #expect(throws: IdentityFailure("FLAVOUR_IDENTITY_MISMATCH")) { try flavour.selection(info: mixed, accountHome: account) }
    }
    @Test func developmentRequiresCanonicalSealedTestProfile() throws {
        let selected = try BuildFlavour.development.selection(info: info(.development), accountHome: account)
        #expect(selected.home == BuildFlavour.testBase + "/p3/fixture")
        for home in [account, BuildFlavour.testBase + "-escape/home", BuildFlavour.testBase + "/x/../escape", BuildFlavour.testBase + "/x/"] {
            var value = info(.development); value["NikEngineTestHome"] = home; value["NikEngineTestRoot"] = home + "/profile"
            #expect(throws: IdentityFailure("EXPLICIT_TEST_HOME_REQUIRED")) { try BuildFlavour.development.selection(info: value, accountHome: account) }
        }
    }
    @Test func keychainNamespacesAreCompiledAndDisjoint() throws {
        let devService = "com.nikui.engine.test." + String(repeating: "a", count: 32)
        try BuildFlavour.development.validateKeychain(prefix: "com.nikui.engine.test.", service: devService)
        try BuildFlavour.production.validateKeychain(prefix: "com.nikui.engine.production.", service: BuildFlavour.production.keychainService)
        #expect(throws: IdentityFailure("KEYCHAIN_NAMESPACE")) { try BuildFlavour.production.validateKeychain(prefix: "com.nikui.engine.test.", service: devService) }
        #expect(throws: IdentityFailure("KEYCHAIN_NAMESPACE")) {
            try BuildFlavour.development.validateKeychain(prefix: "com.nikui.engine.production.", service: BuildFlavour.production.keychainService)
        }
    }
    @Test func firstRunHasNamedBlockersAndNeverImplicitlyCommits() {
        #expect(CutoverReadiness(flavour: .production, installed: true).blockers == ["SOURCE_SELECTION_REQUIRED", "SOURCE_HANDSHAKE_UNAVAILABLE"])
        #expect(CutoverReadiness(flavour: .production).blockers.first == "INSTALL_IN_APPLICATIONS_REQUIRED")
        #expect(!CutoverReadiness(flavour: .production).mayCommit)
        #expect(CutoverReadiness(flavour: .production, rollback: true).blockers.contains("CURRENT_STATE_EXPORT_REQUIRED"))
        #expect(CutoverReadiness(flavour: .development).blockers == ["DEVELOPMENT_PROFILE_ONLY"])
    }
    @Test func longSocketPathsRefuseWithoutRelocation() {
        #expect(throws: IdentityFailure("SOCKET_PATH_TOO_LONG")) {
            try BuildFlavour.production.selection(info: info(.production), accountHome: "/Users/" + String(repeating: "a", count: 80))
        }
        var value = info(.development)
        let home = BuildFlavour.testBase + "/" + String(repeating: "a", count: 80)
        value["NikEngineTestHome"] = home; value["NikEngineTestRoot"] = home + "/profile"
        #expect(throws: IdentityFailure("SOCKET_PATH_TOO_LONG")) { try BuildFlavour.development.selection(info: value, accountHome: account) }
    }
}
