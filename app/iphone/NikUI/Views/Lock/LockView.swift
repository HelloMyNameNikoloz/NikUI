import SwiftUI
import NikCore

/// Full-screen lock shown over everything, before any chat is visible.
struct LockView: View {
    @Environment(AppModel.self) private var model
    @State private var pin = ""
    @State private var message: String?
    @State private var shake = 0
    @State private var checking = false

    private var lock: AppLock { model.lock }

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let coolingDown = lock.coolingDown(at: context.date)
                ScrollView {
                    VStack(spacing: 24) {
                        Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(.secondary)
                        Text(lock.storageError == nil ? "Enter PIN" : "App lock unavailable")
                            .font(.title2.weight(.semibold))
                        if let error = lock.storageError {
                            Text(error).font(.subheadline).foregroundStyle(Theme.needsYou)
                            Button("Try reading app lock again") { Task { await lock.refreshStatus() } }
                                .buttonStyle(.bordered).controlSize(.large)
                        } else {
                            if coolingDown, let until = lock.waitUntil {
                                Text("Too many tries. Try again in \(Int(until.timeIntervalSince(context.date).rounded(.up))) s.")
                                    .font(.subheadline).foregroundStyle(Theme.needsYou)
                            } else {
                                Text(message ?? " ").font(.subheadline).foregroundStyle(Theme.needsYou)
                            }
                            PinDots(count: pin.count, length: lock.pinLength)
                                .modifier(Shake(animatableData: CGFloat(shake)))
                            PinPad(pin: $pin, maxLength: lock.pinLength ?? 12,
                                   faceID: lock.mayTryFaceID ? lock.biometryName : nil,
                                   onFaceID: { Task { await tryFaceID() } },
                                   onDone: lock.pinLength == nil ? { submit() } : nil)
                                .disabled(coolingDown || lock.busy || checking)
                            if lock.busy || checking { ProgressView("Checking…") }
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 500)
                    .padding(24)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .task(id: coolingDown) {
                    if !coolingDown, lock.waitUntil != nil { await lock.refreshStatus() }
                }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .interactiveDismissDisabled()
        .onChange(of: pin) { _, new in
            if let length = lock.pinLength, new.count == length { submit() }
        }
        .task {
            guard lock.claimAutomaticBiometric() else { return }
            await tryFaceID()
        }
    }

    private func submit() {
        guard !checking, !lock.busy, !lock.coolingDown(at: .now), !pin.isEmpty else { return }
        let entered = pin
        checking = true
        Task {
            let result = await lock.unlock(pin: entered)
            switch result {
            case .unlocked: Haptics.success()
            case .wrong(let left):
                Haptics.error(); shake += 1
                message = left.map { $0 > 0 ? "Wrong PIN. \($0) more before a wait." : "Wrong PIN." } ?? "Wrong PIN."
            case .waitUntil: Haptics.error(); shake += 1; message = nil
            case .failed(let reason): message = reason
            }
            pin = ""; checking = false
        }
    }

    private func tryFaceID() async {
        if await lock.unlockWithFaceID() { Haptics.success() }
        else if !lock.mayTryFaceID && lock.usesFaceID { message = "Use your PIN." }
    }
}

struct PinDots: View {
    let count: Int
    let length: Int?
    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<max(length ?? max(count, 4), count), id: \.self) { i in
                Circle()
                    .fill(i < count ? Color.primary : .clear)
                    .overlay(Circle().strokeBorder(Color.primary.opacity(0.5), lineWidth: 1.5))
                    .frame(width: 12, height: 12)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("\(count) digits entered")
    }
}

/// The phone-keypad grid: digits, delete, and Face ID or OK in the corner.
struct PinPad: View {
    @Binding var pin: String
    var maxLength = 12
    var faceID: String?
    var onFaceID: () -> Void = {}
    var onDone: (() -> Void)?

    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @ScaledMetric(relativeTo: .title) private var digitSize: CGFloat = 28
    private var keySize: CGFloat { verticalSizeClass == .compact ? 52 : 64 }

    private let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]]

    var body: some View {
        VStack(spacing: 12) {
            Grid(horizontalSpacing: 24, verticalSpacing: 12) {
                ForEach(rows, id: \.self) { row in
                    GridRow { ForEach(row, id: \.self) { digit($0) } }
                }
                GridRow {
                    if let faceID {
                        corner(systemImage: faceID == "Touch ID" ? "touchid" : "faceid", label: faceID, action: onFaceID)
                    } else if let onDone, pin.count >= 4 {
                        corner(systemImage: "checkmark", label: "Done", action: onDone)
                    } else {
                        Color.clear.frame(width: keySize, height: keySize)
                    }
                    digit("0")
                    corner(systemImage: "delete.backward", label: "Delete") {
                        if !pin.isEmpty { pin.removeLast() }
                    }
                    .opacity(pin.isEmpty ? 0.3 : 1)
                }
            }
            if let onDone, faceID != nil {
                Button("Done", action: onDone).frame(minWidth: 44, minHeight: 44).disabled(pin.count < 4)
            }
        }
    }

    private func digit(_ d: String) -> some View {
        Button {
            guard pin.count < maxLength else { return }
            Haptics.tap()
            pin.append(d)
        } label: {
            Text(d).font(.system(size: min(digitSize, keySize - 12))).monospacedDigit()
                .frame(width: keySize, height: keySize)
                .background(Color(uiColor: .tertiarySystemFill), in: .circle)
        }
        .buttonStyle(.plain)
    }

    private func corner(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage).font(.title2).frame(width: keySize, height: keySize).contentShape(.circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct Shake: GeometryEffect {
    var animatableData: CGFloat
    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 8 * sin(animatableData * .pi * 4), y: 0))
    }
}

/// Setting or changing the PIN: (current →) new → confirm.
struct PinSetupView: View {
    enum Purpose { case turnOn, change, turnOff }
    let purpose: Purpose
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var step: Step
    @State private var checking = false
    @State private var pin = ""
    @State private var current = ""
    @State private var first = ""
    @State private var message: String?
    @State private var shake = 0

    enum Step { case current, new, confirm }

    init(purpose: Purpose) {
        self.purpose = purpose
        _step = State(initialValue: purpose == .turnOn ? .new : .current)
    }

    var body: some View {
        GeometryReader { geometry in
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let coolingDown = model.lock.coolingDown(at: context.date)
                ScrollView {
                    VStack(spacing: 24) {
                        Text(title).font(.title2.weight(.semibold))
                        if coolingDown, let until = model.lock.waitUntil {
                            Text("Try again in \(Int(until.timeIntervalSince(context.date).rounded(.up))) s.")
                                .foregroundStyle(Theme.needsYou)
                        } else {
                            Text(message ?? subtitle).font(.subheadline)
                                .foregroundStyle(message == nil ? Color.secondary : Theme.needsYou)
                        }
                        PinDots(count: pin.count, length: step == .current ? model.lock.pinLength : (step == .confirm ? first.count : nil))
                            .modifier(Shake(animatableData: CGFloat(shake)))
                        PinPad(pin: $pin, maxLength: step == .confirm ? first.count : (step == .current ? model.lock.pinLength ?? 12 : 12),
                               onDone: needsDone ? { advance() } : nil)
                            .disabled(coolingDown || checking || model.lock.busy)
                        if checking { ProgressView("Saving…") }
                    }
                    .multilineTextAlignment(.center)
                    .padding(24)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .task(id: coolingDown) {
                    if !coolingDown, model.lock.waitUntil != nil { await model.lock.refreshStatus() }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(checking) } }
        .interactiveDismissDisabled(checking)
        .onChange(of: pin) { _, new in
            if step == .confirm, new.count == first.count { advance() }
            if step == .current, let length = model.lock.pinLength, new.count == length { advance() }
        }
    }

    private var needsDone: Bool { step == .new || (step == .current && model.lock.pinLength == nil) }

    private var title: String {
        switch step {
        case .current: "Enter current PIN"
        case .new: "Choose a PIN"
        case .confirm: "Enter it again"
        }
    }

    private var subtitle: String {
        switch step {
        case .current: purpose == .turnOff ? "To turn the lock off." : "To change it."
        case .new: "4 to 12 digits. There is no way to recover a forgotten PIN."
        case .confirm: "To make sure."
        }
    }

    private func advance() {
        guard !checking, !model.lock.busy, !model.lock.coolingDown(at: .now) else { return }
        let entered = pin
        checking = true
        Task {
            defer { checking = false }
            switch step {
            case .current:
                let result = purpose == .turnOff ? await model.lock.turnOff(current: entered) : await model.lock.checkCurrent(entered)
                if result == .unlocked {
                    if purpose == .turnOff { Haptics.success(); dismiss() }
                    else { current = entered; step = .new; message = nil }
                } else { show(result) }
            case .new:
                guard AppLock.isValid(entered) else { wrong("Use 4 to 12 digits."); return }
                first = entered; step = .confirm; message = nil
            case .confirm:
                guard entered == first else { first = ""; step = .new; wrong("Those did not match. Choose again."); return }
                let faceID = purpose == .turnOn ? model.lock.faceIDAvailable : model.lock.usesFaceID
                let result = await model.lock.setPIN(entered, current: purpose == .turnOn ? nil : current, faceID: faceID)
                if result == .unlocked { Haptics.success(); dismiss() }
                else { show(result) }
            }
            pin = ""
        }
    }

    private func show(_ result: AppLock.Outcome) {
        switch result {
        case .wrong: wrong("Wrong PIN.")
        case .waitUntil: wrong("Too many tries. Wait for the countdown.")
        case .failed(let reason): wrong(reason)
        case .unlocked: break
        }
    }

    private func wrong(_ text: String) {
        Haptics.error(); shake += 1; message = text; pin = ""
    }
}
