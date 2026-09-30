// NikUI's notifier: a banner from the system that opens an instance when clicked.
//
// Built on this machine by src/notifier.js, into VS Code's storage for NikUI,
// because a notification that can be clicked has to come from an app with a
// bundle of its own. osascript's come from Script Editor, and a click opens
// Script Editor.
//
//   nikui-notify --post <id> <title> <subtitle> <body> <url> <app> <folder>
//
// posts one and exits. A click later launches it again with no arguments, and
// macOS hands it the notification that was clicked: it brings the VS Code
// window with that folder to the front, then opens the NikUI link, which lands
// in the window now in front.
//
//   nikui-notify --click <url> <app> <folder>
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
        if args.first == "--post", args.count >= 8 {
            post(id: args[1], title: args[2], subtitle: args[3], body: args[4],
                 info: ["url": args[5], "app": args[6], "folder": args[7]])
        } else if args.first == "--click", args.count >= 4 {
            open(url: args[1], app: args[2], folder: args[3]) { exit(0) }
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
        open(url: text("url"), app: text("app"), folder: text("folder")) {
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
     * The window first, then the link. VS Code gives a link to the window that
     * was last in front, and opening a folder that is already open brings its
     * window forward rather than opening another.
     */
    func open(url: String, app: String, folder: String, then: @escaping () -> Void) {
        var wait = 0.0
        if !folder.isEmpty {
            run(app.isEmpty ? ["-b", "com.microsoft.VSCode", folder] : ["-a", app, folder])
            wait = 0.7
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
            if !url.isEmpty { self.run(app.isEmpty ? [url] : ["-a", app, url]) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: then)
        }
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
