import Foundation
import Darwin

// launchd supplies a bundle-relative argv[0]. Resolve the signed bundle from
// the actual executable, then exec only its pinned runtime and engine entry.
guard let executable = Bundle.main.executablePath else { exit(78) }
let contents = URL(fileURLWithPath: executable).resolvingSymlinksInPath()
    .deletingLastPathComponent().deletingLastPathComponent()
guard let info = Bundle.main.infoDictionary,
      info["CFBundleIdentifier"] as? String == "com.nikui.engine.dev",
      let home = info["NikEngineTestHome"] as? String,
      let root = info["NikEngineTestRoot"] as? String,
      root.hasPrefix(home + "/"), home.hasPrefix("/private/tmp/nik-mac/build/") else { exit(78) }
let engine = contents.appendingPathComponent("Resources/engine")
let node = engine.appendingPathComponent("node").path
let main = engine.appendingPathComponent("src/macEngine.js").path
// Do not carry shell/VS Code/Node injection variables or live provider homes
// into the service. Tool resolution builds the children’s PATH explicitly.
let ssh = getenv("SSH_AUTH_SOCK").map { String(cString: $0) }
for key in ProcessInfo.processInfo.environment.keys { unsetenv(key) }
for (key, value) in ["HOME": home, "USERPROFILE": home, "ZDOTDIR": home,
                     "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
                     "TMPDIR": home + "/tmp", "CODEX_HOME": root + "/home/.codex-work"] {
    setenv(key, value, 1)
}
if let ssh { setenv("SSH_AUTH_SOCK", ssh, 1) }
umask(0o077)
guard chdir(home) == 0 else { exit(78) }
var argv: [UnsafeMutablePointer<CChar>?] = [node, main, "--root", root].map { strdup($0) } + [nil]
execv(node, &argv)
FileHandle.standardError.write(Data("{\"ok\":false,\"code\":\"BUNDLED_NODE_EXEC_FAILED\"}\n".utf8))
exit(127)
