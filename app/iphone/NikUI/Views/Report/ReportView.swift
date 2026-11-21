import SwiftUI
import UIKit
import Charts
import NikCore

/// The status report for one conversation: instance, usage, tools, timeline and system facts.
struct ReportView: View {
    var conversationID: String? = nil
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model

    private var state: ReportState { conversationID.map { client.conversation($0).report } ?? client.report }
    private var role: SocketRole { conversationID.map(SocketRole.conversation) ?? .fleet }
    @State private var freshnessDate = Date()
    private var offline: Bool { !(conversationID.map { client.conversation($0).connection } ?? client.connection).isLive && !client.isPreview }

    var body: some View {
        List {
            notice
            if let report = state.report {
                let codex = report.instance.provider == .codex
                instanceSection(report, codex: codex)
                usageSection(report, codex: codex)
                toolsSection(report)
                timelineSection(report, codex: codex)
                systemSection(report)
            } else if state.available && state.trouble == nil {
                Section {
                    ContentUnavailableView {
                        Label("Loading Report", systemImage: "chart.bar.xaxis")
                    } description: {
                        Text("Waiting for the laptop to send this conversation's figures.")
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.insetGrouped)
        .modifier(ReportScrollMemory(page: "details", conversationID: conversationID))
        .navigationTitle(conversationID == nil ? "General details" : "Status")
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.reportConversationID, conversationID)
        .refreshable { await refresh() }
        .task {
            while !Task.isCancelled {
                freshnessDate = .now
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
        .toolbar {
            if let report = state.report {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = ReportText.make(report, note: staleNote)
                        Haptics.success()
                        model.show("Report copied")
                    } label: { Label("Copy Report", systemImage: "doc.on.doc") }
                }
            }
        }
    }

    private var staleNote: String? { ReportKit.staleNote(state, offline: offline, at: freshnessDate) }
    private func refresh() async {
        let revision = state.revision
        if case .notSent = await model.run(.status, on: role) { return }
        let deadline = Date().addingTimeInterval(12)
        while !client.isPreview, Date() < deadline, !Task.isCancelled, state.revision == revision {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
        if !client.isPreview, state.revision == revision { model.show("The laptop did not send a fresh report. Try again.", .warning) }
    }

    // MARK: Notice

    @ViewBuilder private var notice: some View {
        if !state.available || state.trouble != nil || staleNote != nil || state.report != nil {
            Section {
                if !state.available {
                    Label("The laptop could not produce a report for this conversation.", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.needsYou)
                }
                if let trouble = state.trouble {
                    Label(trouble, systemImage: "exclamationmark.circle").foregroundStyle(Theme.needsYou)
                }
                if let note = staleNote {
                    Label(offline ? "Offline. \(note)." : "\(note).", systemImage: "clock.arrow.circlepath").foregroundStyle(.secondary)
                } else if let generated = state.report?.generatedAt {
                    Label("Measured \(generated.formatted(date: .omitted, time: .shortened))", systemImage: "clock").foregroundStyle(.secondary)
                }
                if let window = state.report?.window, let kept = window.kept {
                    Text("Tool, file and message tables cover the \(kept.formatted()) items kept\(window.dropped.map { $0 > 0 ? ", with \($0.formatted()) older ones dropped" : "" } ?? ""). Totals can cover more than the tables.")
                        .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
        }
    }

    // MARK: This instance

    @ViewBuilder private func instanceSection(_ report: Report, codex: Bool) -> some View {
        let instance = report.instance
        let config = report.config
        let totals = report.totals
        CollapsibleSection("This instance") {
            HStack(spacing: 12) {
                ProviderMark(provider: instance.provider)
                VStack(alignment: .leading, spacing: 2) {
                    Text(instance.customTitle ?? instance.label ?? "Untitled").font(.headline)
                    HStack(spacing: 6) {
                        StatusDot(state: instance.asleep ? .asleep : instance.status.dot)
                        Text(instance.asleep ? "Asleep" : (instance.paused ? "Paused for quota" : instance.status.words))
                    }
                    .font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            if let error = instance.lastError {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Theme.needsYou)
            }
            if let until = ReportKit.date(instance.pausedUntil), instance.paused {
                ReportRow("Paused until", until.formatted(date: .omitted, time: .shortened))
            }
            ReportRow("Provider", instance.provider.name)
            ReportRow("Ticket", instance.ticket)
            ReportRow("Folder", instance.folder)
            ReportRow("Model", config.model, detail: (config.requestedModel != nil && config.requestedModel != config.model) ? "Asked for \(config.requestedModel ?? "")" : nil)
            ReportRow("Effort", config.effort)
            if !codex {
                ReportRow("Permission mode", config.permissionMode.map(ReportKit.humanize))
                ReportRow("Output style", config.outputStyle)
                ReportRow("Auto title", config.autoTitle.map { $0 ? "On" : "Off" })
                if !config.extraArgs.isEmpty { ReportRow("Extra arguments", config.extraArgs.joined(separator: " ")) }
            }
            ReportRow("Queue delay", config.queueDelayMs.map(Format.duration(ms:)))

            // Totals
            ReportRow("Cost", codex ? nil : totals.cost.map(Format.cost), detail: codex ? "Codex does not report a cost" : nil)
            ReportRow("Turns", ReportKit.count(totals.turns))
            ReportRow("Tokens", totals.tokens.total.map(Format.tokens))
            ReportRow("Cache hit rate", totals.cacheHitRate.map(Format.percent))
            ContextGaugeRow(totals: totals)
            ReportRow("Worked", totals.workedMs.map(Format.duration(ms:)), detail: totals.focusPct.map { "\(Format.percent($0)) of the time open" })
            ReportRow("Idle", totals.idleMs.map(Format.duration(ms:)))
            ReportRow("Open for", totals.wallMs.map(Format.duration(ms:)))
            ReportRow("Average turn", totals.avgTurnMs.map(Format.duration(ms:)), detail: totals.turnsLogged.map { "Over the last \($0) logged turns" })
            if !codex {
                ReportRow("Average cost per turn", totals.avgCost.map(Format.cost))
                ReportRow("Burn rate", totals.burnPerHour.map { Format.cost($0) + " per hour" })
            }
            ReportRow("Output speed", totals.outputPerSecond.map { $0.formatted(.number.precision(.fractionLength(0))) + " tokens/s" })
            ReportRow("Compactions", ReportKit.count(totals.compactions), detail: ReportKit.date(totals.lastCompactedAt).map { "Last \($0.formatted(date: .omitted, time: .shortened))" })

            if let runway = report.runway {
                ReportRow("Context runway", runway.turnsLeft.map { "about \(Int($0)) turns left" } ?? "Not enough growth to estimate",
                          detail: runway.growthPerTurn.map { "Grows about \(Format.tokens(Int($0))) tokens a turn. An estimate, not server capacity." })
            }
            if let records = report.records { recordRows(records, codex: codex) }
            if let last = report.lastTurn {
                ReportRow("Last turn", last.n.map { "Turn \($0)" },
                          detail: [last.durationMs.map(Format.duration(ms:)), last.tokens.map { Format.tokens($0) + " tokens" }, last.tools.map { "\($0) tools" }].compactMap { $0 }.joined(separator: " · "))
            }
            if instance.provider == .claude {
                // Plan windows come from the same report.
                if let limits = report.limits ?? report.env.limits {
                    ClaudeLimitRows(limits: limits, offline: offline)
                }
            } else if !(report.codexLimits.isEmpty && report.env.codexLimits.isEmpty) {
                CodexLimitRows(accounts: report.codexLimits.isEmpty ? report.env.codexLimits : report.codexLimits, offline: offline)
            }
        }
    }

    @ViewBuilder private func recordRows(_ records: ReportRecords, codex: Bool) -> some View {
        if let r = records.longest { ReportRow("Longest turn", r.durationMs.map(Format.duration(ms:)), detail: r.n.map { "Turn \($0)" }) }
        if !codex, let r = records.costliest { ReportRow("Costliest turn", r.costUsd.map(Format.cost), detail: r.n.map { "Turn \($0)" }) }
        if let r = records.biggest { ReportRow("Largest turn", r.tokens.map { Format.tokens($0) + " tokens" }, detail: r.n.map { "Turn \($0)" }) }
        if let r = records.peakContext { ReportRow("Peak context", r.tokens.map { Format.tokens($0) + " tokens" }, detail: r.n.map { "Turn \($0)" }) }
        if let n = records.busiestTurn { ReportRow("Busiest turn", "Turn \(n)") }
    }

    // MARK: Usage

    @ViewBuilder private func usageSection(_ report: Report, codex: Bool) -> some View {
        let totals = report.totals
        let tokens = totals.tokens
        CollapsibleSection("Usage", footer: "Charts cover the turns still logged, often the last 60.") {
            if let total = tokens.total, total > 0 {
                TokenMixRows(tokens: tokens, total: total)
            } else {
                ReportRow("Tokens", tokens.total.map(Format.tokens))
            }
            let messages = totals.messages
            ReportRow("Prompts", ReportKit.count(messages.user), detail: totals.promptChars.map { "\($0.formatted()) characters" })
            ReportRow("Replies", ReportKit.count(messages.assistant), detail: totals.writtenChars.map { "\($0.formatted()) characters" })
            ReportRow("Thinking blocks", ReportKit.count(messages.thinking), detail: totals.thinkingShare.map { "\(Format.percent($0)) of replies" })
            ReportRow("Images", ReportKit.count(totals.images ?? messages.images))
            ReportRow("Permission requests", ReportKit.count(messages.permission))

            let turns = report.turns
            if !turns.isEmpty {
                StackedTokensChart(turns: turns)
                if codex {
                    Text("Codex does not report a cost, so there is no cost chart for it.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    TurnSeriesChart(title: "Cost per turn", unit: "USD", style: .bar, tint: Theme.claude,
                                    points: turns.compactMap { t in t.n.flatMap { n in t.costUsd.map { .init(n: n, value: $0) } } },
                                    format: { Format.cost($0) })
                    TurnSeriesChart(title: "Cumulative spend", unit: "USD", style: .line, tint: Theme.claude,
                                    points: Self.cumulative(turns),
                                    format: { Format.cost($0) })
                }
                TurnSeriesChart(title: "Output speed per turn", unit: "tokens/s", style: .bar, tint: Theme.unread,
                                points: turns.compactMap { t in
                                    guard let n = t.n, let out = t.output, let ms = t.durationMs, ms > 0 else { return nil }
                                    return .init(n: n, value: Double(out) / (ms / 1000))
                                },
                                format: { $0.formatted(.number.precision(.fractionLength(0))) + " tokens/s" })
            }
        }
    }

    private static func cumulative(_ turns: [ReportTurn]) -> [TurnSeriesChart.Point] {
        var sum = 0.0
        return turns.compactMap { t in
            guard let n = t.n, let cost = t.costUsd else { return nil }
            sum += cost
            return .init(n: n, value: sum)
        }
    }

    // MARK: Tools

    @ViewBuilder private func toolsSection(_ report: Report) -> some View {
        let totals = report.totals
        CollapsibleSection("Tools", expanded: false, footer: "Tables cover only the items still kept in the transcript window.") {
            ReportRow("Tool calls", ReportKit.count(totals.toolCalls), detail: totals.toolsRunning.flatMap { $0 > 0 ? "\($0) running now" : nil })
            ReportRow("Tool errors", ReportKit.count(totals.toolErrors))
            ReportRow("Errors", ReportKit.count(totals.errors))
            ReportRow("Interruptions", ReportKit.count(totals.interrupts))
            ReportRow("Compactions", ReportKit.count(totals.compactions))
            if !report.tools.isEmpty {
                ToolsChart(tools: report.tools)
                FoldedRows(items: report.tools) { tool in
                    LabeledContent(tool.name) {
                        Text("\(tool.calls.map(String.init) ?? "—")\((tool.errors ?? 0) > 0 ? " · \(tool.errors ?? 0) failed" : "")")
                            .foregroundStyle((tool.errors ?? 0) > 0 ? Theme.needsYou : .secondary).monospacedDigit()
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if !report.files.isEmpty {
                Text("Files touched").font(.subheadline.weight(.semibold))
                FoldedRows(items: report.files) { file in
                    LabeledContent {
                        Text(file.count.map(String.init) ?? "—").monospacedDigit()
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(file.name)
                            Text(Format.shortPath(file.file)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if !report.commands.isEmpty {
                Text("Shell commands").font(.subheadline.weight(.semibold))
                FoldedRows(items: report.commands) { command in
                    LabeledContent {
                        Text(command.count.map(String.init) ?? "—").monospacedDigit()
                    } label: {
                        Text(command.cmd).font(.callout.monospaced()).lineLimit(2)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if report.tools.isEmpty && report.files.isEmpty && report.commands.isEmpty {
                Text("No tool activity in the kept window").foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Timeline

    @ViewBuilder private func timelineSection(_ report: Report, codex: Bool) -> some View {
        let turns = report.turns
        CollapsibleSection("Timeline", expanded: false, footer: "Hourly activity uses the laptop's local hours.") {
            if turns.isEmpty {
                Text("No turns logged yet").foregroundStyle(.secondary)
            } else {
                TurnSeriesChart(title: "Turn duration", unit: "seconds", style: .bar, tint: Theme.working,
                                points: turns.compactMap { t in t.n.flatMap { n in t.durationMs.map { .init(n: n, value: $0 / 1000) } } },
                                format: { Format.duration(ms: $0 * 1000) })
                TurnSeriesChart(title: "Context growth", unit: "tokens", style: .line, tint: Theme.unread,
                                points: turns.compactMap { t in t.n.flatMap { n in t.contextTokens.map { .init(n: n, value: Double($0)) } } },
                                format: { Format.tokens(Int($0)) + " tokens" })
            }
            if report.hourly.count == 24 { HourlyChart(counts: report.hourly) }
            if !turns.isEmpty {
                Text("Recent turns").font(.subheadline.weight(.semibold))
                FoldedRows(items: Array(turns.reversed())) { turn in
                    TurnRow(turn: turn, codex: codex)
                }
            }
        }
    }

    // MARK: System

    @ViewBuilder private func systemSection(_ report: Report) -> some View {
        let instance = report.instance
        let env = report.env
        CollapsibleSection("System", expanded: false) {
            ReportRow("Session", instance.claudeSessionId ?? instance.id)
            pathRow("Directory", instance.cwd, report: report)
            if let git = report.git {
                ReportRow("Branch", git.detached ? "Detached" : git.branch, detail: [git.commit.map { String($0.prefix(8)) }, git.worktree ? "worktree" : nil].compactMap { $0 }.joined(separator: " · "))
                pathRow("Repository", git.root, report: report)
            } else {
                ReportRow("Git", "Not a repository")
            }
            ReportRow("Process", instance.pid.map { "pid \($0)" }, detail: instance.running ? nil : "Not running")
            ReportRow("Started", ReportKit.date(instance.startedAt).map { $0.formatted(date: .abbreviated, time: .shortened) })
            ReportRow("Running for", instance.processUpMs.map(Format.duration(ms:)))
            ReportRow("Age", instance.ageMs.map(Format.duration(ms:)))

            let transcript = report.transcript
            pathRow("Transcript", transcript.path ?? env.transcriptPath, report: report,
                      detail: transcript.exists ? [transcript.sizeBytes.map(ReportKit.size), ReportKit.date(transcript.modified).map { "edited \($0.formatted(date: .omitted, time: .shortened))" }].compactMap { $0 }.joined(separator: " · ") : "File not found")
            let queue = report.queue
            ReportRow("Queue", ReportKit.count(queue.length), detail: ReportKit.date(queue.drainAt).map { "Sends \($0.formatted(.relative(presentation: .named)))" })

            ReportRow("Platform", [env.platform, env.arch].compactMap { $0 }.joined(separator: " ").nonEmpty)
            ReportRow("Machine", [env.cpus.map { "\(Int($0)) cores" }, env.memoryGb.map { "\(Int($0)) GB" }].compactMap { $0 }.joined(separator: " · ").nonEmpty)
            ReportRow("Editor", env.vscode)
            ReportRow("Node", env.node)
            ReportRow("Electron", env.electron)
            ReportRow("Extension", env.extension)
            if let awake = env.awake, awake.available {
                ReportRow("Keep awake", awake.on ? (awake.held ? "On, held" : "On, not held") : "Off",
                          detail: awake.lid.flatMap { $0.supported ? "Lid closed: \($0.on ? ($0.held ? "on, held" : "on, not held") : "off")" : nil })
            }
            if let reach = env.reach {
                ReportRow("Connection", reach.sealed == true ? "End-to-end encrypted" : (reach.sealed == nil ? nil : "Not sealed"),
                          detail: reach.appOnly == true ? "Only the NikUI app can connect" : nil)
            }
            if !env.devices.isEmpty {
                Text("Paired devices").font(.subheadline.weight(.semibold))
                FoldedRows(items: env.devices.enumerated().map { IndexedItem(id: $0.offset, value: $0.element) }) { item in
                    DeviceRowView(device: item.value)
                }
            }
            if !env.trail.isEmpty {
                Text("Recent activity on the laptop").font(.subheadline.weight(.semibold))
                FoldedRows(items: env.trail.enumerated().map { IndexedItem(id: $0.offset, value: $0.element) }) { item in
                    TrailRow(entry: item.value)
                }
            }
        }
    }
    @ViewBuilder private func pathRow(_ title: String, _ path: String?, report: Report, detail: String? = nil) -> some View {
        if let path, !path.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ReportRow(title, Format.shortPath(path, home: report.env.home), detail: detail)
                HStack {
                    Button("Copy path") { UIPasteboard.general.string = path }
                    if let id = conversationID ?? report.instance.id {
                        Button("Open on laptop") {
                            guard client.mayControl else { return }
                            Task { await model.openReportPath(path, conversationID: id) }
                        }.disabled(!client.mayControl)
                    }
                }.font(.footnote).buttonStyle(.bordered).controlSize(.large)
            }
        } else { ReportRow(title, nil, detail: detail) }
    }

}

private struct IndexedItem<Value>: Identifiable {
    let id: Int
    let value: Value
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Rows

private struct ContextGaugeRow: View {
    let totals: ReportTotals
    var body: some View {
        if let pct = totals.contextPct {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Context")
                    Spacer()
                    Text(Format.percent(pct)).monospacedDigit().foregroundStyle(.secondary)
                }
                Gauge(value: min(max(pct, 0), 1)) { Text("Context") }
                    .gaugeStyle(.linearCapacity)
                    .tint(pct >= 0.9 ? Theme.needsYou : (pct >= 0.7 ? Theme.working : Theme.done))
                    .labelsHidden()
                if let tokens = totals.contextTokens, let window = totals.contextWindow {
                    Text("\(Format.tokens(tokens)) of \(Format.tokens(window)) tokens in the current prompt")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Context window \(Format.percent(pct)) full")
        } else {
            ReportRow("Context", nil)
        }
    }
}

private struct TokenMixRows: View {
    let tokens: TokenTotals
    let total: Int

    var body: some View {
        mixRow("Cache read", tokens.cacheRead)
        mixRow("Cache write", tokens.cacheCreate)
        mixRow("Fresh input", tokens.input)
        mixRow("Output", tokens.output)
    }

    private func mixRow(_ title: String, _ value: Int?) -> some View {
        ReportRow(title, value.map(Format.tokens), detail: value.map { Format.percent(Double($0) / Double(total)) + " of tokens" })
    }
}

private struct TurnRow: View {
    let turn: ReportTurn
    let codex: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("Turn \(turn.n.map(String.init) ?? "?")").font(.body)
                if turn.interrupted { Label("Interrupted", systemImage: "hand.raised.fill").labelStyle(.iconOnly).foregroundStyle(Theme.working) }
                if turn.isError { Label("Error", systemImage: "exclamationmark.triangle.fill").labelStyle(.iconOnly).foregroundStyle(Theme.needsYou) }
                Spacer()
                if let at = ReportKit.date(turn.at) { Text(at.formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
            }
            Text([
                turn.durationMs.map(Format.duration(ms:)),
                turn.tokens.map { Format.tokens($0) + " tokens" },
                turn.tools.map { "\($0) tools" },
                codex ? nil : turn.costUsd.map(Format.cost),
            ].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
            if !turn.toolNames.isEmpty {
                Text(turn.toolNames.joined(separator: ", ")).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct DeviceRowView: View {
    let device: ReportDevice
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(device.name).font(.body)
            Text([
                device.control ? "Can control" : "Watch only",
                device.biometric ? "Biometric" : nil,
                (device.reach?.push == true) ? "Push" : nil,
                device.lastSeenAt.map { "Seen \($0.formatted(.relative(presentation: .named)))" },
            ].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct TrailRow: View {
    let entry: TrailEntry
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: entry.allowed ? "checkmark.circle" : "xmark.octagon.fill")
                .foregroundStyle(entry.allowed ? Theme.done : Theme.needsYou)
                .accessibilityLabel(entry.allowed ? "Allowed" : "Refused")
            VStack(alignment: .leading, spacing: 1) {
                Text("\(entry.device ?? "Device") · \(entry.action ?? "action")").font(.subheadline)
                if let detail = entry.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                if let at = entry.at { Text(at.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.tertiary) }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Charts

/// One value per turn, as bars or a line. Touch and hold, then drag, to read a turn.
private struct TurnSeriesChart: View {
    enum Style { case bar, line }
    struct Point: Identifiable { let n: Int; let value: Double; var id: Int { n } }

    let title: String
    let unit: String
    let style: Style
    let tint: Color
    let points: [Point]
    let format: (Double) -> String
    @State private var selection: Int?

    private var selected: Point? { selection.flatMap { s in points.min { abs($0.n - s) < abs($1.n - s) } } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            Text(selected.map { "Turn \($0.n): \(format($0.value))" } ?? summary)
                .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            Chart {
                ForEach(points) { p in
                    switch style {
                    case .bar:
                        BarMark(x: .value("Turn", p.n), y: .value(unit, p.value))
                            .foregroundStyle(tint)
                            .accessibilityLabel("Turn \(p.n)")
                            .accessibilityValue(format(p.value))
                    case .line:
                        LineMark(x: .value("Turn", p.n), y: .value(unit, p.value))
                            .foregroundStyle(tint)
                            .accessibilityLabel("Turn \(p.n)")
                            .accessibilityValue(format(p.value))
                        PointMark(x: .value("Turn", p.n), y: .value(unit, p.value))
                            .foregroundStyle(tint)
                            .symbolSize(points.count > 20 ? 0 : 24)
                            .accessibilityHidden(true)
                    }
                }
                if let selected {
                    RuleMark(x: .value("Turn", selected.n)).foregroundStyle(Color.secondary.opacity(0.5))
                }
            }
            .chartXSelection(value: $selection)
            .chartXAxisLabel("Turn")
            .chartYAxisLabel(unit)
            .frame(height: 160)
        }
        .padding(.vertical, 4)
    }

    private var summary: String {
        guard let first = points.first, let last = points.last else { return "No data" }
        let peak = points.max { $0.value < $1.value } ?? last
        return "\(points.count) turns. Latest \(format(last.value)); highest \(format(peak.value)) at turn \(peak.n)."
            + (points.count > 1 && first.n != last.n ? "" : "")
    }
}

/// Tokens per turn, stacked by kind.
private struct StackedTokensChart: View {
    let turns: [ReportTurn]
    @State private var selection: Int?

    private struct Slice: Identifiable { let n: Int; let kind: String; let value: Int; var id: String { "\(n)-\(kind)" } }

    private var slices: [Slice] {
        turns.flatMap { t -> [Slice] in
            guard let n = t.n else { return [] }
            return [
                Slice(n: n, kind: "Cache read", value: t.cacheRead ?? 0),
                Slice(n: n, kind: "Cache write", value: t.cacheCreate ?? 0),
                Slice(n: n, kind: "Fresh input", value: t.input ?? 0),
                Slice(n: n, kind: "Output", value: t.output ?? 0),
            ]
        }
    }

    private var selectedTurn: ReportTurn? {
        guard let s = selection else { return nil }
        return turns.min { abs(($0.n ?? 0) - s) < abs(($1.n ?? 0) - s) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Tokens per turn").font(.subheadline.weight(.semibold))
            Text(selectedTurn.map { t in
                "Turn \(t.n ?? 0): \(Format.tokens(t.tokens ?? 0)) tokens. Read \(Format.tokens(t.cacheRead ?? 0)), write \(Format.tokens(t.cacheCreate ?? 0)), input \(Format.tokens(t.input ?? 0)), output \(Format.tokens(t.output ?? 0))."
            } ?? "Touch and hold the chart to read a turn.")
                .font(.caption).foregroundStyle(.secondary)
            Chart {
                ForEach(slices) { s in
                    BarMark(x: .value("Turn", s.n), y: .value("Tokens", s.value))
                        .foregroundStyle(by: .value("Kind", s.kind))
                        .accessibilityLabel("Turn \(s.n), \(s.kind)")
                        .accessibilityValue("\(s.value.formatted()) tokens")
                }
                if let t = selectedTurn, let n = t.n {
                    RuleMark(x: .value("Turn", n)).foregroundStyle(Color.secondary.opacity(0.5))
                }
            }
            .chartForegroundStyleScale([
                "Cache read": Theme.done,
                "Cache write": Theme.working,
                "Fresh input": Theme.unread,
                "Output": Theme.claude,
            ])
            .chartXSelection(value: $selection)
            .chartXAxisLabel("Turn")
            .chartYAxisLabel("Tokens")
            .frame(height: 180)
        }
        .padding(.vertical, 4)
    }
}

/// Tool calls by tool, with failures called out.
private struct ToolsChart: View {
    let tools: [ToolCount]

    var body: some View {
        let top = Array(tools.sorted { ($0.calls ?? 0) > ($1.calls ?? 0) }.prefix(8))
        VStack(alignment: .leading, spacing: 6) {
            Text("Calls by tool").font(.subheadline.weight(.semibold))
            Chart(top) { tool in
                BarMark(x: .value("Calls", tool.calls ?? 0), y: .value("Tool", tool.name))
                    .foregroundStyle((tool.errors ?? 0) > 0 ? Theme.working : Theme.unread)
                    .accessibilityLabel(tool.name)
                    .accessibilityValue("\(tool.calls ?? 0) calls, \(tool.errors ?? 0) failed")
            }
            .chartXAxisLabel("Calls")
            .frame(height: CGFloat(top.count) * 28 + 36)
        }
        .padding(.vertical, 4)
    }
}

/// Activity by hour of the day on the laptop.
private struct HourlyChart: View {
    let counts: [Double]
    @State private var selection: Int?

    private struct Bucket: Identifiable { let hour: Int; let count: Double; var id: Int { hour } }
    private var buckets: [Bucket] { counts.enumerated().map { Bucket(hour: $0.offset, count: $0.element) } }

    private func label(_ hour: Int) -> String {
        let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: .now) ?? .now
        return date.formatted(.dateTime.hour())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Activity by hour").font(.subheadline.weight(.semibold))
            Text(selection.flatMap { s in buckets.first { $0.hour == s } }.map { "\(label($0.hour)): \(Int($0.count)) turns" }
                 ?? "Touch and hold the chart to read an hour.")
                .font(.caption).foregroundStyle(.secondary)
            Chart(buckets) { b in
                BarMark(x: .value("Hour", b.hour), y: .value("Turns", b.count))
                    .foregroundStyle(Theme.working)
                    .accessibilityLabel(label(b.hour))
                    .accessibilityValue("\(Int(b.count)) turns")
            }
            .chartXSelection(value: $selection)
            .chartXScale(domain: -0.5...23.5)
            .chartXAxis {
                AxisMarks(values: [0, 6, 12, 18]) { value in
                    AxisGridLine()
                    AxisValueLabel { if let h = value.as(Int.self) { Text(label(h)) } }
                }
            }
            .chartXAxisLabel("Hour of day")
            .chartYAxisLabel("Turns")
            .frame(height: 140)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Plain-text report

/// A coherent plain-text report for the pasteboard (shared with the Status tab).
enum ReportText {
    static func make(_ report: Report, note: String?) -> String {
        let instance = report.instance
        let config = report.config
        let totals = report.totals
        let codex = instance.provider == .codex
        var lines: [String] = []
        lines.append("NikUI status report")
        if let generated = report.generatedAt { lines.append("Generated: \(generated.formatted(date: .abbreviated, time: .standard))") }
        if let note { lines.append(note) }
        lines.append("")
        lines.append("Instance: \(instance.customTitle ?? instance.label ?? "Untitled") (\(instance.provider.name))")
        lines.append("Status: \(instance.asleep ? "Asleep" : instance.status.words)\(instance.paused ? ", paused for quota" : "")")
        if let cwd = instance.cwd { lines.append("Directory: \(cwd)") }
        if let git = report.git { lines.append("Branch: \(git.detached ? "detached" : (git.branch ?? "unknown"))\(git.commit.map { " @ \($0.prefix(8))" } ?? "")") }
        if let model = config.model { lines.append("Model: \(model)\(config.effort.map { " (\($0) effort)" } ?? "")") }
        if let session = instance.claudeSessionId ?? instance.id { lines.append("Session: \(session)") }
        lines.append("")
        lines.append("Cost: \(codex ? "not reported by Codex" : totals.cost.map(Format.cost) ?? "not reported")")
        lines.append("Turns: \(ReportKit.count(totals.turns))")
        lines.append("Average turn: \(totals.avgTurnMs.map(Format.duration(ms:)) ?? "not reported")")
        lines.append("Tokens: \(totals.tokens.total.map(Format.tokens) ?? "not reported")")
        lines.append("Cache hit rate: \(totals.cacheHitRate.map(Format.percent) ?? "not reported")")
        if let pct = totals.contextPct { lines.append("Context: \(Format.percent(pct))\(totals.contextTokens.map { " (\(Format.tokens($0)) tokens)" } ?? "")") }
        lines.append("Compactions: \(ReportKit.count(totals.compactions))")
        if let limits = report.limits ?? report.env.limits {
            let w = limits.windows
            if let f = w.fiveHour { lines.append("Claude 5-hour usage: \(f.used.map(Format.percent) ?? "unknown")") }
            if let k = w.week { lines.append("Claude weekly usage: \(k.used.map(Format.percent) ?? "unknown")") }
            if let at = ReportKit.date(limits.at) { lines.append("Claude limits measured: \(at.formatted(date: .omitted, time: .shortened))") }
        }
        for account in (report.codexLimits.isEmpty ? report.env.codexLimits : report.codexLimits) {
            for window in account.windows {
                lines.append("Codex \(account.name ?? "account") \(window.name): \(window.used.map(Format.percent) ?? "unknown")\(account.error != nil ? " (stale)" : "")")
            }
        }
        if !report.tools.isEmpty {
            lines.append("")
            lines.append("Tools: " + report.tools.prefix(10).map { "\($0.name) \($0.calls ?? 0)" }.joined(separator: ", "))
        }
        if !report.files.isEmpty {
            lines.append("Files: " + report.files.prefix(10).map { "\($0.name) \($0.count ?? 0)" }.joined(separator: ", "))
        }
        if let kept = report.window.kept {
            lines.append("Tables cover \(kept) kept items; totals can cover more.")
        }
        return lines.joined(separator: "\n")
    }
}
