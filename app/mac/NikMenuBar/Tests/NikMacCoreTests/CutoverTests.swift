import Foundation
import Testing
import NikCore
import NikMacIdentity
@testable import NikMacCore

private actor CutoverTrace {
    var events: [String] = []
    func add(_ value: String) { events.append(value) }
    func values() -> [String] { events }
}
private actor TestCutoverBackend: CutoverBackend {
    let trace: CutoverTrace
    let responses: [String: JSONValue]
    init(_ trace: CutoverTrace, responses: [String: JSONValue] = [:]) { self.trace = trace; self.responses = responses }
    func command(_ action: String, arguments: JSONValue) async -> JSONValue {
        await trace.add(action)
        if let response = responses[action] { return response }
        if action == "review" { return .object(["ok": .bool(true), "ready": .bool(true), "blockers": .array([]),
            "profile": .string("chosen-profile"), "token": .string("review-hash")]) }
        return .object(["ok": .bool(true)])
    }
}
@MainActor private final class TestCutoverService: CutoverService {
    let trace: CutoverTrace
    var approval = false
    var preflightFailure = false
    init(_ trace: CutoverTrace) { self.trace = trace }
    func registerForCutover() async throws { await trace.add("register"); if approval { throw IdentityFailure("SERVICE_REQUIRES_APPROVAL") } }
    func preflightForCutover() async throws { await trace.add("preflight"); if preflightFailure { throw IdentityFailure("ENGINE_PREFLIGHT_FAILED", diagnostics: ["exitStatus": "42", "output": "preflight failure"]) } }
    func start() async { await trace.add("start") }
    func stop() async { await trace.add("stop") }
    func unregisterAfterHandback() async { await trace.add("unregister") }
}
@Suite("Attended Mac cutover actions") @MainActor struct CutoverTests {
    @Test func custodyRetryIsExplicitAndDoesNotRegisterTheEngine() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let backend = TestCutoverBackend(trace, responses: ["review": .object(["ok": .bool(true), "ready": .bool(false),
            "profile": .string("chosen-profile"), "blockers": .array([.string("KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING")])])])
        let coordinator = MacCutoverCoordinator(backend: backend, service: service, installed: true)
        await coordinator.refresh(); await coordinator.refresh()
        #expect(await trace.values() == ["review", "review"])
        #expect(!coordinator.mayMove && coordinator.blockers == ["KEEPER_RESCUE_SUPERVISION_PROGRAM_MISSING"])
        await coordinator.retryCustody()
        #expect(await trace.values() == ["review", "review", "repair-custody", "review"])
        #expect(CutoverBlockerText.message(coordinator.blockers[0], review: .null).contains("Retry Custody"))
    }
    @Test func recordPhoneRouteUsesTheSelectedBridgeWithoutRegisteringAnEngine() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true)
        await coordinator.refresh(); await coordinator.recordPhoneRoute(sourceID: "source-window")
        #expect(await trace.values() == ["review", "record-phone-route", "review"])
        #expect(coordinator.problem == nil)
    }
    @Test func portBlockerDisablesMoveBeforeRegistration() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let backend = TestCutoverBackend(trace, responses: ["review": .object(["ok": .bool(true), "ready": .bool(false),
            "profile": .string("chosen-profile"), "token": .string("review-hash"), "blockers": .array([.string("PORT_IN_USE")])])])
        let coordinator = MacCutoverCoordinator(backend: backend, service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { await trace.add("enroll") }
        #expect(!coordinator.mayMove && coordinator.blockers == ["PORT_IN_USE"])
        #expect(await trace.values() == ["review"])
    }
    @Test func moveAndRestoreFailuresBothRemainVisible() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let backend = TestCutoverBackend(trace, responses: [
            "move": .object(["ok": .bool(false), "code": .string("SOURCE_MANIFEST_INCOMPLETE"),
                "diagnostics": .object(["recovery": .object(["code": .string("SOURCE_RETURN_TARGET_REQUIRED")])])]),
            "cancel": .object(["ok": .bool(true), "legacy": .bool(false)])])
        let coordinator = MacCutoverCoordinator(backend: backend, service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { await trace.add("enroll") }
        #expect(coordinator.stage == "recovery required")
        #expect(coordinator.problem == "SOURCE_MANIFEST_INCOMPLETE")
        #expect(coordinator.recoveryProblem == "SOURCE_RETURN_TARGET_REQUIRED")
    }
    @Test func reviewAndClosingHaveNoRegistrationOrEnrollmentEffects() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true)
        #expect(await trace.values().isEmpty)
        await coordinator.refresh()
        #expect(await trace.values() == ["review"])
        #expect(coordinator.mayMove)
    }
    @Test func clickValidatesIdleEngineBeforeCommittingThenStartsEnrollsAndSwitches() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { await trace.add("enroll") }
        #expect(await trace.values() == ["review", "register", "preflight", "move", "start", "enroll", "finish"])
        #expect(coordinator.stage == "ready" && coordinator.problem == nil)
        await coordinator.handBack()
        #expect(await trace.values().suffix(3) == ["handback", "stop", "unregister"])
    }
    @Test func approvalDoesNotFenceSourceAndBuildTreeCopyCannotRegister() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace); service.approval = true
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { await trace.add("enroll") }
        #expect(await trace.values() == ["review", "register"])
        #expect(coordinator.problem == "SERVICE_REQUIRES_APPROVAL")
        let copy = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: false)
        await copy.refresh(); await copy.move { await trace.add("enroll") }
        #expect(!copy.mayMove && copy.blockers.contains("INSTALL_IN_APPLICATIONS_REQUIRED"))
        #expect(await trace.values() == ["review", "register", "review"])
    }
    @Test func failedEnrollmentKeepsOwnershipUntilTheUserChoosesRestore() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { throw IdentityFailure("KEYCHAIN_DENIED") }
        #expect(await trace.values() == ["review", "register", "preflight", "move", "start"])
        #expect(coordinator.stage == "recovery required" && coordinator.problem == "KEYCHAIN_DENIED")
        await coordinator.restoreVSCode()
        #expect(await trace.values().suffix(3) == ["restore", "stop", "unregister"])
    }
    @Test func restoreIsAvailableAfterRelaunchWithoutAReviewOrConnectedEditor() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: false)
        #expect(!coordinator.mayMove)
        await coordinator.restoreVSCode()
        #expect(await trace.values() == ["restore", "stop", "unregister"])
        #expect(coordinator.stage == "legacy restored" && coordinator.problem == nil)
    }
    @Test func failedIdleEnginePreflightNeverCommitsOrEnrolls() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace); service.preflightFailure = true
        let backend = TestCutoverBackend(trace, responses: ["cancel": .object(["ok": .bool(true), "legacy": .bool(true)])])
        let coordinator = MacCutoverCoordinator(backend: backend, service: service, installed: true)
        await coordinator.refresh(); await coordinator.move { await trace.add("enroll") }
        #expect(await trace.values() == ["review", "register", "preflight", "cancel"])
        #expect(coordinator.problem == "ENGINE_PREFLIGHT_FAILED" && coordinator.stage == "review")
        #expect(coordinator.problemDiagnostics == ["exitStatus": "42", "output": "preflight failure"])
    }
    @Test func handbackAndRestoreDisconnectTheServiceClientBeforeRemovingTheEngine() async {
        for restore in [false, true] {
            let trace = CutoverTrace(), service = TestCutoverService(trace)
            let coordinator = MacCutoverCoordinator(backend: TestCutoverBackend(trace), service: service, installed: true,
                disconnect: { await trace.add("disconnect") })
            if restore { await coordinator.restoreVSCode() } else { await coordinator.handBack() }
            #expect(await trace.values() == [restore ? "restore" : "handback", "disconnect", "stop", "unregister"])
            #expect(coordinator.stage == "legacy restored" && coordinator.problem == nil)
        }
    }
    @Test func failedCurrentStateReturnKeepsTheAppClientAvailableForRecovery() async {
        let trace = CutoverTrace(), service = TestCutoverService(trace)
        let backend = TestCutoverBackend(trace, responses: ["handback": .object(["ok": .bool(false), "code": .string("CURRENT_STATE_EXPORT_REQUIRED")])])
        let coordinator = MacCutoverCoordinator(backend: backend, service: service, installed: true,
            disconnect: { await trace.add("disconnect") })
        await coordinator.handBack()
        #expect(await trace.values() == ["handback"])
        #expect(coordinator.stage == "recovery required" && coordinator.problem == "CURRENT_STATE_EXPORT_REQUIRED")
    }
}
