import SwiftUI

struct MacWindowActions {
    var find: () -> Void
    var next: () -> Void
    var previous: () -> Void
}
private struct MacWindowActionsKey: FocusedValueKey { typealias Value = MacWindowActions }
extension FocusedValues {
    var nikWindowActions: MacWindowActions? {
        get { self[MacWindowActionsKey.self] }
        set { self[MacWindowActionsKey.self] = newValue }
    }
}
struct MacWindowCommands: Commands {
    @FocusedValue(\.nikWindowActions) private var actions
    var body: some Commands {
        CommandGroup(after: .textEditing) {
            Divider()
            Button("Find in Transcript…") { actions?.find() }.keyboardShortcut("f").disabled(actions == nil)
            Button("Find Next") { actions?.next() }.keyboardShortcut("g").disabled(actions == nil)
            Button("Find Previous") { actions?.previous() }.keyboardShortcut("g", modifiers: [.command, .shift]).disabled(actions == nil)
        }
    }
}
