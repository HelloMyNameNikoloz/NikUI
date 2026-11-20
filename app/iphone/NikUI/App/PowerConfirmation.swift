import SwiftUI
import Observation
import NikCore

/// Shared by laptop power controls. The caller supplies only the action/scope;
/// the root hosts confirmations so pushed views use the same two-step policy.
@MainActor @Observable final class PowerConfirmationCoordinator {
    struct Request {
        let action: ClientAction
        let role: SocketRole
        let laptop: String
        let awake: Bool
    }
    private(set) var prompt: Request?
    private(set) var finalPrompt: Request?
    private(set) var busy = false
    private var submit: ((ClientAction, SocketRole) async -> Void)?

    func request(_ action: ClientAction, on role: SocketRole, laptop: String, lidHeld: Bool,
                 submit: @escaping (ClientAction, SocketRole) async -> Void) {
        guard !busy, prompt == nil, finalPrompt == nil else { return }
        self.submit = submit
        switch action {
        case .setAwake(false): prompt = Request(action: action, role: role, laptop: laptop, awake: true)
        case .setLid(false) where lidHeld: prompt = Request(action: action, role: role, laptop: laptop, awake: false)
        case .setSetting("awake", .bool(false)): prompt = Request(action: action, role: role, laptop: laptop, awake: true)
        case .setSetting("lid", .bool(false)) where lidHeld: prompt = Request(action: action, role: role, laptop: laptop, awake: false)
        default: send(action, on: role)
        }
    }
    func confirmFirst() {
        guard let request = prompt else { return }
        prompt = nil
        if request.awake { finalPrompt = request }
        else { send(request.action, on: request.role) }
    }
    func confirmFinal() {
        guard let request = finalPrompt else { return }
        finalPrompt = nil
        send(request.action, on: request.role)
    }
    func cancel() { prompt = nil; finalPrompt = nil; if !busy { submit = nil } }
    private func send(_ action: ClientAction, on role: SocketRole) {
        guard let submit else { return }
        busy = true
        Task {
            await submit(action, role)
            busy = false; self.submit = nil
        }
    }
}

struct PowerConfirmationHost: ViewModifier {
    @Environment(AppModel.self) private var model
    func body(content: Content) -> some View {
        let power = model.power
        content
            .confirmationDialog(power.prompt?.awake == true ? "Turn off Keep awake on \(power.prompt?.laptop ?? "the laptop")?" : "Release the closed-lid hold on \(power.prompt?.laptop ?? "the laptop")?",
                                isPresented: Binding(get: { power.prompt != nil }, set: { if !$0, power.prompt != nil { power.cancel() } }), titleVisibility: .visible) {
                Button(power.prompt?.awake == true ? "Continue" : "Release closed-lid hold", role: .destructive) { power.confirmFirst() }
                Button("Cancel", role: .cancel) { power.cancel() }
            } message: {
                Text("The laptop may sleep and become unreachable. You may need to wake it in person.")
            }
            .alert("Allow \(power.finalPrompt?.laptop ?? "the laptop") to sleep?",
                   isPresented: Binding(get: { power.finalPrompt != nil }, set: { if !$0 { power.cancel() } })) {
                Button("Turn off Keep awake", role: .destructive) { power.confirmFinal() }
                Button("Cancel", role: .cancel) { power.cancel() }
            } message: {
                Text("Once it sleeps, this iPhone cannot reach it to turn Keep awake back on.")
            }
    }
}
