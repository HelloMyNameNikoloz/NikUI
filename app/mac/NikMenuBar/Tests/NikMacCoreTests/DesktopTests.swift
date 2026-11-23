import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import Testing
import NikCore
import NikMenuCore
import NikMacIdentity
@testable import NikMacCore

private actor CapacityStore: KeyValueStore {
    func data(forKey key: String) -> Data? { nil }
    func set(_ data: Data, forKey key: String) throws { throw CoreFailure(.tooLarge, "Fixture draft capacity exhausted") }
    func removeValue(forKey key: String) {}
}

func desktopImageFixture() throws -> Data {
    let context = try #require(CGContext(data: nil, width: 2400, height: 12, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 2400, height: 12))
    let image = try #require(context.makeImage()), bytes = NSMutableData()
    let encoder = try #require(CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(encoder, image, nil); #expect(CGImageDestinationFinalize(encoder)); return bytes as Data
}
@Suite("Desktop draft bytes and loaded-transcript find") @MainActor struct DesktopTests {
    @Test func realSMAppServiceRegistrationUsesItsProcessAndParentBundle() throws {
        // Verbatim captured Darwin 27 output, supplied in the R37 brief.
        let captured = """
        \tpath = (submitted by smd.41692)
        \ttype = Submitted
        \tmanaged_by = com.apple.xpc.ServiceManagement
        \tstate = running
        \tprogram identifier = Contents/MacOS/nikd (mode: 2)
        \tparent bundle identifier = com.nikui.app.dev
        \tparent bundle version = 35
        \tstdout path = /private/tmp/nik-mac/build/p3/r35-home/engine.stdout.log
        \t...
        \tproperties = partial import | runatload | resolve program | has LWCR
        """
        let package = try ServicePackageFixture(), program = package.program
        let running = captured + "\n\tpid = 42\n"
        #expect(ServiceOwner.matchesPackage(job: running, executable: program, appID: "com.nikui.app.dev", processPath: { $0 == 42 ? program : nil }))
        let node = URL(fileURLWithPath: program).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/engine/node").path
        #expect(ServiceOwner.matchesPackage(job: running, executable: program, appID: "com.nikui.app.dev", processPath: { _ in node }))
        #expect(!ServiceOwner.matchesPackage(job: running, executable: program, appID: "com.nikui.app.dev", enabled: true, processPath: { _ in "/Applications/Foreign.app/Contents/MacOS/nikd" }))
        #expect(!ServiceOwner.matchesPackage(job: running, executable: program, appID: "com.nikui.app.dev", enabled: true, processPath: { _ in nil }))
        #expect(!ServiceOwner.matchesPackage(job: running + "pid = 42\n", executable: program, appID: "com.nikui.app.dev", processPath: { _ in program }))
        #expect(!ServiceOwner.matchesPackage(job: running, executable: program, appID: "com.nikui.app", enabled: true, processPath: { _ in program }))
        let stopped = captured.replacingOccurrences(of: "state = running", with: "state = not running")
        #expect(ServiceOwner.matchesPackage(job: stopped, executable: program, appID: "com.nikui.app.dev", enabled: true, allowStopped: true))
        #expect(!ServiceOwner.matchesPackage(job: captured, executable: program, appID: "com.nikui.app.dev", enabled: true))
        #expect(!ServiceOwner.matchesPackage(job: captured, executable: program, appID: "com.nikui.app.dev"))
        #expect(!ServiceOwner.matchesPackage(job: captured.replacingOccurrences(of: "Contents/MacOS/nikd (mode: 2)", with: "../nikd (mode: 2)"), executable: program, appID: "com.nikui.app.dev", enabled: true))
    }
    @Test func oversizedPixelMetadataRefusesBeforeDecode() throws {
        try MacImageAttachments.validateDimensions(width: 4000, height: 3000)
        for (width, height) in [(0, 10), (10, -1), (20000, 10), (12000, 12000), (Int.max, Int.max)] {
            #expect(throws: IdentityFailure("IMAGE_DIMENSIONS_TOO_LARGE")) { try MacImageAttachments.validateDimensions(width: width, height: height) }
        }
    }
    @Test func draftStartupSweepsOnlyItsOwnPrivateTemporaryFiles() async throws {
        let directory = "/private/tmp/nik-mac/build/p3/sweep-" + UUID().uuidString
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory + "/draft-" + UUID().uuidString, unrelated = directory + "/draft-other"
        try PrivateFiles.create(temporary, data: Data("interrupted write".utf8))
        try PrivateFiles.create(unrelated, data: Data("keep".utf8))
        let store = MacDraftStore(directory: directory)
        #expect(try await store.data(forKey: "missing") == nil)
        #expect(!FileManager.default.fileExists(atPath: temporary))
        #expect(FileManager.default.fileExists(atPath: unrelated))
    }
    @Test func serviceOwnerWaitsThroughRelaunchAndRejectsUnprovedPID() throws {
        let before = ServiceOwner(pid: 10, generation: "old"), after = ServiceOwner(pid: 20, generation: "new")
        var samples: [ServiceOwner?] = [before, nil, after, after], pauses = 0
        let owner = try ServiceOwner.wait(sample: { samples.removeFirst() }, pause: { pauses += 1 })
        #expect(owner == after && pauses == 3)
        #expect(owner.matches(job: "job {\n  pid = 20\n}"))
        #expect(!owner.matches(job: "job {\n  pid = 200\n}"))
        var time = Date(timeIntervalSince1970: 0)
        #expect(throws: IdentityFailure("SERVICE_OWNER_MISMATCH")) {
            try ServiceOwner.wait(sample: { nil }, pause: { time += 1 }, now: { time }, timeout: 2)
        }
    }
    @Test func importedImagesAreBoundedJPEGWithContentHash() async throws {
        let fixture = try desktopImageFixture(), source = try #require(CGImageSourceCreateWithData(fixture as CFData, nil))
        let type = try #require(CGImageSourceGetType(source))
        #expect(type as String == UTType.png.identifier)
        let image = try await MacImageAttachments.prepare(.bytes(fixture, name: "example"))
        let bytes = try #require(Data(base64Encoded: image.data))
        #expect(image.mediaType == "image/jpeg" && image.name == "example.jpg")
        #expect(image.width == 2048 && image.height! <= 2048)
        #expect(image.raw["byteCount"].intValue == bytes.count)
        #expect(image.raw["sha256"].stringValue == SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        #expect(CGImageSourceGetType(CGImageSourceCreateWithData(bytes as CFData, nil)!) as String? == UTType.jpeg.identifier)
        await #expect(throws: (any Error).self) { _ = try await MacImageAttachments.prepare(.bytes(Data("%PDF-1.7".utf8), name: "unsupported")) }
        await #expect(throws: IdentityFailure("IMAGE_TOO_LARGE")) { _ = try await MacImageAttachments.prepare(.bytes(Data(repeating: 0, count: MacImageAttachments.maximumInputBytes + 1), name: "large")) }
    }
    @Test func closingAndRelaunchRestoreTwoWindowsIncludingPrivateBytesAndReading() async throws {
        let directory = "/private/tmp/nik-mac/build/p3/draft-" + UUID().uuidString
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let secure = MemoryKeyValueStore(), cache = MacDraftStore(directory: directory)
        let key = P256.Signing.PrivateKey(), host = P256.Signing.PrivateKey()
        let pairing = PairedConnection(deviceID: "desktop", baseURL: URL(string: "http://127.0.0.1:4517")!, laptopName: "fixture",
            serverSPKI: host.publicKey.derRepresentation, fingerprint: NikCrypto.fingerprint(host.publicKey.derRepresentation),
            keyID: "desktop", publicSPKI: key.publicKey.derRepresentation, protection: .software)
        try await secure.set(WireCoding.encode(pairing), forKey: PairingService.pairingKey)
        let client = NikClient(secureStore: secure, cacheStore: cache)
        await client.restore()
        let left = MacWindowModel(token: "left"), right = MacWindowModel(token: "right")
        await left.select("a", client: client); await right.select("a", client: client)
        left.edit("Private left draft", client: client); right.edit("Independent right", client: client)
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let source = directory + "/source.png"
        try PrivateFiles.create(source, data: desktopImageFixture())
        await left.attach([.file(URL(fileURLWithPath: source))], to: "a", client: client)
        try FileManager.default.removeItem(atPath: source) // The draft must own the bytes now.
        let saved = client.viewDraft("left", conversationID: "a")
        #expect(saved.attachments.count == 1)
        await left.attach(Array(repeating: .bytes(Data(), name: "extra"), count: 6), to: "a", client: client)
        #expect(left.problem == "SIX_IMAGES_MAXIMUM"); #expect(client.viewDraft("left", conversationID: "a") == saved)
        var reading = ReadingState(); reading.offset = 840; reading.followsLatest = false; reading.findQuery = "Private"
        client.setViewReading(reading, forView: "left", conversationID: "a")
        await left.close(client: client); await right.close(client: client)
        let restored = NikClient(secureStore: secure, cacheStore: MacDraftStore(directory: directory))
        await restored.restore()
        #expect(restored.lastFailure == nil)
        #expect(restored.viewDraft("left", conversationID: "a") == saved)
        #expect(restored.viewDraft("right", conversationID: "a").text == "Independent right")
        #expect(restored.viewSessions["left"]?.lastConversationID == "a")
        #expect(restored.viewSessions["left"]?.reading["a"] == reading)
        #expect(restored.viewSessions.values.allSatisfy { $0.conversationID == nil })
        let reopened = MacWindowModel(token: "new-window")
        await reopened.restoreDraft(windowToken: "left", conversationID: "a", client: restored)
        #expect(reopened.token == "left" && reopened.text(restored) == "Private left draft")
        #expect(restored.viewDraft("left", conversationID: "a") == saved)
        #expect(reopened.find.query == "Private")
        #expect(restored.viewDraft("right", conversationID: "a").text == "Independent right")
        let duplicate = MacWindowModel(token: "another-window")
        await duplicate.restoreDraft(windowToken: "left", conversationID: "a", client: restored)
        #expect(duplicate.problem == "DRAFT_WINDOW_ALREADY_OPEN" && duplicate.token == "another-window")
        try PrivateFiles.entry(directory, kind: S_IFDIR, mode: 0o700)
        for file in try FileManager.default.contentsOfDirectory(atPath: directory) {
            try PrivateFiles.entry(directory + "/" + file, kind: S_IFREG, mode: 0o600)
        }
        // Exercise a real draft bigger than management's default frame bound.
        let payload = Data(repeating: 42, count: 300_000)
        try await cache.set(payload, forKey: "large-private-draft")
        #expect(try await cache.data(forKey: "large-private-draft") == payload)
    }
    @Test func findRejectsStaleAndInvalidWebContentResults() {
        let state = MacTranscriptFindState(); state.query = "needle"; state.move(-1)
        state.receive(.object(["query": .string("stale"), "count": .number(2), "index": .number(0)]))
        #expect(state.count == 0)
        state.receive(.object(["query": .string("needle"), "count": .number(2), "index": .number(1)]))
        #expect(state.count == 2 && state.index == 1 && state.step == -1)
        state.receive(.object(["query": .string("needle"), "count": .number(2), "index": .number(99)]))
        #expect(state.index == 1)
    }
    @Test func finderAndTerminalRequireVerifiedLocalDirectories() throws {
        let directory = "/private/tmp/nik-mac/build/p3/resource-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        #expect(try MacLocalResource.directory(directory).path == directory)
        for text in ["vscode-remote://ssh-remote+fixture/work", "file://remote.example/work", "https://example.com/work", "relative/folder", directory + "/missing"] {
            #expect(throws: (any Error).self) { _ = try MacLocalResource.directory(text) }
        }
    }
    @Test func failedAttachmentSaveIsVisibleAndRetainsTheUnsavedBytes() async throws {
        let secure = MemoryKeyValueStore(), host = P256.Signing.PrivateKey(), key = P256.Signing.PrivateKey()
        let pairing = PairedConnection(deviceID: "capacity-fixture", baseURL: URL(string: "http://127.0.0.1:4517")!, laptopName: "fixture",
            serverSPKI: host.publicKey.derRepresentation, fingerprint: NikCrypto.fingerprint(host.publicKey.derRepresentation),
            keyID: "fixture", publicSPKI: key.publicKey.derRepresentation, protection: .software)
        try await secure.set(WireCoding.encode(pairing), forKey: PairingService.pairingKey)
        let client = NikClient(secureStore: secure, cacheStore: CapacityStore()), window = MacWindowModel(token: "capacity")
        await client.restore(); await window.select("a", client: client)
        window.edit("Keep these bytes", client: client)
        await window.attach([.bytes(try desktopImageFixture(), name: "unsaved")], to: "a", client: client)
        #expect(window.problem == "Fixture draft capacity exhausted")
        #expect(client.viewDraft("capacity", conversationID: "a").attachments.count == 1)
        #expect(await client.flushPersistence() == false)
    }
}
