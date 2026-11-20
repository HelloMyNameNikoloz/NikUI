import SwiftUI
import UIKit
import NikCore

/// A link only stages an invitation. Pairing always needs an unlocked, explicit
/// confirmation, a prepared identity, and a fresh one-shot invitation.
struct PairingView: View {
    var sheet = false
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var code = ""
    @State private var fingerprint = ""
    @State private var deviceName = "iPhone"
    @State private var manual = false
    @State private var busy = false
    @State private var failure: String?
    @State private var identityReady = false
    @State private var confirmForget = false
    private struct IdentityRequest: Equatable { let attempt: PairingAttempt?; let visible: Bool }

    private var attempted: Set<PairingAttempt> { model.pairingAttempts.attempted }
    private var errors: [PairingAttempt: String] { model.pairingAttempts.errors }
    private var manualInvitation: PairingInvitation? {
        PairingLink.manual(address: address, code: code, fingerprint: fingerprint.filter { !$0.isWhitespace })
    }
    private var invitation: PairingInvitation? { model.pendingInvitation ?? (manual ? manualInvitation : nil) }
    private var attempt: PairingAttempt? { invitation.map(PairingAttempt.init) }
    private var alreadyAttempted: Bool { attempt.map { attempted.contains($0) } ?? false }

    var body: some View {
        Group {
            if let invitation = model.pendingInvitation { confirm(invitation) }
            else if manual { manualForm }
            else { instructions }
        }
        .toolbar {
            if sheet {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.pendingInvitation = nil; dismiss() }.disabled(busy)
                }
            }
        }
        .onAppear {
            if address.isEmpty, let base = client.pairedConnection?.baseURL { address = base.absoluteString }
        }
        .task(id: IdentityRequest(attempt: attempt, visible: model.mayPresentContent)) {
            failure = attempt.flatMap { errors[$0] }
            identityReady = false
            guard attempt != nil, model.mayPresentContent else { return }
            let preparing = attempt
            let ready = await model.preparePairingIdentity()
            guard !Task.isCancelled, preparing == attempt else { return }
            identityReady = ready
        }
        .interactiveDismissDisabled(busy)
        .confirmationDialog("Forget the saved local pairing?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget locally", role: .destructive) {
                Task {
                    if case .accepted = await model.forgetLocally() { identityReady = await model.preparePairingIdentity() }
                }
            }
        } message: {
            Text("This deletes the saved laptop data and identity. Your PIN and preferences stay. The remote device record remains until you remove it on the laptop. A new pairing code is required.")
        }
    }

    private var instructions: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Image(systemName: "laptopcomputer.and.iphone")
                    .font(.system(size: 56)).foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text("Pair with your laptop").font(.largeTitle.bold())
                Text("NikUI on your iPhone talks to the NikUI extension on your laptop. Your chats stay on the laptop; the iPhone watches and steers them.")
                    .foregroundStyle(.secondary)
                step(1, "On the laptop, run **NikUI: Pair a device** from the command palette.")
                step(2, "Point this iPhone's **Camera** at the QR code and tap the link it shows.")
                step(3, "Check the laptop name here, then tap **Pair**. The code works once, within a minute.")
                Label("On another network, use Tailscale on the iPhone with the same account as the laptop.", systemImage: "network")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Moving from the previous app requires a new pairing. This app cannot import its old SecKey metadata; remove that device record on the laptop after pairing here.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button { pasteLink() } label: { Label("Paste pairing link", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                Button("Enter the code by hand") { manual = true }.controlSize(.large)
                if let failure { Text(failure).font(.footnote).foregroundStyle(Theme.needsYou) }
            }
            .padding(24).frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text("\(number)").font(.headline).monospacedDigit()
            Text(text)
        }
    }

    private func confirm(_ invitation: PairingInvitation) -> some View {
        ScrollView {
            VStack(spacing: 22) {
                Image(systemName: "laptopcomputer").font(.system(size: 64)).foregroundStyle(Theme.accent).accessibilityHidden(true)
                Text("Pair with this laptop?").font(.title.bold())
                Text(invitation.laptopName ?? "Unnamed laptop").font(.title3.weight(.semibold))
                Text(Self.displayAddress(invitation.baseURL)).font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                if let fingerprint = invitation.fingerprint {
                    Text("Expected laptop fingerprint").font(.subheadline)
                    Text(Self.grouped(fingerprint)).font(.body.monospaced()).textSelection(.enabled)
                } else { trustExplanation }
                if let paired = client.pairedConnection {
                    Label("This replaces \(paired.laptopName).", systemImage: "arrow.triangle.2.circlepath").font(.footnote).foregroundStyle(Theme.working)
                }
                Text("It starts as watch-only. Allow control from the laptop when you are ready.").font(.footnote).foregroundStyle(.secondary)
                pairingStatus
                Button { Task { await pair(invitation) } } label: {
                    HStack { Text("Pair"); if busy { ProgressView() } }.frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(busy || !identityReady || alreadyAttempted)
                Button(alreadyAttempted ? "Close" : "Not now", role: .cancel) {
                    model.pendingInvitation = nil
                    if sheet { dismiss() }
                }
                .controlSize(.large).disabled(busy)
            }
            .multilineTextAlignment(.center)
            .padding(24).frame(maxWidth: 560).frame(maxWidth: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private var manualForm: some View {
        Form {
            Section {
                TextField("laptop.tailnet.ts.net:8790", text: $address)
                    .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            } header: { Text("Laptop address") } footer: {
                Text("Use the address below the laptop's QR code, including its port. Simulator loopback addresses support HTTP.")
            }
            Section("Code") {
                TextField("8 characters", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().font(.body.monospaced())
                    .onChange(of: code) { _, new in
                        let clean = String(PairingLink.normalizeCode(new).prefix(8))
                        if clean != new { code = clean }
                    }
            }
            Section {
                TextField("Laptop fingerprint (optional)", text: $fingerprint)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().font(.body.monospaced())
            } header: { Text("Compare with the laptop") } footer: { trustExplanation }
            Section("This iPhone's name") { TextField("iPhone", text: $deviceName) }
            Section { pairingStatus }
            Section {
                Button {
                    guard let invitation = manualInvitation else { return }
                    Task { await pair(invitation) }
                } label: { HStack { Text("Pair"); Spacer(); if busy { ProgressView() } } }
                .disabled(busy || !identityReady || manualInvitation == nil || alreadyAttempted)
                Button("Paste pairing link") { pasteLink() }.disabled(busy)
                Button("Back to instructions") { manual = false }.disabled(busy)
            }
        }
        .disabled(busy)
        .navigationTitle("Pair by hand")
        .toolbar {
            if !sheet { ToolbarItem(placement: .cancellationAction) { Button("Back") { manual = false }.disabled(busy) } }
        }
    }

    private var trustExplanation: some View {
        Text("A code alone trusts the first laptop fingerprint it receives. Enter the fingerprint shown on the laptop to compare it during pairing, or use a QR/link carrying that fingerprint. You can also compare the complete fingerprint in Security after pairing.")
            .font(.footnote).foregroundStyle(.secondary)
    }
    @ViewBuilder private var pairingStatus: some View {
        if let failure { Text(failure).foregroundStyle(Theme.needsYou) }
        if alreadyAttempted { Text("Request a new code on the laptop before trying again. This code may already have been used.").font(.footnote).foregroundStyle(.secondary) }
        if let error = model.identityError {
            Text(error).foregroundStyle(Theme.needsYou)
            Button("Retry identity preparation") { Task { identityReady = await model.preparePairingIdentity() } }.disabled(model.preparingIdentity)
            Button("Forget saved local pairing…", role: .destructive) { confirmForget = true }.disabled(model.preparingIdentity)
        } else if model.preparingIdentity { ProgressView("Preparing this iPhone's identity…") }
    }

    private func pasteLink() {
        guard let text = UIPasteboard.general.string, let invitation = PairingLink.parse(text) else { failure = "The clipboard has no valid NikUI pairing link."; return }
        model.pendingInvitation = invitation
    }

    private func pair(_ invitation: PairingInvitation) async {
        let key = PairingAttempt(invitation)
        guard model.mayPresentContent, identityReady, !busy, !attempted.contains(key) else { return }
        busy = true; failure = nil; model.pairingAttempts.begin(key)
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = await client.pair(invitation, deviceName: name.isEmpty ? "iPhone" : name)
        busy = false
        switch result {
        case .paired:
            Haptics.success()
            if model.pendingInvitation.map(PairingAttempt.init) == key { model.pendingInvitation = nil }
            if model.pendingInvitation == nil {
                model.showPairing = false
                if sheet { dismiss() }
            }
            await model.pairingCompleted()
        case .failed(let error):
            Haptics.error(); model.pairingAttempts.failed(key, reason: Self.explain(error))
            if attempt == key { failure = errors[key] }
        }
    }

    static func explain(_ error: CoreFailure) -> String {
        switch error.code {
        case .offline, .timeout, .transport:
            "Could not reach the laptop. Check that it is awake and on the same network, or that Tailscale uses the same account. Request a new pairing code on the laptop."
        case .refused:
            "The laptop refused the code. Codes work once and for one minute. Request a new one. (\(error.message))"
        case .wrongLaptop, .crypto:
            "The laptop's identity did not match. Nothing was saved locally. Compare fingerprints on the laptop and request a new invitation. (\(error.message))"
        default: error.message
        }
    }
    static func displayAddress(_ url: URL) -> String { url.absoluteString }
    static func grouped(_ fingerprint: String) -> String {
        let characters = Array(fingerprint)
        return stride(from: 0, to: characters.count, by: 4).map { String(characters[$0..<min($0 + 4, characters.count)]) }.joined(separator: " ")
    }
}
