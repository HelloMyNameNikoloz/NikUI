import Foundation
// Bundle-relative exec of the pinned Node runtime: Contents/MacOS/nikd -> Contents/Resources/engine/node main.js
let me = URL(fileURLWithPath: Bundle.main.executablePath!).resolvingSymlinksInPath()
let contents = me.deletingLastPathComponent().deletingLastPathComponent()
let engine = contents.appendingPathComponent("Resources/engine")
let node = engine.appendingPathComponent("node").path
let main = engine.appendingPathComponent("main.js").path
var argv: [UnsafeMutablePointer<CChar>?] = [strdup(node), strdup(main), nil]
execv(node, &argv)
perror("execv"); exit(127)
