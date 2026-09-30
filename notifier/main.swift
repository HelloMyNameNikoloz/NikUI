// NikUI's notifier: a banner from the system that opens an instance when clicked.
//
// Built on this machine by src/notifier.js, into VS Code's storage for NikUI,
// because a notification that can be clicked has to come from an app with a
// bundle of its own. osascript's come from Script Editor, and a click opens
// Script Editor.
//
//   nikui-notify --post <id> <title> <subtitle> <body> <inbox> <session> <app> <folder>
//
// posts one and exits. A click later launches it again with no arguments, and
// macOS hands it the notification that was clicked: it writes the instance's
// id into that window's inbox, a file the window is watching, and brings the
// window with that folder to the front. No link: VS Code asks before letting
// anything outside it open one, and a click should not need a second one.
//
//   nikui-notify --click <inbox> <session> <app> <folder>
//
// does what a click does, for checking it without a mouse.

import Cocoa
import UserNotifications

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()

    // The delegate has to be in place before launching finishes, or a click
    // that launched the app is delivered to nobody.
    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.first == "--post", args.count >= 9 {
            post(id: args[1], title: args[2], subtitle: args[3], body: args[4],
                 info: ["inbox": args[5], "session": args[6], "app": args[7], "folder": args[8]])
        } else if args.first == "--click", args.count >= 5 {
            open(inbox: args[1], session: args[2], app: args[3], folder: args[4]) { exit(0) }
        } else {
            // Launched by a click, which arrives in a moment, or by hand.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
        }
    }

    func post(id: String, title: String, subtitle: String, body: String, info: [String: String]) {
        center.requestAuthorization(options: [.alert]) { allowed, _ in
            guard allowed else {
                FileHandle.standardError.write("not allowed\n".data(using: .utf8)!)
                exit(2)
            }
            let content = UNMutableNotificationContent()
            content.title = title
            if !subtitle.isEmpty { content.subtitle = subtitle }
            content.body = body
            content.userInfo = info
            content.threadIdentifier = "nikui-done"
            // Silent: the extension plays its own chime, and only if asked to.
            let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
            self.center.add(request) { error in
                if let error = error {
                    FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
                    exit(3)
                }
                exit(0)
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let text = { (key: String) in info[key] as? String ?? "" }
        open(inbox: text("inbox"), session: text("session"), app: text("app"), folder: text("folder")) {
            done()
            exit(0)
        }
    }

    // Shown even if this app happened to be in front, which it never is.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }

    /**
     * Tell the window, then bring it forward. Opening a folder that is already
     * open brings its window to the front rather than opening another; a
     * window with no single folder can only be had by bringing VS Code up.
     */
    func open(inbox: String, session: String, app: String, folder: String, then: @escaping () -> Void) {
        if !inbox.isEmpty, !session.isEmpty {
            let written = inbox + ".tmp"
            if (try? session.write(toFile: written, atomically: false, encoding: .utf8)) != nil {
                _ = try? FileManager.default.removeItem(atPath: inbox)
                try? FileManager.default.moveItem(atPath: written, toPath: inbox)
            }
        }
        let target = app.isEmpty ? ["-b", "com.microsoft.VSCode"] : ["-a", app]
        run(folder.isEmpty ? target : target + [folder])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: then)
    }

    func run(_ args: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = args
        try? task.run()
        task.waitUntilExit()
    }
}

let app = NSApplication.shared
let notifier = Notifier()
app.delegate = notifier
app.setActivationPolicy(.accessory)
app.run()
