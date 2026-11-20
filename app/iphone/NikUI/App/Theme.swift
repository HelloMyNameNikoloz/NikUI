import SwiftUI
import UIKit

/// The few colours NikUI means something by. Everything else is the system's
/// own semantic colours, so light, dark and increased contrast come for free.
enum Theme {
    /// Pure black in dark mode: OLED pixels switch off, the edges disappear
    /// into the bezel. Off-white in light mode.
    static let background = Color("LaunchBackground")
    /// Defined in code: looking up the asset by name resolved to clear in tinted toolbars and tab bars.
    static let accent = Color(UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.498, green: 0.855, blue: 0.769, alpha: 1)
        : UIColor(red: 0.090, green: 0.412, blue: 0.329, alpha: 1) })

    static let working = Color(light: 0xA8840A, dark: 0xF3D86A)   // yellow
    static let done = Color(light: 0x237454, dark: 0x77D6B1)      // green, opened
    static let unread = Color(light: 0x2563C9, dark: 0x7FB2FF)    // blue, finished and not opened
    static let needsYou = Color(light: 0xB3423B, dark: 0xF29891)  // red, waiting or error
    static let idle = Color.secondary.opacity(0.6)

    static let claude = Color(light: 0x975736, dark: 0xE6A481)
    static let codex = Color(light: 0x176954, dark: 0x7FDAC4)
}

extension Color {
    /// A colour with one value for light mode and another for dark.
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(
                red: CGFloat((hex >> 16) & 0xFF) / 255,
                green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255,
                alpha: 1)
        })
    }
}

/// The dot at the start of a chat row. Colour is never the only signal: the
/// row's second line says the state in words, and VoiceOver reads the label.
struct StatusDot: View {
    enum State { case working, waiting, error, done, unread, idle, stopped, asleep }
    let state: State

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(fill)
            .overlay { if state == .asleep { Circle().strokeBorder(Theme.idle, lineWidth: 1.5) } }
            .frame(width: 8, height: 8)
            .opacity(state == .working && pulse ? 0.45 : 1)
            .animation(state == .working && !reduceMotion
                       ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default,
                       value: pulse)
            .onAppear { pulse = state == .working && !reduceMotion }
            .onChange(of: state) { _, new in pulse = new == .working && !reduceMotion }
            .onChange(of: reduceMotion) { _, reduced in pulse = state == .working && !reduced }
            .accessibilityHidden(true)
    }

    private var fill: Color {
        switch state {
        case .working: Theme.working
        case .waiting, .error: Theme.needsYou
        case .done: Theme.done
        case .unread: Theme.unread
        case .idle: Theme.idle
        case .stopped: Theme.idle.opacity(0.5)
        case .asleep: .clear
        }
    }
}
