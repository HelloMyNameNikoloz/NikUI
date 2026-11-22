import Foundation
import Darwin

// Linked with exactly the same compiled identity source as the app/helper.
@main struct EngineLauncher {
    static func main() {
        do { try launch() }
        catch {
            let code = (error as? IdentityFailure)?.code ?? "PACKAGE_CONFIGURATION"
            FileHandle.standardError.write(Data("{\"ok\":false,\"code\":\"\(code)\"}\n".utf8))
            // Configuration/activation failure must not become a launchd
            // failure-restart loop. Explicit Start retries after repair.
            exit(0)
        }
    }
    static func launch() throws {
        let selection = try AppSelection.selected()
        try BuildFlavour.current.validateRegistration(label: selection.flavour.engineLabel)
        if selection.flavour == .production || selection.isCutoverRehearsal { try selection.validateCommittedProduction() }
        try selection.validateExistingRoot()
        guard let executable = Bundle.main.executablePath else { throw IdentityFailure("PACKAGE_CONFIGURATION") }
        let contents = URL(fileURLWithPath: executable).resolvingSymlinksInPath()
            .deletingLastPathComponent().deletingLastPathComponent()
        let engine = contents.appendingPathComponent("Resources/engine")
        let node = engine.appendingPathComponent("node").path
        let entry = engine.appendingPathComponent("src/macEngine.js").path
        let ssh = getenv("SSH_AUTH_SOCK").map { String(cString: $0) }
        for key in ProcessInfo.processInfo.environment.keys { unsetenv(key) }
        for (key, value) in ["HOME": selection.home, "USERPROFILE": selection.home, "ZDOTDIR": selection.home,
                             "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
                             "TMPDIR": selection.temporaryDirectory, "CODEX_HOME": selection.root + "/home/.codex-work"] {
            setenv(key, value, 1)
        }
        if let ssh { setenv("SSH_AUTH_SOCK", ssh, 1) }
        umask(0o077)
        guard chdir(selection.home) == 0 else { throw IdentityFailure("PACKAGE_CONFIGURATION") }
        var argv: [UnsafeMutablePointer<CChar>?] = [node, entry, "--root", selection.root].map { strdup($0) } + [nil]
        execv(node, &argv)
        throw IdentityFailure("BUNDLED_NODE_EXEC_FAILED")
    }
}
