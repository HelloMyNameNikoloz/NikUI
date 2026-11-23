import Foundation
import Testing
import NikMacCore

@Suite("R41 captured launchd registration and endpoint proof") struct ServiceOwnershipTests {
    private let package: ServicePackageFixture
    init() throws { package = try ServicePackageFixture() }
    private var program: String { package.program }
    private func captured(_ name: String) throws -> String {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
        return try String(contentsOf: directory.appendingPathComponent("launchctl-" + name + ".txt"), encoding: .utf8)
    }
    @Test func enabledStoppedJobDoesNotProvePackageOwnership() throws {
        // Verbatim R39 native captures: stopped rescue and running engine.
        let stopped = try captured("stopped")
        #expect(!ServiceOwner.matchesPackage(job: stopped, executable: program, appID: "com.nikui.app.dev", enabled: true))
        #expect(ServiceOwner.matchesPackage(job: stopped, executable: program, appID: "com.nikui.app.dev", enabled: true, allowStopped: true))
        #expect(!ServiceOwner.matchesPackage(job: stopped, executable: program, appID: "com.nikui.app.dev", allowStopped: true))
    }
    @Test func runningCapturedJobNeedsExactExecutableAndBothEndpointPIDs() throws {
        let job = try captured("running"), pid = 51739
        #expect(ServiceOwner.matchesControl(job: job, executable: program, controlPID: pid, peerPID: pid,
            appID: "com.nikui.app.dev", processPath: { $0 == pid ? program : nil }))
        for (reported, peer) in [(pid + 1, pid), (pid, pid + 1), (pid + 1, pid + 1), (0, 0)] {
            #expect(!ServiceOwner.matchesControl(job: job, executable: program, controlPID: reported, peerPID: peer,
                appID: "com.nikui.app.dev", processPath: { _ in program }))
        }
        #expect(!ServiceOwner.matchesControl(job: job, executable: program, controlPID: pid, peerPID: pid,
            appID: "com.nikui.app.dev", processPath: { _ in "/Applications/Other.app/Contents/MacOS/nikd" }))
        #expect(!ServiceOwner.matchesControl(job: try captured("stopped"), executable: program, controlPID: pid, peerPID: pid,
            appID: "com.nikui.app.dev", processPath: { _ in program }))
    }
    @Test func stoppedRemovalIdentityCannotSurviveReplacementOrAnUnprovedRestart() throws {
        let stopped = try captured("stopped"), identity = try #require(ServiceOwner.registrationIdentity(job: stopped))
        #expect(ServiceOwner.registrationIdentity(job: stopped.replacingOccurrences(of: "not running", with: "running") + "\n\tpid = 42\n") == identity)
        for (old, new) in [("ID = 140114", "ID = 140999"), ("runs = 3", "runs = 4"),
                           ("hB-olzVtX", "other-copy"), ("version = 39", "version = 41")] {
            #expect(ServiceOwner.registrationIdentity(job: stopped.replacingOccurrences(of: old, with: new)) != identity)
        }
        #expect(ServiceOwner.registrationIdentity(job: stopped + "\n\tBTM uuid = DEADBEEF-0000-0000-0000-000000000000\n") == nil)
    }
    @Test func stoppedRemovalRequiresTheSameProvedPackageAndLoadedRegistration() throws {
        let job = try captured("stopped"), identity = try #require(ServiceOwner.registrationIdentity(job: job))
        #expect(ServiceOwner.matchesStoppedRegistration(job: job, executable: program, recordedExecutable: program,
            recordedIdentity: identity, enabled: true, appID: "com.nikui.app.dev"))
        for (savedPath, savedIdentity, enabled) in [("/other/nikd", identity, true), (program, identity + "old", true), (program, identity, false)] {
            #expect(!ServiceOwner.matchesStoppedRegistration(job: job, executable: program, recordedExecutable: savedPath,
                recordedIdentity: savedIdentity, enabled: enabled, appID: "com.nikui.app.dev"))
        }
    }
    @Test func ownRemovalSurvivesStoppedAndCrashLoopingRegistrationChanges() throws {
        let stopped = try captured("stopped")
        let looping = stopped.replacingOccurrences(of: "state = not running", with: "state = spawn scheduled")
            .replacingOccurrences(of: "runs = 3", with: "runs = 6")
            .replacingOccurrences(of: "last exit code = 0", with: "last exit code = 1")
        for job in [stopped, looping] {
            #expect(ServiceOwner.matchesRemoval(job: job, executable: program, registered: true, appID: "com.nikui.app.dev"))
            #expect(!ServiceOwner.matchesPackage(job: job, executable: program, appID: "com.nikui.app.dev", enabled: true))
            #expect(!ServiceOwner.matchesRemoval(job: job, executable: program, registered: false, appID: "com.nikui.app.dev"))
            #expect(!ServiceOwner.matchesRemoval(job: job, executable: program, registered: true, appID: "com.nikui.app"))
        }
    }
    @Test func removalStillRefusesForeignMissingAndAmbiguousRunningPIDs() throws {
        let job = try captured("running")
        #expect(ServiceOwner.matchesRemoval(job: job, executable: program, registered: true,
            appID: "com.nikui.app.dev", processPath: { _ in program }))
        for resolve in [{ (_: Int32) -> String? in nil }, { (_: Int32) -> String? in "/other/NikUI Dev.app/Contents/Resources/engine/node" }] {
            #expect(!ServiceOwner.matchesRemoval(job: job, executable: program, registered: true, appID: "com.nikui.app.dev", processPath: resolve))
        }
        for suffix in ["\n\tpid = 99\n", "\n\tparent bundle identifier = com.nikui.app.dev\n"] {
            #expect(!ServiceOwner.matchesRemoval(job: job + suffix, executable: program, registered: true,
                appID: "com.nikui.app.dev", processPath: { _ in program }))
        }
    }
    @Test func stoppedRegistrationResolvesBothOldFoundationAndKernelPathSpellings() throws {
        let job = try captured("stopped"), identity = try #require(ServiceOwner.registrationIdentity(job: job))
        let alias = program.replacingOccurrences(of: "/private/tmp/", with: "/tmp/")
        for (executable, saved) in [(program, alias), (alias, program)] {
            #expect(ServiceOwner.matchesStoppedRegistration(job: job, executable: executable, recordedExecutable: saved,
                recordedIdentity: identity, enabled: true, appID: "com.nikui.app.dev"))
        }
        try FileManager.default.removeItem(atPath: program)
        #expect(!ServiceOwner.matchesStoppedRegistration(job: job, executable: program, recordedExecutable: program,
            recordedIdentity: identity, enabled: true, appID: "com.nikui.app.dev"))
    }
}
