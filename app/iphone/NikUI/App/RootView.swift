import SwiftUI
import NikCore

/// Lock, then pairing, then the four tabs.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client

    var body: some View {
        @Bindable var model = model
        Group {
            if !model.restored {
                Theme.background.ignoresSafeArea()
            } else if model.lock.locked {
                if model.privacyCovered { Theme.background.ignoresSafeArea() } else { LockView() }
            } else {
                Group {
                    if !model.isPaired {
                        NavigationStack { PairingView() }
                    } else {
                        MainTabs()
                    }
                }
                .overlay(alignment: .top) { BannerView() }
                .sheet(isPresented: Binding(get: { model.showPairing && model.isPaired && !model.lock.locked }, set: { if model.mayPresentContent { model.showPairing = $0 } })) {
                    NavigationStack { PairingView(sheet: true) }
                }
                .modifier(PowerConfirmationHost())
            }
        }
        .opacity(model.privacyCovered ? 0 : 1)
        .allowsHitTesting(!model.privacyCovered)
        .accessibilityHidden(model.privacyCovered)
        .overlay { if model.privacyCovered { Theme.background.ignoresSafeArea() } }
        .preferredColorScheme(colorScheme)
        .tint(Theme.accent)
    }

    private var colorScheme: ColorScheme? {
        switch client.preferences.appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

}

struct MainTabs: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tab) {
            Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: AppTab.chats) {
                NavigationStack(path: $model.chatsPath) {
                    ChatsView()
                        .navigationDestination(for: Route.self) { route in destination(route) }
                }
            }
            .badge(needsYouCount)
            Tab("Terminal", systemImage: "terminal", value: AppTab.terminal) {
                NavigationStack { TerminalView() }
            }
            Tab("Status", systemImage: "chart.bar.xaxis", value: AppTab.status) {
                NavigationStack { StatusView() }
            }
            Tab("Settings", systemImage: "gearshape", value: AppTab.settings) {
                NavigationStack { SettingsView() }
            }
        }
    }

    private var needsYouCount: Int {
        client.fleet.rows.filter { $0.status == .waiting || $0.status == .error }.count
    }

    @ViewBuilder private func destination(_ route: Route) -> some View {
        Group {
            switch route {
            case .conversation(let id): ConversationView(id: id).id(id)
            case .report(let id): ReportView(conversationID: id)
            case .laptopSettings(let id): LaptopSettingsView(conversationID: id)
            case .commands(let id): CommandsView(conversationID: id)
            case .pr(let id): PRView(conversationID: id)
            case .slack: SlackView()
            case .slackThread(let thread): SlackThreadView(thread: thread)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip(conversationID: route.conversationID) }
    }
}

struct BannerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if let banner = model.banner {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon(banner.style)).foregroundStyle(color(banner.style))
                Text(banner.text).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(reduceTransparency ? AnyShapeStyle(Color(uiColor: .systemBackground)) : AnyShapeStyle(.regularMaterial), in: .rect(cornerRadius: 16))
            .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
            .padding(.horizontal, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
            .onTapGesture { withAnimation(.snappy) { model.banner = nil } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isStaticText)
            .id(banner.id)
        }
    }

    private func icon(_ style: Banner.Style) -> String {
        switch style {
        case .info: "info.circle.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "xmark.octagon.fill"
        }
    }

    private func color(_ style: Banner.Style) -> Color {
        switch style {
        case .info: .accentColor
        case .warning: Theme.working
        case .error: Theme.needsYou
        }
    }
}
