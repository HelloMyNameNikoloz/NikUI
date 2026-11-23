import Foundation
import NikCore

public enum CutoverBlockerText {
    public static func message(_ code: String, review: JSONValue) -> String {
        let details = review["blockerDetails"].arrayValue + review["sources"].arrayValue.flatMap { $0["blockerDetails"].arrayValue }
        let messages = details.filter { $0["code"].stringValue == code }.compactMap { $0["message"].stringValue }
        if !messages.isEmpty { return Array(Set(messages)).sorted().joined(separator: "\n") }
        let windows = review["sources"].arrayValue.compactMap { $0["workspace"].stringValue }.joined(separator: ", ")
        let source = review["returning"].boolValue == true ? "the NikUI engine" : windows.isEmpty ? "the selected VS Code windows" : windows
        switch code {
        case "SERVICE_BUNDLE_MISMATCH": return "Another NikUI copy owns the engine registration. Quit the other copy and retry from the registered app."
        case "INSTALL_IN_APPLICATIONS_REQUIRED": return "Install NikUI in Applications before moving your work."
        case "SOURCE_SELECTION_REQUIRED": return "Choose the editor profile to move."
        case "SOURCE_HANDSHAKE_UNAVAILABLE": return "Open a NikUI source window with the current handoff bridge, then Refresh."
        case "SOURCE_BUILD_OLD": return "Reload \(source) with the current NikUI extension, then Refresh."
        case "SOURCE_RELOADING": return "Wait for \(source) to finish reloading, then Refresh."
        case "SOURCE_MANIFEST_INCOMPLETE", "SOURCE_UNRESPONSIVE": return "NikUI could not account for every source window in \(source). Reload those windows, then Refresh."
        case "SOURCE_SELECTION_CHANGED", "OTHER_SCOPE_UNFENCED": return "The open editor profiles changed. Close the other profile’s NikUI windows and select the intended profile again."
        case "OWNER_TRANSITION_PENDING", "CUTOVER_RECOVERY_REQUIRED", "SOURCE_FENCE_MISSING": return "A previous Move has not finished. Choose Restore VS Code to recover its current work before trying Move again."
        case "PORT_IN_USE": return review["listener"]["holders"].arrayValue.isEmpty
            ? "Couldn’t identify the port holder. Select Refresh to try again."
            : "Close the process listed for the selected port, or choose another NikUI port in VS Code, then Refresh."
        case "PORT_INVALID": return "Set NikUI’s remote.port in VS Code to a number from 0 through 65535, then Refresh."
        case "PENDING_FOLDER_RETURNS": return "Open the listed folders in VS Code to restore their saved work, then Refresh."
        case "PENDING_APPROVAL": return "Answer the pending approval in the listed chat in VS Code, then Refresh."
        case "CLAUDE_OWNED_BUSY": return "Finish or stop the active Claude turns in \(source), then Refresh. A direct process cannot move between owners."
        case "CODEX_OWNED_BUSY", "BORROWED_CODEX_BUSY", "CODEX_EXTERNAL_BUSY": return "Finish or stop the active Codex turns in \(source), then Refresh. The running Codex process must stay with its current owner."
        case "TERMINAL_BUSY": return "Close the active terminals in \(source), then Refresh."
        case "VOICE_BUSY": return "Finish the voice recording or voice helper build in \(source), then Refresh."
        case "LID_CONTINUITY_UNPROVEN", "POLICY_RELEASE_UNPROVEN", "POWER_RELEASE_UNPROVEN": return "Turn off Keep working with the lid closed in \(source), wait for the assertion to release, then Refresh."
        case "ROUTE_OWNER_MISMATCH": return "In the VS Code window that owns the phone route, run NikUI: Record this window’s phone route (nikui.recordPhoneRoute), then Refresh. This reads Tailscale status and saves the exact handler."
        case "CLOUDFLARED_URL_CONTINUITY_UNAVAILABLE": return "Close the public cloudflared tunnel in VS Code, use tailnet phone access if needed, then Refresh. A public tunnel cannot retain its generated address across Move."
        case "SERVICE_REQUIRES_APPROVAL": return "Allow NikUI’s background engine in System Settings → General → Login Items, then retry Move."
        case "ENGINE_PREFLIGHT_FAILED": return "NikUI’s bundled engine could not start its readiness check. Reinstall the current NikUI app, then retry Move. Your work remains in VS Code."
        case "SERVICE_UNAVAILABLE", "SIGNED_ENGINE_UNAVAILABLE": return "Open Settings → Engine Status to inspect NikUI’s installed background engine. Retry Start, or choose Restore VS Code if Move already began."
        case "SERVICE_OWNERSHIP_REQUIRED": return "NikUI must own this selected profile before it can return it. Refresh the selected profile’s engine status."
        case "SOURCE_RETURN_TARGET_REQUIRED": return "Open a NikUI editor window to finish restoring shared settings and credentials."
        case "CURRENT_STATE_EXPORT_REQUIRED", "AUTHORITY_UNAVAILABLE", "STORAGE_UNAVAILABLE": return "The current engine state could not be read. Inspect Settings → Engine Status and retry Restore VS Code after storage is available. Keep the current profile’s files."
        case "OUTCOME_UNKNOWN", "UNSAFE_OPERATION_PENDING", "UNSAFE_UPDATE_UNKNOWN", "UNSAFE_UPDATE": return "The engine has work with an unresolved delivery outcome. Reconnect its chat and resolve that input before retrying."
        case "SOURCE_OPERATION_UNAVAILABLE": return "Reload the selected VS Code window with the current NikUI extension, then retry this action."
        case "QUIESCENCE_INCOMPLETE": return "The current writer has not finished saving and releasing its work. Wait for active work to settle, then retry; Restore VS Code can recover an interrupted Move."
        case "WRITER_FENCED": return "The current writer is paused for an ownership transfer. Choose Restore VS Code to finish recovery before sending again."
        case "RESOURCE_RELEASE_UNPROVEN": return "The current writer has not confirmed release of its listener or presentation resources. Refresh its status and retry Restore VS Code."
        case "PROVIDER_DISPATCH_ACTIVE": return "An input is currently being dispatched. Wait for its delivery result, then Refresh."
        case "CUTOVER_TIMEOUT", "CUTOVER_CANCELLED": return "Refresh engine status, or choose Restore VS Code to return the current work from the interrupted Move."
        case "IDENTITY_UNAVAILABLE", "EXPORT_IDENTITY_CONFLICT": return "The selected windows do not provide one readable host identity. Reopen the intended editor profile and restore access to its saved credentials, then Refresh."
        default:
            if code.hasPrefix("KEEPER_RESCUE_SUPERVISION_") { return "Legacy chat custody needs repair (\(code)). Keep the current chat owner open, repair NikUI or its private custody files, then choose Retry Custody. The existing runs and their recovery proofs are retained." }
            if code.hasPrefix("KEEPER_") { return "Keeper continuity could not be proved in \(source) (\(code)). Stop the affected running chats with their current owner, then Refresh." }
            if code.hasPrefix("KEYCHAIN_") { return "The selected profile’s login Keychain is unavailable (\(code)). Unlock it or allow NikUI’s credential access, then retry." }
            if code.hasPrefix("EXPORT_") || code.hasPrefix("IMPORT_") { return "The selected profile’s current data failed verification (\(code)). Reload \(source), then Refresh; use Restore VS Code if Move already began. Saved work is retained." }
            if code.hasPrefix("RESTORE_") || code.hasPrefix("RETURN_") { return "A saved return needs attention (\(code)). Open the affected folder in VS Code and use its NikUI recovery panel to import the retained work."
            }
            return "\(code): Open Settings → Engine Status for this profile’s failure details, then retry the interrupted action."
        }
    }
}
