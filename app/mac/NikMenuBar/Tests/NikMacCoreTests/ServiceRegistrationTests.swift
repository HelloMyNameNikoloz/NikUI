import Foundation
import Testing
import NikMacCore
import NikMenuCore
import NikMacIdentity

@Suite("R45 stale bundle registration recovery") struct ServiceRegistrationTests {
    private let label = "com.nikui.engine.development"
    @Test func enabledWithoutAJobRecoversTheOwnRegistration() throws {
        #expect(try ServiceRegistration.action(status: .enabled, job: nil) == .replaceStale)
        #expect(ServiceOwner.matchesRemoval(job: nil, executable: "/own/nikd", registered: true))
        #expect(!ServiceOwner.matchesRemoval(job: nil, executable: "/own/nikd", registered: false))
    }
    @Test func approvalAlwaysBlocksStartAndMoveWithoutReplacingRegistration() {
        for job in [nil, "loaded job"] as [String?] {
            do {
                _ = try ServiceRegistration.action(status: .requiresApproval, job: job)
                Issue.record("Start/Move must preserve the user's Login Items choice")
            } catch { #expect((error as? IdentityFailure)?.code == "SERVICE_REQUIRES_APPROVAL") }
        }
    }
    @Test func loadedJobsAreNeverReplacedBasedOnStatusAlone() throws {
        #expect(try ServiceRegistration.action(status: .enabled, job: "foreign job") == .reuse)
        for state in [LoginRegistration.notFound, .notRegistered] {
            #expect(throws: IdentityFailure.self) { try ServiceRegistration.action(status: state, job: "foreign job") }
            #expect(try ServiceRegistration.action(status: state, job: nil) == .register)
        }
    }
    @Test func deniedOrMalformedInventoryIsNeverAnAbsentJob() throws {
        #expect(try ServiceOwner.jobSnapshot(output: "Could not find service \"\(label)\" in domain for user gui: 502", status: 113, label: label) == nil)
        #expect(try ServiceOwner.jobSnapshot(output: "job = {\n}", status: 0, label: label) != nil)
        for (code, text) in [(Int32(1), "Operation not permitted"), (113, "Could not find service \"other.label\""),
                             (113, "Could not find domain for user gui: 502"), (0, "")] {
            #expect(throws: IdentityFailure.self) { try ServiceOwner.jobSnapshot(output: text, status: code, label: label) }
        }
    }
    @Test func boundedInventoryPreservesTheActualExitStatusAndErrorReply() throws {
        let result = try BoundedProcess().runSynchronousResult(executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "printf '%s' 'Could not find service \"com.nikui.engine.development\"' >&2; exit 113"],
            environment: ["PATH": "/usr/bin:/bin"], timeout: 2)
        #expect(result.status == 113)
        #expect(try ServiceOwner.jobSnapshot(output: String(decoding: result.data, as: UTF8.self), status: result.status, label: label) == nil)
    }
}
