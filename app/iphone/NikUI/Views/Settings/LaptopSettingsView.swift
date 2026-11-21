import SwiftUI
import NikCore

/// NikUI's settings on the laptop, as the laptop describes them.
struct LaptopSettingsView: View {
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client

    private var snapshot: SettingsSnapshot { client.conversation(conversationID).settings }
    private var mayChange: Bool { snapshot.mayChange && client.mayControlConversation(conversationID) }

    var body: some View {
        Form {
            if let catalog = snapshot.settings {
                ForEach(groups(catalog), id: \.self) { group in
                    Section(group) {
                        ForEach(catalog.rows.filter { $0.group == group }) { row in
                            SettingRowView(row: row, mayChange: mayChange) { value in set(row, value) }
                        }
                    }
                }
            }
            if let refused = snapshot.refused {
                Section { Label(refused, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.needsYou) }
            }
            if !mayChange, snapshot.settings != nil {
                Section { Text("Changing settings needs a live chat connection and control from the laptop.").foregroundStyle(.secondary) }
            }
        }
        .overlay { if snapshot.settings == nil { ProgressView("Asking the laptop…") } }
        .navigationTitle("Laptop settings")
        .refreshable { _ = await client.perform(.settings, on: .conversation(conversationID)) }
    }

    private func groups(_ catalog: SettingsCatalog) -> [String] {
        let named = catalog.groups.filter { group in catalog.rows.contains { $0.group == group } }
        let extra = Set(catalog.rows.map(\.group)).subtracting(named).sorted()
        return named + extra
    }

    private func set(_ row: SettingRow, _ value: JSONValue) {
        // Power settings going off may put the laptop out of reach: the shared coordinator asks first.
        if value.boolValue == false, row.id == "awake" || row.id == "lid" {
            model.requestPowerChange(.setSetting(id: row.id, value: value), on: .conversation(conversationID))
            return
        }
        Task {
            let result = await model.run(.setSetting(id: row.id, value: value), on: .conversation(conversationID))
            if case .notSent = result { return }
            Haptics.selection()
        }
    }
}

private struct SettingRowView: View {
    let row: SettingRow
    let mayChange: Bool
    let set: (JSONValue) -> Void
    @State private var text = ""
    @State private var number: Double = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            control
            if !row.hint.isEmpty { Text(row.hint).font(.footnote).foregroundStyle(.secondary) }
            if let note = row.note { Text(note).font(.footnote).foregroundStyle(row.warn ? Theme.working : .secondary) }
            if let unavailable = row.unavailable { Text(unavailable).font(.footnote).foregroundStyle(.secondary) }
        }
        .disabled(!mayChange || row.unavailable != nil)
    }

    @ViewBuilder private var control: some View {
        switch row.kind {
        case "bool", "toggle", "boolean":
            Toggle(row.label, isOn: Binding(get: { row.value.boolValue ?? false }, set: { set(.bool($0)) }))
        case "choice", "select", "enum":
            Picker(row.label, selection: Binding(get: { choiceValue }, set: { set(.string($0)) })) {
                ForEach(row.choices) { Text($0.label).tag($0.value) }
            }
        case "model":
            if row.choices.isEmpty {
                LabeledContent(row.label, value: choiceValue.isEmpty ? "Default" : choiceValue)
                Text("The laptop did not offer a list of models. Pull down to ask again.").font(.footnote).foregroundStyle(.secondary)
            } else {
                Picker(row.label, selection: Binding(get: { choiceValue }, set: { set(.string($0)) })) {
                    if !row.choices.contains(where: { $0.value.isEmpty }) { Text("Default").tag("") }
                    ForEach(row.choices) { Text($0.label).tag($0.value) }
                }
            }
        case "number", "int", "integer":
            Stepper(value: Binding(get: { row.value.doubleValue ?? 0 }, set: { set(.number($0)) }),
                    in: (row.min ?? 0)...(row.max ?? 1_000_000)) {
                LabeledContent(row.label, value: (row.value.doubleValue ?? 0).formatted())
            }
        case "text", "string":
            LabeledContent(row.label) {
                TextField(row.label, text: $text)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit { set(.string(text)) }
                    .onAppear { text = row.value.stringValue ?? "" }
                    .onChange(of: row.value) { _, value in text = value.stringValue ?? "" }
            }
        default:
            LabeledContent(row.label, value: row.value.stringValue ?? row.value.text)
        }
    }

    private var choiceValue: String {
        if let string = row.value.stringValue { return string }
        if let bool = row.value.boolValue { return bool ? "true" : "false" }
        if let number = row.value.doubleValue { return number.formatted() }
        return ""
    }
}
