import Foundation
import Testing
@testable import NikCore

@Suite("PIN, lock and bounded persistence") struct PINPersistenceTests {
    @Test(arguments: ["123", "1234567890123", "12a4", "１２３４", "1234 ", ""])
    func pinValidationRejects(_ pin: String) { #expect(!PINVerifier.valid(pin)) }
    @Test func configureMatchChangeAndDisableRequireCurrentPIN() async throws {
        let store = MemoryKeyValueStore(), clock = TestClock(); let verifier = PINVerifier(store: store, clock: clock)
        #expect(try await verifier.configure(pin: "1234", confirmation: "4321") == .mismatch)
        #expect(try await verifier.configure(pin: "1234", confirmation: "1234") == .configured)
        #expect(try await verifier.configure(pin: "456789", confirmation: "456789") == .requiresCurrentPIN)
        #expect(try await verifier.configure(pin: "456789", confirmation: "456789", currentPIN: "1234") == .configured)
        #expect(try await verifier.status().length == 6); #expect(try await verifier.verify("456789") == .unlocked)
        #expect(try await verifier.disable(currentPIN: "000000") != .disabled); #expect(try await verifier.disable(currentPIN: "456789") == .disabled)
        #expect(try await verifier.status().enabled == false)
    }
    @Test func persistentCooldownThresholds() async throws {
        let store = MemoryKeyValueStore(), clock = TestClock(); var verifier = PINVerifier(store: store, clock: clock)
        _ = try await verifier.configure(pin: "1234", confirmation: "1234")
        for attempt in 1...11 {
            let now = clock.now(); let wait = PINVerifier.cooldown(wrong: attempt)
            #expect(try await verifier.verify("0000") == .wrong(attempts: attempt, until: wait > 0 ? now.addingTimeInterval(wait) : nil))
            if wait > 0 {
                verifier = PINVerifier(store: store, clock: clock)
                #expect(try await verifier.verify("1234") == .cooldown(until: now.addingTimeInterval(wait)))
                clock.advance(wait)
            }
        }
        #expect(try await verifier.verify("1234") == .unlocked); #expect(try await verifier.status().wrong == 0)
    }
    @Test func concurrentWrongAttemptsAreSerialized() async throws {
        let verifier = PINVerifier(store: MemoryKeyValueStore()); _ = try await verifier.configure(pin: "1234", confirmation: "1234")
        async let first = verifier.verify("0000"); async let second = verifier.verify("9999"); _ = try await (first, second)
        #expect(try await verifier.status().wrong == 2)
    }
    @Test func biometricCannotBypassCooldownOrChangePIN() async throws {
        let store = MemoryKeyValueStore(), clock = TestClock(); let verifier = PINVerifier(store: store, clock: clock)
        _ = try await verifier.configure(pin: "1234", confirmation: "1234"); try await verifier.setBiometric(true)
        for _ in 0..<5 { _ = try await verifier.verify("0000") }
        #expect(try await verifier.biometricSucceeded() == .cooldown(until: clock.now().addingTimeInterval(30)))
        clock.advance(30); #expect(try await verifier.biometricSucceeded() == .unlocked)
        #expect(try await verifier.configure(pin: "5678", confirmation: "5678") == .requiresCurrentPIN)
    }
    @Test func corruptVerifierNeverResetsOrDisables() async throws {
        let store = MemoryKeyValueStore(); await store.set(Data("invalid".utf8), forKey: PINVerifier.storageKey)
        let verifier = PINVerifier(store: store)
        do { _ = try await verifier.configure(pin: "1234", confirmation: "1234"); Issue.record("Corrupt verifier was overwritten") } catch let e as CoreFailure { #expect(e.code == .persistence) }
        #expect(await store.data(forKey: PINVerifier.storageKey) == Data("invalid".utf8))
    }
    @Test func coldLaunchFiveMinuteGraceAndThreeBiometricAttempts() {
        let now = Date(); var policy = AppLockPolicy(); #expect(policy.isLocked)
        policy.unlock(); policy.lifecycle(.inactive, at: now, enabled: true); #expect(policy.hideSnapshot)
        policy.lifecycle(.foreground, at: now.addingTimeInterval(299), enabled: true); #expect(!policy.isLocked)
        policy.lifecycle(.background, at: now.addingTimeInterval(300), enabled: true); policy.lifecycle(.foreground, at: now.addingTimeInterval(600), enabled: true); #expect(policy.isLocked)
        policy.biometricFailed(wasCancellation: true); #expect(policy.biometricAttempts == 0)
        for _ in 0..<3 { policy.biometricFailed() }; #expect(!policy.mayAttemptBiometric)
        policy.unlock(); #expect(policy.mayAttemptBiometric)
    }
    @Test func draftRetentionBoundAndNoTranscript() throws {
        var cache = PersistedUIState(); cache.fleet = PreviewFixtures.fleet
        for i in 0..<80 { cache.drafts["chat\(i)"] = Draft(text: "draft \(i)", updatedAt: Date(timeIntervalSince1970: Double(i))) }
        let bounded = try cache.bounded(); #expect(bounded.drafts.count == 64); #expect(bounded.drafts["chat0"] == nil); #expect(bounded.drafts["chat79"] != nil)
        let encoded = String(decoding: try JSONEncoder().encode(bounded), as: UTF8.self); #expect(!encoded.contains("requestId")); #expect(!encoded.contains("items")); #expect(!encoded.contains("transcript text"))
    }
    @Test func protectedFilesAndScopeIsolation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProtectedFileStore(directory: directory); let repository = CacheRepository(store: store)
        var value = PersistedUIState(); value.drafts["chat"] = Draft(text: "secret")
        try await repository.save(value, scope: "laptop-a:phone")
        #expect(try await repository.load(scope: "laptop-b:phone") == nil); #expect(try await repository.load(scope: "laptop-a:phone")?.drafts["chat"]?.text == "secret")
        try await repository.remove(scope: "laptop-a:phone"); #expect(try await repository.load(scope: "laptop-a:phone") == nil)
    }
    @Test func invalidDraftStorageIsExplicit() {
        var cache = PersistedUIState(); cache.drafts["chat"] = Draft(text: String(repeating: "a", count: 128 * 1024 + 1))
        expectFailure(.tooLarge) { _ = try cache.bounded() }
    }
}
