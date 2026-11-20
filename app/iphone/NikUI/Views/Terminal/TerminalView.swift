import SwiftUI
import NikCore

/// The Terminal tab: run a command on the laptop and read its output as
/// blocks. Not a PTY: no input while a command runs, only Stop.
struct TerminalView: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    /// What to type before any terminal is selected.
    @State private var looseCommand = ""
    @State private var openedHome = false
    @State private var handing: TerminalHandoff?
    @State private var homeHandoff: TerminalHandoff?
    @State private var recent: [String] = []
    @State private var closing: TerminalDescriptor?
    @State private var atBottom = true
    @State private var scrollID: String?
    @State private var restoredTerminal: String?
    @State private var restoringOffset: ReadingState?
    @State private var viewport = ReadingViewport()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focused: Bool

    private struct Preparation: Equatable { let active: Bool; let handoff: TerminalHandoff? }
    private var terminal: TerminalState { client.terminal }
    private var readingKey: String { "terminal:" + (terminal.selectedID ?? "") }
    private var runs: [TerminalRun] { terminal.runs }
    private var running: Bool { (runs.last.map { !$0.done } ?? false) || terminal.selected?.busy == true || terminal.pending != nil }
    /// The command field is each terminal's saved draft in the core.
    private var command: String {
        get { terminal.selectedID.flatMap { terminal.drafts[$0] } ?? (terminal.selectedID == nil ? looseCommand : "") }
        nonmutating set {
            if let id = terminal.selectedID { client.setTerminalDraft(newValue, terminalID: id) } else { looseCommand = newValue }
        }
    }
    private var commandBinding: Binding<String> { Binding(get: { command }, set: { command = $0 }) }

    var body: some View {
            content
                .navigationTitle(terminal.selected?.name ?? "Terminal")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { picker } }
                .safeAreaInset(edge: .bottom) { if terminal.selected != nil { commandBar } }
                .confirmationDialog("Close this terminal?", isPresented: Binding(get: { closing != nil }, set: { if !$0 { closing = nil } }), titleVisibility: .visible, presenting: closing) { t in
                    Button("Close \(t.name)", role: .destructive) { Task { await model.run(.terminalClose(t.id)) } }
                } message: { _ in Text("A running command is stopped.") }
        .task(id: Preparation(active: model.tab == .terminal && model.mayPresentContent && client.mayControl, handoff: model.terminalCommand)) {
            guard model.tab == .terminal, model.mayPresentContent, client.mayControl else { return }
            if let pending = model.terminalCommand {
                await handOff(pending)
                if !Task.isCancelled, model.terminalCommand == pending { model.terminalCommand = nil }
            } else if homeHandoff == nil { await prepare() }
        }
        .alert("Open a Home terminal?", isPresented: Binding(get: { homeHandoff != nil }, set: { if !$0 { homeHandoff = nil } }), presenting: homeHandoff) { handoff in
            Button("Open Home") { Task { await handOff(handoff, confirmedHome: true) } }
            Button("Cancel", role: .cancel) { homeHandoff = nil }
        } message: { _ in
            Text("The laptop cannot open a terminal beside a Codex chat. A Home terminal uses a different folder. Check its path before tapping Run.")
        }
        .onChange(of: client.terminal.selectedID) { _, id in
            // A command typed before a terminal existed moves into the new one.
            if let id, !looseCommand.isEmpty, (terminal.drafts[id] ?? "").isEmpty {
                client.setTerminalDraft(looseCommand, terminalID: id); looseCommand = ""
            }
        }
    }

    @ViewBuilder private var content: some View {
        if !client.mayControl {
            EmptyState(title: "Watch Only", symbol: "eye", message: client.connection.isLive ? "This iPhone can watch but not use the terminal. Ask on the laptop for control." : "The laptop is not connected.")
        } else if let error = terminal.error, terminal.selected == nil {
            VStack { EmptyState(title: "Terminal Unavailable", symbol: "exclamationmark.triangle", message: error)
                Button("Try Again") { Task { await model.run(.terminalList) } }.buttonStyle(.bordered) }
        } else if terminal.selected == nil {
            VStack {
                EmptyState(title: "No Terminal", symbol: "terminal", message: "Open a terminal on the laptop.")
                Button("New Terminal") { Task { await model.run(.terminalOpen()) } }.buttonStyle(.borderedProminent)
            }
        } else {
            blocks
        }
    }

    private var blocks: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let cwd = terminal.selected?.cwd, !cwd.isEmpty {
                        Label(Format.shortPath(cwd), systemImage: "folder").font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error = terminal.error { Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red) }
                    if runs.isEmpty {
                        Text("Run a command below. Output appears here.").foregroundStyle(.secondary).padding(.top, 24)
                    }
                    // Run IDs repeat after the laptop's 60-run cap; displayID does not.
                    ForEach(runs, id: \.displayID) { run in
                        RunBlock(run: run, rerun: { start(run.command) },
                                 stop: { Task { await model.run(.terminalStop(run.terminal.isEmpty ? (terminal.selectedID ?? "") : run.terminal)) } })
                            .id(run.displayID)
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).minY } action: { y in
                                rememberOffset(run.displayID, y: y)
                            }
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .background(ReadingViewportProbe(viewport: viewport).frame(width: 0, height: 0))
                .scrollTargetLayout()
                .padding()
            }
            .scrollPosition(id: $scrollID, anchor: .top)
            .onScrollGeometryChange(for: ReadingGeometry.self) { ReadingGeometry($0) } action: { old, new in
                guard restoringOffset == nil else { return }
                if restoredTerminal == terminal.selectedID, atBottom, old.extent != new.extent {
                    proxy.scrollTo("end", anchor: .bottom)
                    return
                }
                atBottom = new.bottom
                if restoredTerminal == terminal.selectedID {
                    var reading = model.reading(readingKey); reading.followsLatest = new.bottom
                    model.saveReading(reading, key: readingKey)
                }
            }
            .task(id: "\(terminal.selectedID ?? "")-\(terminal.selectedID.flatMap { terminal.runsByTerminal[$0] } != nil)") {
                guard let id = terminal.selectedID, terminal.runsByTerminal[id] != nil, restoredTerminal != id else { return }
                var reading = model.reading(readingKey)
                if reading.anchorID == nil || !runs.contains(where: { $0.displayID == reading.anchorID }) { reading.followsLatest = true }
                atBottom = reading.followsLatest
                restoringOffset = reading.followsLatest ? nil : reading
                scrollID = reading.followsLatest ? "end" : reading.anchorID
                restoredTerminal = id
            }
            .onChange(of: scrollID) { _, anchor in
                guard restoredTerminal == terminal.selectedID else { return }
                var reading = model.reading(readingKey); reading.anchorID = anchor
                if restoringOffset == nil { reading.offset = 0 }
                model.saveReading(reading, key: readingKey)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: runs.last?.output) { _, _ in if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: runs.count) { _, _ in if atBottom { proxy.scrollTo("end", anchor: .bottom) } }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("end", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").frame(width: 44, height: 44).background(.bar, in: .circle)
                    }.accessibilityLabel("Jump to latest").padding()
                }
            }
        }
    }

    private func rememberOffset(_ itemID: String, y: CGFloat) {
        guard restoredTerminal == terminal.selectedID else { return }
        if let saved = restoringOffset, saved.anchorID == itemID, viewport.scrollView != nil {
            restoringOffset = nil; viewport.restore(offset: saved.offset, observedY: y)
        } else if restoringOffset == nil {
            var reading = model.reading(readingKey)
            if reading.anchorID == itemID, !atBottom, abs(reading.offset - Double(y)) > 0.5 {
                reading.offset = Double(y); model.saveReading(reading, key: readingKey)
            }
        }
    }

    // MARK: Picker

    private var picker: some View {
        Menu {
            ForEach(terminal.terminals) { t in
                Button { select(t) } label: {
                    if t.id == terminal.selectedID { Label(t.name, systemImage: "checkmark") } else { Text(t.name) }
                }
            }
            Divider()
            Button { Task { await model.run(.terminalOpen()) } } label: { Label("New Home terminal", systemImage: "plus") }
            Menu("New beside conversation") {
                ForEach(client.fleet.instances.filter { $0.provider == .claude }) { row in
                    Button(row.label.isEmpty ? row.id : row.label) {
                        Task { _ = await model.run(.terminalOpen(session: row.id)) }
                    }
                }
            }
            .disabled(client.fleet.instances.isEmpty)
            if let current = terminal.selected {
                Button { Task { await model.run(.terminalDetach(current.id)) } } label: { Label("Stop Watching", systemImage: "eye.slash") }
                Button { Task { await model.run(.terminalAttach(current.id)) } } label: { Label("Reattach", systemImage: "arrow.clockwise") }
                Button(role: .destructive) { closing = current } label: { Label("Close Terminal", systemImage: "xmark.circle") }
            }
        } label: { Label("Terminals", systemImage: "terminal") }
        .disabled(!client.mayControl || handing != nil)
    }

    private func select(_ t: TerminalDescriptor) {
        Task {
            if let old = terminal.selectedID, old != t.id { await model.run(.terminalDetach(old)) }
            await model.run(.terminalAttach(t.id))
        }
    }

    // MARK: Command bar

    private var commandBar: some View {
        VStack(spacing: 6) {
            if !recent.isEmpty || !command.isEmpty || runs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(quick, id: \.self) { c in
                            Button(c) { command = c; focused = true }
                                .disabled(running)
                                .font(.footnote.monospaced()).buttonStyle(.bordered).buttonBorderShape(.capsule)
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                Text(Format.shortPath(terminal.selected?.cwd ?? "")).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head).frame(maxWidth: 110)
                TextField("Command", text: commandBinding)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focused).submitLabel(.send)
                    .onSubmit { start(command) }
                Menu {
                    ForEach(recent, id: \.self) { c in Button(c) { command = c } }
                } label: { Image(systemName: "clock.arrow.circlepath").frame(minWidth: 44, minHeight: 44) }
                .disabled(recent.isEmpty).accessibilityLabel("Recent commands")
                Button { start(command) } label: { Image(systemName: "arrow.up.circle.fill").font(.title).frame(minWidth: 44, minHeight: 44) }
                    .disabled(command.trimmingCharacters(in: .whitespaces).isEmpty || running || command.utf16.count > 8000)
                    .accessibilityLabel("Run")
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
        .needsControl(client.mayControl)
    }

    private var quick: [String] {
        recent.isEmpty ? ["git status --short", "git diff --stat", "pwd"] : Array(recent.prefix(6))
    }

    private func start(_ text: String) {
        let c = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard client.mayControl, !c.isEmpty, !running, c.utf16.count <= 8000, let id = terminal.selectedID else { return }
        recent.removeAll { $0 == c }; recent.insert(c, at: 0); recent = Array(recent.prefix(20))
        let typed = terminal.drafts[id] ?? ""
        let scope = client.pairedConnection?.scope
        Task {
            // Clear only once the laptop says it began, and only if not edited since.
            if case .accepted = await model.run(.terminalRun(id: id, command: c)), client.pairedConnection?.scope == scope, (client.terminal.drafts[id] ?? "") == typed {
                client.setTerminalDraft("", terminalID: id)
            }
        }
    }

    /// First visit: keep the remembered terminal, else attach the first one, else open Home once.
    private func prepare() async {
        guard model.tab == .terminal, model.mayPresentContent, client.connection.isLive, client.mayControl else { return }
        let scope = client.pairedConnection?.scope
        guard case .accepted = await client.perform(.terminalList), !Task.isCancelled,
              model.tab == .terminal, model.mayPresentContent, client.pairedConnection?.scope == scope else { return }
        if let id = terminal.selectedID, terminal.terminals.contains(where: { $0.id == id }) {
            if terminal.runsByTerminal[id] == nil { await model.run(.terminalAttach(id)) }
            return
        }
        if let first = terminal.terminals.first { await model.run(.terminalAttach(first.id)); return }
        if !openedHome, handing == nil { openedHome = true; await model.run(.terminalOpen()) }
    }

    /// "Run in Terminal" from a chat: a terminal in that chat's folder, the command
    /// typed in, and it only runs when the person taps Run.
    private func handOff(_ handoff: TerminalHandoff, confirmedHome: Bool = false) async {
        guard model.tab == .terminal, model.mayPresentContent, client.mayControl else { model.show("This iPhone can only watch. Allow control on the laptop to use the terminal.", .warning); return }
        if handoff.provider != .claude, !confirmedHome { homeHandoff = handoff; return }
        let scope = client.pairedConnection?.scope
        handing = handoff
        defer { handing = nil }
        let result: ActionResult
        if handoff.provider == .claude {
            result = await model.run(.terminalOpen(session: handoff.conversationID))
        } else {
            result = await model.run(.terminalOpen())
        }
        guard !Task.isCancelled, model.tab == .terminal, model.mayPresentContent, client.pairedConnection?.scope == scope else { return }
        guard case .accepted(let descriptor) = result, let id = descriptor["id"].stringValue else {
            looseCommand = handoff.command
            return
        }
        client.setTerminalDraft(handoff.command, terminalID: id)
        focused = true
    }
}

private struct RunBlock: View {
    let run: TerminalRun
    let rerun: () -> Void
    let stop: () -> Void
    @State private var expanded: Bool?

    private var failed: Bool { run.done && (run.exit ?? 0) != 0 }
    private var folded: Bool { !(expanded ?? (!run.done || failed || run.output.count < 600)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("$ \(run.command)").font(.subheadline.monospaced().bold()).textSelection(.enabled)
                Spacer(minLength: 4)
                badge
            }
            if !run.cwd.isEmpty { Text(Format.shortPath(run.cwd)).font(.caption.monospaced()).foregroundStyle(.secondary) }
            if !run.output.isEmpty {
                Text(folded ? String(run.output.suffix(300)) : run.output)
                    .font(.footnote.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if run.done, run.output.count >= 600 {
                    Button { expanded = folded } label: { Text(folded ? "Show full output" : "Fold output").font(.footnote).frame(minHeight: 44) }
                }
            }
            if let note = run.note, !note.isEmpty { Text(note).font(.footnote).foregroundStyle(.orange) }
            HStack {
                if run.done { Text(Format.duration(ms: run.tookMs)).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if run.done {
                    Button(action: rerun) { Text("Run Again").font(.footnote).frame(minWidth: 44, minHeight: 44) }
                } else {
                    Button("Stop", role: .destructive, action: stop).buttonStyle(.bordered).controlSize(.large)
                }
            }
        }
        .padding(12)
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var badge: some View {
        if !run.done {
            ProgressView().accessibilityLabel("Running")
        } else if let exit = run.exit {
            Label(exit == 0 ? "0" : "\(exit)", systemImage: exit == 0 ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.caption.bold()).foregroundStyle(exit == 0 ? Theme.done : Theme.needsYou)
                .accessibilityLabel(exit == 0 ? "Succeeded" : "Failed with exit \(exit)")
        } else {
            Image(systemName: "stop.circle").foregroundStyle(.secondary).accessibilityLabel("Stopped")
        }
    }
}
