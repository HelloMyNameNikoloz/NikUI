import Testing
import NikCore
@testable import NikMacCore

struct CutoverBlockerTextTests {
    @Test func namedChatAndRouteDiagnosticsReachTheMoveSheet() {
        let review: JSONValue = .object(["sources": .array([.object(["blockerDetails": .array([
            .object(["code": .string("KEEPER_LEGACY_UNPROVEN"), "message": .string("Finish or stop these 2 running chats: Research, Deploy, then Refresh.")]),
            .object(["code": .string("ROUTE_OWNER_MISMATCH"), "message": .string("https://laptop.ts.net/ changed from port 4517 to port 8888. Restore it, then Refresh.")])
        ])])])])
        #expect(CutoverBlockerText.message("KEEPER_LEGACY_UNPROVEN", review: review).contains("Research, Deploy"))
        #expect(CutoverBlockerText.message("ROUTE_OWNER_MISMATCH", review: review).contains("https://laptop.ts.net/"))
    }
    @Test(arguments: ["KEEPER_METADATA_INCOMPLETE", "KEEPER_PROCESS_CHANGED", "CLOUDFLARED_URL_CONTINUITY_UNAVAILABLE",
        "SOURCE_MANIFEST_INCOMPLETE", "SOURCE_UNRESPONSIVE", "PENDING_APPROVAL", "CLAUDE_OWNED_BUSY", "CODEX_OWNED_BUSY",
        "BORROWED_CODEX_BUSY", "VOICE_BUSY", "TERMINAL_BUSY", "LID_CONTINUITY_UNPROVEN", "ROUTE_OWNER_MISMATCH", "KEYCHAIN_LOCKED",
        "EXPORT_INCOMPLETE", "IMPORT_HASH_MISMATCH", "OWNER_TRANSITION_PENDING", "SERVICE_REQUIRES_APPROVAL", "UNSAFE_OPERATION_PENDING",
        "OUTCOME_UNKNOWN", "SOURCE_OPERATION_UNAVAILABLE", "QUIESCENCE_INCOMPLETE", "WRITER_FENCED", "RESOURCE_RELEASE_UNPROVEN", "UNSAFE_UPDATE"])
    func knownBlockersHaveSpecificActions(_ code: String) {
        let value = CutoverBlockerText.message(code, review: .null)
        #expect(!value.contains("Resolve the named"))
        #expect(value.count > 40)
        #expect(!value.contains("profile’s failure details"))
    }
    @Test func restoreBusyNamesTheEngine() {
        let value = CutoverBlockerText.message("CLAUDE_OWNED_BUSY", review: .object(["returning": .bool(true)]))
        #expect(value.contains("NikUI engine"))
        #expect(!value.contains("selected VS Code"))
    }
}
