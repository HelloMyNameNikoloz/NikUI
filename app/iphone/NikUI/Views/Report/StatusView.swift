import SwiftUI
import UIKit
import Charts
import NikCore

// MARK: - Status tab

/// The Status tab: the whole fleet at a glance, the laptop's power, plan limits and lifetime totals.
struct StatusView: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model

    @State private var freshnessDate = Date()
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var state: ReportState { client.report }
    private var offline: Bool { !client.connection.isLive && !client.isPreview }

    var body: some View {
        List {
            statusNotice
            laptopSection
            if let report = state.report {
                Section {
                    NavigationLink("General details") { ReportView() }
                    NavigationLink("Workspace analytics") { WorkspaceAnalyticsView() }
                }
                overviewSection(report)
                pauseSection(report)
                limitsSections(report)
                instancesSection(report)
                projectsSection(report)
                lifetimeSection(report)
            } else if state.available && state.trouble == nil {
                Section {
                    EmptyState(title: state.receivedAt == nil ? "Loading report" : "No session to report", symbol: "chart.bar.xaxis",
                               message: state.receivedAt == nil ? "Waiting for the laptop to send its figures." : "Open a conversation and its figures will appear here.")
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .modifier(ReportScrollMemory(page: "status"))
        .navigationTitle("Status")
        .safeAreaInset(edge: .bottom, spacing: 0) { ConnectionStrip() }
        .refreshable { await refresh() }
        .task {
            while !Task.isCancelled {
                freshnessDate = .now
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { Task { await refresh() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    if let report = state.report {
                        Button { copy(report) } label: { Label("Copy Report", systemImage: "doc.on.doc") }
                    }
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
    }

    // MARK: Loading

    private func refresh() async {
        let revision = state.revision
        if case .notSent = await model.run(.status) { return }
        _ = await model.run(.awake)
        let deadline = Date().addingTimeInterval(12)
        while !client.isPreview, Date() < deadline, !Task.isCancelled, state.revision == revision {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
        if !client.isPreview, state.revision == revision { model.show("The laptop did not send a fresh report. Try again.", .warning) }
    }

    private func copy(_ report: Report) {
        UIPasteboard.general.string = ReportText.make(report, note: staleNote)
        Haptics.success()
        model.show("Report copied")
    }

    private var staleNote: String? { ReportKit.staleNote(state, offline: offline, at: freshnessDate) }

    // MARK: Notices

    @ViewBuilder private var statusNotice: some View {
        if !state.available || state.trouble != nil || staleNote != nil {
            Section {
                if !state.available {
                    Label("The laptop could not produce a status report.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.needsYou)
                }
                if let trouble = state.trouble {
                    Label(trouble, systemImage: "exclamationmark.circle").foregroundStyle(Theme.needsYou)
                }
                if let note = staleNote {
                    Label(offline ? "Offline. \(note)." : "\(note).", systemImage: "clock.arrow.circlepath")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
        }
    }

    // MARK: Laptop

    private var laptopSection: some View {
        Section {
            LabeledContent("Connection") {
                Text(client.connection.words)
                    .foregroundStyle(client.connection.isLive ? Color.secondary : (client.connection.isTrouble ? Theme.needsYou : Theme.working))
            }
            .background(ReportScrollProbe())
            AwakeControls()
        } header: {
            Text("Laptop")
        }
    }

    // MARK: Overview

    private func overviewSection(_ report: Report) -> some View {
        let totals = report.fleetTotals
        let needYou = totals.waiting.flatMap { waiting in totals.errored.map { waiting + $0 } }
        return Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 150 : 76), spacing: 8, alignment: .top)], spacing: 12) {
                Figure(value: ReportKit.count(totals.instances), label: "Open")
                Figure(value: ReportKit.count(totals.working), label: "Working", tint: (totals.working ?? 0) > 0 ? Theme.working : nil)
                Figure(value: ReportKit.count(needYou), label: "Need you", tint: (needYou ?? 0) > 0 ? Theme.needsYou : nil)
                Figure(value: totals.tokens.map(Format.tokens) ?? "—", label: "Tokens")
            }
            .padding(.vertical, 4)
            ReportRow("Claude cost", totals.cost.map(Format.cost))
            ReportRow("Turns", ReportKit.count(totals.turns))
            ReportRow("Tool calls", ReportKit.count(totals.toolCalls), detail: (totals.toolErrors ?? 0) > 0 ? "\(totals.toolErrors ?? 0) failed" : nil)
            ReportRow("Worked", totals.workedMs.map(Format.duration(ms:)))
            ReportRow("Queued prompts", ReportKit.count(totals.queued))
            ReportRow("Asleep", ReportKit.count(totals.asleep))
        } header: {
            Text("Fleet")
        } footer: {
            Text("Counts cover Claude sessions plus loaded or busy Codex sessions, so they can differ from the Chats list. Codex does not report a cost, so the cost counts Claude only.")
        }
    }

    @ViewBuilder private func pauseSection(_ report: Report) -> some View {
        if let pause = report.pause {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Paused for quota").font(.headline)
                        if let until = ReportKit.date(pause.until) {
                            Text("Resumes \(until.formatted(.relative(presentation: .named))) (\(until.formatted(date: .omitted, time: .shortened)))")
                        } else {
                            Text("Resume time not known")
                        }
                        if pause.blind { Text("The limit could not be measured, so this pause is a guess.") }
                        if let type = pause.limitType { Text(ReportKit.humanize(type)) }
                    }
                    .font(.subheadline).foregroundStyle(.secondary)
                } icon: {
                    Image(systemName: "pause.circle.fill").foregroundStyle(Theme.working)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    // MARK: Limits

    @ViewBuilder private func limitsSections(_ report: Report) -> some View {
        let claude = report.limits ?? report.env.limits
        let codex = report.codexLimits.isEmpty ? report.env.codexLimits : report.codexLimits
        if let claude {
            Section { ClaudeLimitRows(limits: claude, offline: offline) } header: { Text("Claude usage") }
        }
        if !codex.isEmpty {
            Section { CodexLimitRows(accounts: codex, offline: offline) } header: { Text("Codex usage") }
        }
    }

    // MARK: Instances

    private func instancesSection(_ report: Report) -> some View {
        let members = Self.prioritised(report.fleet)
        return Section {
            if members.isEmpty {
                Text("No instances in this report").foregroundStyle(.secondary)
            }
            ForEach(Array(members.enumerated()), id: \.offset) { _, member in
                Button {
                    if let id = member.id { model.openConversation(id) }
                } label: { MemberRow(member: member) }
                    .buttonStyle(.plain)
                    .disabled(member.id == nil)
            }
        } header: {
            Text("Instances")
        } footer: {
            Text("Ordered by what needs you first.")
        }
    }

    static func prioritised(_ members: [FleetMember]) -> [FleetMember] {
        func rank(_ member: FleetMember) -> Int {
            if member.asleep { return 4 }
            switch member.status {
            case .waiting, .error: return 0
            case .working: return 1
            case .done: return 2
            default: return 3
            }
        }
        return members.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element), rank(b.element))
            return ra == rb ? a.offset < b.offset : ra < rb
        }.map(\.element)
    }

    // MARK: Projects and lifetime

    @ViewBuilder private func projectsSection(_ report: Report) -> some View {
        if !report.projects.isEmpty {
            CollapsibleSection("Projects", expanded: false) {
                FoldedRows(items: report.projects) { project in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(project.project ?? Format.shortPath(project.path ?? "Unknown")).font(.body)
                            Spacer()
                            Text(project.cost.map(Format.cost) ?? "—").monospacedDigit().foregroundStyle(.secondary)
                        }
                        Text("\(ReportKit.count(project.instances)) instances · \(ReportKit.count(project.working)) working · \(project.tokens.map(Format.tokens) ?? "—") tokens · \(ReportKit.count(project.turns)) turns")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    @ViewBuilder private func lifetimeSection(_ report: Report) -> some View {
        if let life = report.lifetime {
            Section {
                ReportRow("Cost", life.cost.map(Format.cost))
                ReportRow("Tokens", life.tokens.map(Format.tokens))
                ReportRow("Turns", ReportKit.count(life.turns))
                ReportRow("Instances", ReportKit.count(life.instances))
                ReportRow("Projects", ReportKit.count(life.projects))
            } header: {
                Text("Lifetime")
            } footer: {
                if let since = ReportKit.date(life.since) {
                    Text("Since \(since.formatted(date: .abbreviated, time: .omitted)). Lifetime totals can cover a longer period than the figures above.")
                }
            }
        }
    }
}

// MARK: - Laptop power

/// Keep-awake and lid-closed switches for the laptop (spec 5.4).
private struct AwakeControls: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @ViewBuilder var body: some View {
        let awake = client.awake
        if !awake.available {
            Label("Power controls are not available. The laptop did not report them.", systemImage: "bolt.slash")
                .font(.footnote).foregroundStyle(.secondary)
        } else if !awake.supported {
            Label("This laptop cannot be kept awake from here. Only a Mac can.", systemImage: "bolt.slash")
                .font(.footnote).foregroundStyle(.secondary)
        } else {
            Toggle(isOn: Binding(get: { awake.on }, set: { value in if value { Task { _ = await model.run(.setAwake(true)) } } else { model.requestPowerChange(.setAwake(false)) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Keep laptop awake")
                    Text(awakeWords(awake)).font(.caption).foregroundStyle(.secondary)
                }
            }
            .disabled(!awake.mayChange || !client.mayControl || model.power.busy)
            .accessibilityHint(client.mayControl ? "" : "This iPhone can only watch.")

            if let lid = awake.lid, lid.supported {
                Toggle(isOn: Binding(get: { lid.on }, set: { value in if value { Task { _ = await model.run(.setLid(true)) } } else { model.requestPowerChange(.setLid(false)) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Keep working with the lid closed")
                        Text(lidWords(lid)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .disabled(!awake.mayChange || !client.mayControl || model.power.busy)
                .accessibilityHint(client.mayControl ? "" : "This iPhone can only watch.")

                if lid.on && (!lid.approved || lid.reason == "NEEDS_APPROVAL") {
                    Label("Click NikUI in the laptop's status bar and enable \"Keep working with the lid closed\".", systemImage: "hand.tap")
                        .font(.footnote).foregroundStyle(Theme.working)
                }
                if lid.lowBattery {
                    Label("Low battery released the lid setting. It stays on and resumes when charging.", systemImage: "battery.25percent")
                        .font(.footnote).foregroundStyle(Theme.working)
                }
                if let battery = lid.battery {
                    LabeledContent("Battery") {
                        Text("\(battery.percent.map { Format.percent($0 > 1 ? $0 / 100 : $0) } ?? "Unknown")\(battery.ac ? " · on power" : " · on battery")")
                    }
                }
            }
            if let refused = awake.refused {
                Label(refused, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.needsYou)
            }
        }
    }

    /// Requested (`on`) is kept apart from the assertion the laptop actually holds (`held`).
    private func awakeWords(_ awake: AwakeState) -> String {
        switch (awake.on, awake.held) {
        case (true, true):
            if let since = awake.since { return "Awake since \(since.formatted(date: .omitted, time: .shortened))" }
            return "Holding the laptop awake"
        case (true, false): return "Requested, but the laptop is not holding it yet"
        case (false, true): return "Off, but still held while a run finishes"
        case (false, false): return awake.reason ?? "Off"
        }
    }

    private func lidWords(_ lid: LidState) -> String {
        if lid.finishing { return "Finishing the current run first" }
        switch (lid.on, lid.held) {
        case (true, true): return "Held. Closing the lid will not stop work"
        case (true, false): return lid.approved ? "Requested, not held right now" : "Needs approval on the laptop"
        case (false, _): return "Off"
        }
    }
}

// MARK: - Rows

private struct MemberRow: View {
    let member: FleetMember

    private var words: String {
        if member.asleep { return "Asleep" }
        if member.paused { return "Paused for quota" }
        let base = member.status.words
        if let q = member.queue, q > 0, member.status == .working { return "\(base) · \(q) queued" }
        return base
    }

    var body: some View {
        HStack(spacing: 12) {
            ProviderMark(provider: member.provider)
            VStack(alignment: .leading, spacing: 3) {
                Text(member.label ?? "Untitled").font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    StatusDot(state: member.asleep ? .asleep : member.status.dot)
                    Text(words)
                }
                .font(.subheadline).foregroundStyle(.secondary)
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the conversation")
    }

    private var detail: String {
        var parts: [String] = []
        if let project = member.project ?? member.folder { parts.append(project) }
        if let model = member.model { parts.append(model) }
        if member.provider != .codex, let cost = member.cost { parts.append(Format.cost(cost)) }
        if let pct = member.contextPct { parts.append("context \(Format.percent(pct))") }
        return parts.joined(separator: " · ")
    }
}

private struct Figure: View {
    let value: String
    let label: String
    var tint: Color? = nil
    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(.title2.weight(.semibold)).monospacedDigit().foregroundStyle(tint ?? .primary)
                .fixedSize(horizontal: false, vertical: true)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Shared report building blocks (also used by ReportView)

enum ReportKit {
    /// Server times are milliseconds since 1970.
    static func date(_ ms: Double?) -> Date? {
        guard let ms, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
    /// nil means "not reported", which is different from zero.
    static func count(_ n: Int?) -> String { n.map { $0.formatted() } ?? "—" }
    static func humanize(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").capitalized
    }
    static func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file) }
    /// Claude limits older than half an hour are shown "as of".
    static let limitsStaleAfter: TimeInterval = 30 * 60
    static func staleNote(_ state: ReportState, offline: Bool, at now: Date) -> String? {
        let measured = state.report?.generatedAt ?? state.receivedAt
        guard let measured, offline || state.isStale || now.timeIntervalSince(measured) > 30 else { return nil }
        return "Last measured \(measured.formatted(date: .abbreviated, time: .shortened))"
    }
}

/// A label and a value. A missing value reads "Not reported", never zero.
struct ReportRow: View {
    let title: String
    let value: String?
    var detail: String? = nil
    init(_ title: String, _ value: String?, detail: String? = nil) { self.title = title; self.value = value; self.detail = detail }
    var body: some View {
        LabeledContent {
            VStack(alignment: .trailing, spacing: 1) {
                Text(value ?? "Not reported").foregroundStyle(value == nil ? .tertiary : .secondary).monospacedDigit()
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            .multilineTextAlignment(.trailing)
        } label: {
            Text(title)
        }
        .accessibilityElement(children: .combine)
        .background(ReportScrollProbe())
    }
}

/// A section whose header folds it away.
struct CollapsibleSection<Content: View>: View {
    let title: String
    let footer: String?
    @ViewBuilder let content: Content
    private let initiallyExpanded: Bool
    @Environment(NikClient.self) private var client
    @Environment(\.reportConversationID) private var conversationID
    private var state: ReportState { conversationID.map { client.conversation($0).report } ?? client.report }
    private var open: Bool {
        state.disclosuresInitialized ? state.expandedSections.contains(title) : initiallyExpanded
    }
    private func toggle() {
        var sections = state.disclosuresInitialized ? state.expandedSections : ["This instance", "Usage"]
        if open { sections.remove(title) } else { sections.insert(title) }
        client.setReportSections(sections, conversationID: conversationID)
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ title: String, expanded: Bool = true, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
        initiallyExpanded = expanded
    }

    var body: some View {
        Section {
            if open { content }
        } header: {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) { toggle() }
            } label: {
                HStack {
                    Text(title)
                    Spacer()
                    Image(systemName: "chevron.right").rotationEffect(.degrees(open ? 90 : 0)).font(.footnote.weight(.semibold))
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(ReportScrollProbe())
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityHint("Double tap to \(open ? "collapse" : "expand")")
        } footer: {
            if open, let footer { Text(footer) }
        }
    }
}

/// Folds a long table after five rows when there are more than six. Show all keeps every row reachable.
struct FoldedRows<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder let row: (Item) -> Row
    @State private var showAll = false

    private var folds: Bool { items.count > 6 }
    private var visible: [Item] { folds && !showAll ? Array(items.prefix(5)) : items }

    var body: some View {
        ForEach(visible) { row($0) }
        if folds {
            Button(showAll ? "Show fewer" : "Show all \(items.count)") { showAll.toggle() }
        }
    }
}

/// A linear gauge for one usage window, with its reset time.
struct UsageGaugeRow: View {
    let title: String
    let used: Double?
    let resetsAt: Double?
    var stale = false

    private var clamped: Double { min(max(used ?? 0, 0), 1) }
    private var tint: Color { clamped >= 0.9 ? Theme.needsYou : (clamped >= 0.7 ? Theme.working : Theme.done) }
    private var reset: Date? { ReportKit.date(resetsAt) }

    private var resetWords: String? {
        guard let reset else { return nil }
        if reset < .now { return "Reset time has passed" }
        return "Resets \(reset.formatted(.relative(presentation: .named))) · \(reset.formatted(date: .abbreviated, time: .shortened))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Text(used.map(Format.percent) ?? "Unknown").monospacedDigit().foregroundStyle(.secondary)
            }
            if used != nil {
                Gauge(value: clamped) { Text(title) }
                    .gaugeStyle(.linearCapacity)
                    .tint(stale ? Color.secondary : tint)
                    .labelsHidden()
            }
            if let resetWords { Text(resetWords).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(used.map { Format.percent($0) + " used" } ?? "usage unknown")\(stale ? ", last measured" : "")")
        .accessibilityValue(resetWords ?? "")
    }
}

/// Claude plan windows: five hour, week, week overage.
struct ClaudeLimitRows: View {
    let limits: ClaudeLimits
    let offline: Bool

    private var measured: Date? { ReportKit.date(limits.at) }
    private var stale: Bool {
        offline || (measured.map { Date.now.timeIntervalSince($0) > ReportKit.limitsStaleAfter } ?? false)
    }

    var body: some View {
        let windows = limits.windows
        if let five = windows.fiveHour { UsageGaugeRow(title: "5-hour window", used: five.used, resetsAt: five.resetsAt, stale: stale) }
        if let week = windows.week { UsageGaugeRow(title: "Weekly window", used: week.used, resetsAt: week.resetsAt, stale: stale) }
        if let over = windows.weekOverage { UsageGaugeRow(title: "Weekly overage", used: over.used, resetsAt: over.resetsAt, stale: stale) }
        if windows.fiveHour == nil, windows.week == nil, windows.weekOverage == nil {
            if limits.used != nil {
                UsageGaugeRow(title: limits.type.map(ReportKit.humanize) ?? "Current window", used: limits.used, resetsAt: limits.resetsAt, stale: stale)
            } else {
                Text("No usage windows reported").foregroundStyle(.secondary)
            }
        }
        if let status = limits.status, status != "allowed" {
            Label(ReportKit.humanize(status), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.needsYou).font(.footnote)
        }
        if limits.overage == true {
            Label("Using overage", systemImage: "plus.circle").font(.footnote).foregroundStyle(Theme.working)
        }
        if stale, let measured {
            Label("As of \(measured.formatted(date: .omitted, time: .shortened))", systemImage: "clock.arrow.circlepath")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Codex accounts and their windows. An error keeps the older windows but labels them stale.
struct CodexLimitRows: View {
    let accounts: [CodexLimitAccount]
    let offline: Bool

    var body: some View {
        ForEach(accounts) { account in
            let measured = ReportKit.date(account.at)
            let stale = offline || account.error != nil
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name ?? "Codex account").font(.headline)
                let sub = [account.plan, account.email].compactMap { $0 }.joined(separator: " · ")
                if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(.secondary) }
            }
            if let error = account.error {
                Label("Showing older values. \(error)", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(Theme.working)
            }
            if let reached = account.reached {
                Label("Limit reached: \(reached)", systemImage: "exclamationmark.octagon.fill")
                    .font(.footnote).foregroundStyle(Theme.needsYou)
            }
            if account.windows.isEmpty {
                Text("No usage windows reported").foregroundStyle(.secondary)
            }
            ForEach(account.windows) { window in
                UsageGaugeRow(title: window.name.isEmpty ? "Window" : window.name, used: window.used, resetsAt: window.resetsAt, stale: stale)
            }
            if stale, let measured {
                Label("Last measured \(measured.formatted(date: .omitted, time: .shortened))", systemImage: "clock.arrow.circlepath")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

private struct ReportConversationKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    var reportConversationID: String? {
        get { self[ReportConversationKey.self] }
        set { self[ReportConversationKey.self] = newValue }
    }
}

/// Comparable figures from the same fleet snapshot; absent measurements remain unknown.
private struct WorkspaceAnalyticsView: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    private var report: Report? { client.report.report }

    var body: some View {
        List {
            if let report {
                Section {
                    Text("These figures cover the instances included by the laptop. Costs cover Claude only; missing values mean not reported.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let generated = report.generatedAt {
                        Text("Measured \(generated, style: .relative) ago").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Current workspace") {
                    ReportRow("Claude cost", report.fleetTotals.cost.map(Format.cost))
                    ReportRow("Tokens", report.fleetTotals.tokens.map(Format.tokens))
                    ReportRow("Turns", ReportKit.count(report.fleetTotals.turns))
                    ReportRow("Tool calls", ReportKit.count(report.fleetTotals.toolCalls))
                }
                if let lifetime = report.lifetime {
                    Section("Lifetime") {
                        ReportRow("Cost", lifetime.cost.map(Format.cost))
                        ReportRow("Tokens", lifetime.tokens.map(Format.tokens))
                        ReportRow("Turns", ReportKit.count(lifetime.turns))
                        ReportRow("Instances", ReportKit.count(lifetime.instances))
                        ReportRow("Projects", ReportKit.count(lifetime.projects))
                        if let since = ReportKit.date(lifetime.since) { Text("Since \(since.formatted(date: .abbreviated, time: .omitted))").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                if !report.projects.isEmpty {
                    Section("Projects") {
                        FoldedRows(items: report.projects) { project in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(project.project ?? project.path ?? "Unknown").font(.headline)
                                ReportRow("Claude cost", project.cost.map(Format.cost))
                                ReportRow("Tokens", project.tokens.map(Format.tokens))
                                ReportRow("Turns", ReportKit.count(project.turns))
                                ReportRow("Instances", ReportKit.count(project.instances))
                            }
                        }
                    }
                }
                Section("Activity distribution") {
                    let groups = Dictionary(grouping: report.fleet) { $0.asleep ? "Asleep" : $0.status.words }
                    ForEach(groups.keys.sorted(), id: \.self) { status in
                        ReportRow(status, groups[status]?.count.formatted())
                    }
                    ReportRow("Worked", report.fleetTotals.workedMs.map(Format.duration(ms:)))
                    ReportRow("Share of open time working", report.fleetTotals.share.map(Format.percent))
                }
                Section("Across the fleet") {
                    record("Most tokens", report.fleet, value: { $0.tokens.map(Double.init) }, format: { Format.tokens(Int($0)) })
                    record("Most turns", report.fleet, value: { $0.turns.map(Double.init) }, format: { Int($0).formatted() })
                    record("Most time working", report.fleet, value: { $0.workedMs }, format: Format.duration(ms:))
                    record("Highest Claude cost", report.fleet.filter { $0.provider == .claude }, value: { $0.cost }, format: Format.cost)
                    record("Highest context use", report.fleet, value: { $0.contextPct }, format: Format.percent)
                }
                ForEach(Array(report.fleet.enumerated()), id: \.offset) { _, member in
                    Section(member.label ?? member.id ?? "Untitled") {
                        ReportRow("Provider", member.provider.name)
                        ReportRow("Status", member.asleep ? "Asleep" : member.status.words)
                        ReportRow("Tokens", member.tokens.map(Format.tokens))
                        ReportRow("Turns", ReportKit.count(member.turns))
                        ReportRow("Tool calls", ReportKit.count(member.toolCalls))
                        ReportRow("Tool errors", ReportKit.count(member.toolErrors))
                        ReportRow("Worked", member.workedMs.map(Format.duration(ms:)))
                        ReportRow("Average turn", member.avgTurnMs.map(Format.duration(ms:)))
                        ReportRow("Context", member.contextPct.map(Format.percent))
                        ReportRow("Cache hit rate", member.cacheHitRate.map(Format.percent))
                        ReportRow("Claude cost", member.provider == .claude ? member.cost.map(Format.cost) : nil)
                        if let id = member.id { Button("Open conversation") { model.openConversation(id) } }
                    }
                }
            } else { EmptyState(title: "Report unavailable", symbol: "chart.bar.xaxis", message: client.report.trouble) }
        }
        .modifier(ReportScrollMemory(page: "workspace"))
        .navigationTitle("Workspace analytics")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { _ = await model.run(.status) }
    }

    private func record(_ title: String, _ members: [FleetMember], value: (FleetMember) -> Double?, format: (Double) -> String) -> some View {
        let known = members.compactMap { member in value(member).map { (member, $0) } }
        let highest = known.max { $0.1 < $1.1 }
        return ReportRow(title, highest.map { format($0.1) }, detail: highest.map { $0.0.label ?? $0.0.id ?? "Untitled" })
    }
}

private struct ReportViewportKey: EnvironmentKey { static let defaultValue: ReadingViewport? = nil }
private extension EnvironmentValues {
    var reportViewport: ReadingViewport? {
        get { self[ReportViewportKey.self] }
        set { self[ReportViewportKey.self] = newValue }
    }
}
struct ReportScrollProbe: View {
    @Environment(\.reportViewport) private var viewport
    var body: some View {
        if let viewport { ReadingViewportProbe(viewport: viewport).frame(width: 0, height: 0).accessibilityHidden(true) }
    }
}
struct ReportScrollMemory: ViewModifier {
    let page: String
    var conversationID: String? = nil
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var viewport = ReadingViewport()
    func body(content: Content) -> some View {
        content
            .environment(\.reportViewport, viewport)
            .onAppear {
                let model = model, client = client
                let scope = client.pairedConnection?.scope
                let key = "report:" + (conversationID ?? "fleet") + ":" + page
                viewport.remember(offset: model.reading(key).offset) { offset in
                    guard client.pairedConnection?.scope == scope else { return }
                    var reading = model.reading(key); reading.offset = offset
                    model.saveReading(reading, key: key)
                }
            }
    }
}
