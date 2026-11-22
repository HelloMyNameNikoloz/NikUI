import Foundation
import NikCore
import NikMenuCore
import NikMacCore
import NikMacIdentity
import ImageIO
import UniformTypeIdentifiers

/// Native gate only: the signed DEV acceptance fixture plus a private request
/// are both required. It drives the same models as the visible native controls.
/// No production/environment/URL switch can enable it.
@MainActor enum MacNativeE2E {
    static func runIfRequested(window: MacWindowModel, session: MacAppSession) async {
        #if NIKUI_PRODUCTION
        return
        #else
        let selection = session.selection
        guard selection.flavour == .development,
              let file = Bundle.main.resourceURL?.appendingPathComponent("engine/mac-engine.json"),
              let bytes = try? Data(contentsOf: file), let config = try? JSONValue.decode(bytes),
              config["flavour"].stringValue == "dev", config["acceptanceP2"].boolValue == true,
              config["root"].stringValue == selection.root else { return }
        var request: JSONValue?
        while !Task.isCancelled, !session.nativeE2EActive {
            if let bytes = try? PrivateFiles.read(selection.root + "/mac-e2e-request.json"), let value = try? JSONValue.decode(bytes) { request = value; break }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
        }
        guard !session.nativeE2EActive, let request, Set(request.objectValue.keys) == ["version", "nonce", "scenario"],
              request["version"].intValue == 1, request["scenario"].stringValue == "r03-core",
              let nonce = request["nonce"].stringValue, nonce.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return }
        session.nativeE2EActive = true
        var evidence: [String: JSONValue] = ["version": .number(1), "nonce": .string(nonce), "pid": .number(Double(getpid())), "viewToken": .string(window.token)]
        func write(_ stage: String) throws {
            evidence["diagnostics"] = session.diagnostics(window: window)
            evidence["stage"] = .string(stage)
            let file = selection.root + "/mac-e2e-state.json", temporary = selection.root + "/mac-e2e-" + UUID().uuidString
            defer { _ = unlink(temporary) }
            try PrivateFiles.directory(selection.root)
            try PrivateFiles.create(temporary, data: JSONValue.object(evidence).encoded())
            if FileManager.default.fileExists(atPath: file) { try PrivateFiles.entry(file, kind: S_IFREG, mode: 0o600) }
            guard rename(temporary, file) == 0 else { throw IdentityFailure("E2E_EVIDENCE_UNAVAILABLE") }
        }
        func wait(_ name: String, _ predicate: @MainActor () -> Bool) async throws {
            let started = Date(), deadline = started.addingTimeInterval(45)
            var nextSample = Date.distantPast
            evidence["waitingFor"] = .string(name)
            while !predicate() {
                try Task.checkCancellation()
                if Date() >= nextSample {
                    evidence["waitElapsedSeconds"] = .number(Date().timeIntervalSince(started))
                    try write(evidence["stage"]?.stringValue ?? "waiting"); nextSample = Date().addingTimeInterval(1)
                }
                guard Date() < deadline else {
                    evidence["timedOutWait"] = .string(name)
                    throw IdentityFailure("E2E_TIMEOUT_" + name)
                }
                try await Task.sleep(for: .milliseconds(50))
            }
            evidence["waitingFor"] = .null
        }
        do {
            try write("connecting"); await session.connect()
            guard let client = session.client else { throw IdentityFailure(session.problem ?? "E2E_CLIENT_UNAVAILABLE") }
            try await wait("FLEET") { client.connection.isLive && client.fleet.rows.contains { $0.id == "p2-claude" } && client.fleet.codex.contains { $0.id == "cx-p2-codex" } }
            await window.select("cx-p2-codex", client: client)
            try await wait("CODEX") { client.conversation("cx-p2-codex").initialized && client.conversation("cx-p2-codex").meta.provider == .codex }
            evidence["bothProvidersOpened"] = .bool(true)
            await window.select("p2-claude", client: client)
            try await wait("CONVERSATION") { client.conversation("p2-claude").initialized && client.conversation("p2-claude").connection.isLive }
            guard let welcome = client.protocolSessions[.conversation("p2-claude")]?.welcome,
                  welcome.version == .v2, welcome.seat.raw["local"].boolValue == true, welcome.seat.control else { throw IdentityFailure("E2E_LOCAL_SEAT_REQUIRED") }
            evidence["engineID"] = .string(welcome.engineID); evidence["generation"] = session.generation.map(JSONValue.string)
            evidence["localDevice"] = .string(welcome.seat.id)
            // Both file and paste/drop bytes share the production import path.
            // Only this fresh private fixture supplies the input image.
            let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.setFillColor(CGColor(gray: 0.5, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
            let png = NSMutableData(), encoder = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil)!
            CGImageDestinationAddImage(encoder, context.makeImage()!, nil)
            guard CGImageDestinationFinalize(encoder) else { throw IdentityFailure("E2E_IMAGE_UNAVAILABLE") }
            let imageFile = selection.root + "/mac-e2e-image.png"
            try PrivateFiles.create(imageFile, data: png as Data)
            window.edit("P3 native core send", client: client)
            await window.attach([.file(URL(fileURLWithPath: imageFile))], to: "p2-claude", client: client)
            guard window.problem == nil else { throw IdentityFailure(window.problem!) }
            let independent = MacWindowModel(token: "e2e-independent-" + nonce)
            await independent.select("p2-claude", client: client)
            independent.edit("Independent retained native draft", client: client)
            await independent.attach([.bytes(png as Data, name: "Pasted fixture")], to: "p2-claude", client: client)
            await independent.close(client: client)
            let cache = CacheRepository(store: MacDraftStore(directory: selection.home + "/client"))
            let saved = try await cache.load(scope: client.pairedConnection!.scope)
            let mainDraft = client.viewDraft(window.token, conversationID: "p2-claude")
            guard mainDraft.attachments.count == 1,
                  saved?.viewSessions?[window.token]?.drafts["p2-claude"] == mainDraft,
                  saved?.viewSessions?[independent.token]?.drafts["p2-claude"]?.attachments.count == 1,
                  saved?.viewSessions?[independent.token]?.drafts["p2-claude"]?.text == "Independent retained native draft" else { throw IdentityFailure("E2E_PRIVATE_DRAFT_RESTORE_FAILED") }
            evidence["privateImageDrafts"] = .bool(true)
            evidence["attachmentHash"] = mainDraft.attachments[0].raw["sha256"]
            window.edit("P3 native core send", client: client); await window.send(client: client)
            guard window.problem == nil, window.text(client).isEmpty,
                  let sent = client.pendingIntents.values.filter({ $0.viewToken == window.token && $0.what == "send" }).max(by: { $0.localOrder < $1.localOrder }), sent.acknowledgement?.outcome == .applied else {
                throw IdentityFailure(window.problem ?? "E2E_SEND_NOT_ACCEPTED")
            }
            evidence["sendMid"] = .string(sent.mid); evidence["matchingReceiptClearedDraft"] = .bool(true)
            try write("sent")
            try await wait("STREAMING_RENDER") {
                client.conversation("p2-claude").items.contains { $0.id == "p3-native-reply:0" && $0.streaming && !$0.text.isEmpty } &&
                session.renderedStreamingItems.contains("p3-native-reply:0")
            }
            evidence["streamedInWebView"] = .bool(true); try write("streaming")
            window.find.visible = true; window.find.query = "Streamed reply"
            try await wait("TRANSCRIPT_FIND") { window.find.count == 1 && window.find.index == 0 }
            window.find.move(-1)
            evidence["findInWebView"] = .bool(true); window.find.visible = false
            try await wait("APPROVAL") {
                client.conversation("p2-claude").permissions.contains { $0.requestId == "p2-approval" } &&
                client.conversation("p2-claude").items.contains { $0.id == "p3-native-reply:0" && !$0.streaming && $0.text.hasSuffix(" Complete.") }
            }
            let permission = client.conversation("p2-claude").permissions.first { $0.requestId == "p2-approval" }!
            guard let approval = window.capture(.approval, client: client, item: permission) else { throw IdentityFailure("E2E_APPROVAL_UNAVAILABLE") }
            await window.act(approval, client: client, allow: true)
            guard window.problem == nil, let receipt = client.pendingIntents.values.first(where: { $0.viewToken == window.token && $0.what == "permission" && $0.acknowledgement?.outcome == .applied }) else {
                throw IdentityFailure(window.problem ?? "E2E_APPROVAL_NOT_ACCEPTED")
            }
            evidence["approvalMid"] = .string(receipt.mid)
            await window.act(approval, client: client, allow: true)
            guard window.problem == "DUPLICATE_CONTROL" else { throw IdentityFailure("E2E_DUPLICATE_NOT_REFUSED") }
            evidence["duplicateRefused"] = .bool(true); window.problem = nil; try write("approved")
            window.edit("P3 native durable queue", client: client); await window.send(client: client)
            guard window.problem == nil, let queued = client.pendingIntents.values.filter({ $0.viewToken == window.token && $0.what == "send" && $0.mid != sent.mid }).max(by: { $0.localOrder < $1.localOrder }), queued.acknowledgement?.outcome == .applied else {
                throw IdentityFailure(window.problem ?? "E2E_QUEUE_NOT_ACCEPTED")
            }
            evidence["queueMid"] = .string(queued.mid)
            try await wait("QUEUE_SNAPSHOT") { client.conversation("p2-claude").queue.contains { $0.raw["mid"].stringValue == queued.mid && $0.raw["actions"].arrayValue.contains(.string("unqueue")) } }
            try write("queued")
            // Let the external harness prove the authoritative queued state
            // before Stop can change provider delivery scheduling.
            try await wait("STOP_BARRIER") {
                guard let data = try? PrivateFiles.read(selection.root + "/mac-e2e-stop.json"), let value = try? JSONValue.decode(data) else { return false }
                return value["nonce"].stringValue == nonce && value["stop"].boolValue == true
            }
            // Queue delivery intentionally resumes after a result. Remove the
            // already-proved queue through the native control so Stop tests
            // this captured turn without racing the next queued turn.
            guard let queue = client.conversation("p2-claude").queue.first(where: { $0.raw["mid"].stringValue == queued.mid }),
                  let remove = window.capture(.unqueue, client: client, queue: queue) else { throw IdentityFailure("E2E_UNQUEUE_UNAVAILABLE") }
            await window.act(remove, client: client)
            guard window.problem == nil, let removed = client.pendingIntents.values.first(where: {
                $0.viewToken == window.token && $0.what == "unqueue" && $0.acknowledgement?.outcome == .applied
            }) else { throw IdentityFailure(window.problem ?? "E2E_UNQUEUE_NOT_ACCEPTED") }
            evidence["unqueueMid"] = .string(removed.mid)
            try await wait("QUEUE_REMOVED") { !client.conversation("p2-claude").queue.contains { $0.raw["mid"].stringValue == queued.mid } }
            guard let stop = window.capture(.stop, client: client) else { throw IdentityFailure("E2E_STOP_UNAVAILABLE") }
            await window.act(stop, client: client)
            guard window.problem == nil, let receipt = client.pendingIntents.values.first(where: { $0.viewToken == window.token && $0.what == "interrupt" && $0.acknowledgement?.outcome == .applied }) else { throw IdentityFailure(window.problem ?? "E2E_STOP_NOT_ACCEPTED") }
            evidence["stopMid"] = .string(receipt.mid)
            try await wait("INTERRUPTED") {
                let state = client.conversation("p2-claude")
                return ![ConversationStatus.working, .waiting].contains(state.status) && state.items.contains { $0.kind == "result" && $0.interrupted }
            }
            evidence["stopEndedTurn"] = .bool(true)
            try write("stopped")
            try await wait("QUEUE_RESTART_BARRIER") {
                guard let data = try? PrivateFiles.read(selection.root + "/mac-e2e-queue-start.json"), let value = try? JSONValue.decode(data) else { return false }
                return value["nonce"].stringValue == nonce
            }
            // A separate turn proves the editor's Stop contract: queued work
            // survives the interrupt and is then delivered exactly once.
            window.edit("P3 native second active turn", client: client); await window.send(client: client)
            guard window.problem == nil else { throw IdentityFailure(window.problem!) }
            try await wait("SECOND_TURN") { client.conversation("p2-claude").status == .working }
            let survivingText = "P3 native queued prompt survives Stop"
            window.edit(survivingText, client: client); await window.send(client: client)
            guard window.problem == nil, let surviving = client.pendingIntents.values.filter({ $0.viewToken == window.token && $0.what == "send" }).max(by: { $0.localOrder < $1.localOrder }), surviving.acknowledgement?.outcome == .applied else {
                throw IdentityFailure(window.problem ?? "E2E_SURVIVING_QUEUE_NOT_ACCEPTED")
            }
            evidence["survivingQueueMid"] = .string(surviving.mid)
            try await wait("SURVIVING_QUEUE") { client.conversation("p2-claude").queue.contains { $0.raw["mid"].stringValue == surviving.mid } }
            try write("queuedForStop")
            try await wait("QUEUED_STOP_BARRIER") {
                guard let data = try? PrivateFiles.read(selection.root + "/mac-e2e-queue-stop.json"), let value = try? JSONValue.decode(data) else { return false }
                return value["nonce"].stringValue == nonce
            }
            guard let queuedStop = window.capture(.stop, client: client) else { throw IdentityFailure("E2E_QUEUED_STOP_UNAVAILABLE") }
            await window.act(queuedStop, client: client)
            guard window.problem == nil, let stopped = client.pendingIntents.values.filter({ $0.viewToken == window.token && $0.what == "interrupt" && $0.mid != receipt.mid && $0.acknowledgement?.outcome == .applied }).max(by: { $0.localOrder < $1.localOrder }) else {
                throw IdentityFailure(window.problem ?? "E2E_QUEUED_STOP_NOT_ACCEPTED")
            }
            evidence["queuedStopMid"] = .string(stopped.mid)
            try await wait("QUEUED_PROMPT_RUNNING_AFTER_STOP") {
                let state = client.conversation("p2-claude")
                return state.status == .working && state.items.contains { $0.text == survivingText } &&
                    state.queue.contains { $0.raw["mid"].stringValue == surviving.mid && $0.raw["state"].stringValue == "accepted" && $0.raw["actions"].arrayValue.isEmpty }
            }
            evidence["queuedPromptSurvivedStopAndRan"] = .bool(true); try write("queueRanAfterStop")
            try await wait("SURVIVING_QUEUE_FINISHED") {
                ![ConversationStatus.working, .waiting].contains(client.conversation("p2-claude").status)
            }
            guard !client.conversation("p2-claude").visibleQueue.contains(where: { $0.raw["mid"].stringValue == surviving.mid }) else {
                throw IdentityFailure("E2E_FINISHED_PROMPT_STILL_QUEUED")
            }
            evidence["finishedPromptAbsentFromQueue"] = .bool(true)
            await client.flushPersistence(); evidence["ok"] = .bool(true); try write("done")
        } catch {
            evidence["ok"] = .bool(false); evidence["code"] = .string(MacAppSession.code(error)); try? write("failed")
        }
        #endif
    }
}
