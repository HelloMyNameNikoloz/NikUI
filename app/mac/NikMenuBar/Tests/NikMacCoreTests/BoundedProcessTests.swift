import Foundation
import Testing
import NikMacIdentity
@testable import NikMacCore

@Suite("Bounded cutover child lifecycle", .serialized) struct BoundedProcessTests {
    @Test func hungChildIsKilledAtTheDeadline() async throws {
        let start = ProcessInfo.processInfo.systemUptime
        do {
            _ = try await BoundedProcess().run(executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "trap '' TERM; while :; do :; done"], environment: [:], timeout: 0.1)
            Issue.record("A hung child completed without a timeout")
        } catch { #expect((error as? IdentityFailure)?.code == "CUTOVER_TIMEOUT") }
        #expect(ProcessInfo.processInfo.systemUptime - start < 3)
    }
    @Test func cancellationTerminatesAnOwnedChildAndUnblocksTheCaller() async throws {
        let runner = BoundedProcess()
        let task = Task { try await runner.run(executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "while :; do :; done"], environment: [:], timeout: 20) }
        try await Task.sleep(for: .milliseconds(100)); task.cancel()
        do { _ = try await task.value; Issue.record("Cancellation did not stop the child") }
        catch { #expect((error as? IdentityFailure)?.code == "CUTOVER_CANCELLED") }
    }
    @Test func appTerminationCancelsEveryOwnedChild() async throws {
        let task = Task { try await BoundedProcess().run(executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "while :; do :; done"], environment: [:], timeout: 20) }
        try await Task.sleep(for: .milliseconds(100)); BoundedProcess.cancelAll()
        do { _ = try await task.value; Issue.record("App shutdown left the child running") }
        catch { #expect((error as? IdentityFailure)?.code == "CUTOVER_CANCELLED") }
    }
    @Test func actualProgressExtendsTheIdleDeadlineAndReturnsOnlyTheFinalReply() async throws {
        let start = ProcessInfo.processInfo.systemUptime
        let data = try await BoundedProcess().run(executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "for step in 1 2 3 4; do printf '{\"cutoverProgress\":%s}\\n' \"$step\"; /bin/sleep 0.1; done; printf '{\"ok\":true}\\n'"],
            environment: [:], timeout: 0.25, progress: true)
        #expect(ProcessInfo.processInfo.systemUptime - start > 0.25)
        #expect(String(decoding: data, as: UTF8.self) == "{\"ok\":true}\n")
    }
    @Test func aStalledTransitionStillTimesOutAfterItsLastProgress() async throws {
        do {
            _ = try await BoundedProcess().run(executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf '{\"cutoverProgress\":1}\\n'; while :; do :; done"], environment: [:], timeout: 0.15, progress: true)
            Issue.record("A stalled transition escaped its idle deadline")
        } catch { #expect((error as? IdentityFailure)?.code == "CUTOVER_TIMEOUT") }
    }
    @Test func repeatedProgressCannotKeepAStalledStepAlive() async throws {
        do {
            _ = try await BoundedProcess().run(executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "while :; do printf '{\"cutoverProgress\":1}\\n'; /bin/sleep 0.05; done"], environment: [:], timeout: 0.15, progress: true)
            Issue.record("Duplicate progress extended a stalled step")
        } catch { #expect((error as? IdentityFailure)?.code == "CUTOVER_TIMEOUT") }
    }
}
