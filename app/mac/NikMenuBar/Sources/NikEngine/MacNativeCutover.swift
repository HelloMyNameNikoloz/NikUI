import Foundation
import NikCore
import NikMenuCore
import NikMacCore
import NikMacIdentity

@MainActor enum MacNativeCutover {
    static func runIfRequested(window: MacWindowModel, session: MacAppSession, coordinator: MacCutoverCoordinator) async {
        #if NIKUI_PRODUCTION
        return
        #else
        let selection = session.selection
        guard selection.isCutoverRehearsal,
              let data = try? PrivateFiles.read(selection.root + "/mac-cutover-request.json"),
              let request = try? JSONValue.decode(data), request["version"].intValue == 1,
              let nonce = request["nonce"].stringValue, nonce.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let cwd = request["cwd"].stringValue, cwd.hasPrefix(selection.home + "/") else { return }
        session.nativeE2EActive = true
        var evidence: JSONValue = .object(["version": .number(1), "nonce": .string(nonce)])
        func write(_ stage: String) throws {
            evidence["stage"] = .string(stage)
            evidence["coordinatorStage"] = .string(coordinator.stage)
            evidence["coordinatorProblem"] = coordinator.problem.map(JSONValue.string) ?? .null
            evidence["coordinatorProblemDiagnostics"] = .object(coordinator.problemDiagnostics.mapValues(JSONValue.string))
            evidence["diagnostics"] = session.diagnostics(window: window)
            let file = selection.root + "/mac-cutover-state.json", temporary = selection.root + "/mac-cutover-" + UUID().uuidString
            defer { _ = unlink(temporary) }
            try PrivateFiles.create(temporary, data: evidence.encoded())
            if FileManager.default.fileExists(atPath: file) { try PrivateFiles.entry(file, kind: S_IFREG, mode: 0o600) }
            guard rename(temporary, file) == 0 else { throw IdentityFailure("CUTOVER_EVIDENCE_UNAVAILABLE") }
        }
        func wait(_ condition: @MainActor () -> Bool) async throws {
            let deadline = Date().addingTimeInterval(60)
            while !condition() {
                guard Date() < deadline else { throw IdentityFailure("CUTOVER_REHEARSAL_TIMEOUT") }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        do {
            await coordinator.refresh()
            evidence["initialReview"] = coordinator.review
            evidence["moveReview"] = coordinator.review
            try write("reviewed")
            guard coordinator.mayMove else { throw IdentityFailure(coordinator.blockers.first ?? coordinator.problem ?? "CUTOVER_NOT_READY") }
            // Same model call as the visible native Move button. This driver
            // and its private-file trigger are compiled out of production.
            await coordinator.move {
                try await session.connectAfterEngineStarts()
            }
            if coordinator.stage != "ready" {
                evidence["reloadInterruptedMove"] = .string(coordinator.problem ?? "CUTOVER_UNAVAILABLE")
                evidence["reloadInterruptedMoveDiagnostics"] = .object(coordinator.problemDiagnostics.mapValues(JSONValue.string))
                await coordinator.restoreVSCode()
                // The external rehearsal must prove both newly activated
                // legacy windows recovered their seeds before another Move.
                try write("aborted")
                try await wait {
                    guard let data = try? PrivateFiles.read(selection.root + "/mac-cutover-abort-verified.json"), let value = try? JSONValue.decode(data) else { return false }
                    return value["nonce"].stringValue == nonce
                }
                if coordinator.problem != nil { await coordinator.restoreVSCode() }
                for _ in 0..<120 {
                    try await Task.sleep(for: .milliseconds(250))
                    await coordinator.refresh()
                    evidence["retryReview"] = coordinator.review
                    try write("retry review")
                    if coordinator.mayMove && coordinator.review["windows"].intValue == 2 {
                        evidence["moveReview"] = coordinator.review
                        try write("retrying")
                        await coordinator.move {
                            try await session.connectAfterEngineStarts()
                        }
                        try write("retry completed")
                        break
                    }
                }
            }
            guard coordinator.stage == "ready", let client = session.client else { throw IdentityFailure(coordinator.problem ?? "CUTOVER_UNAVAILABLE") }
            let seeds = ["p3-legacy-conversation", "p3-second-conversation"]
            try await wait { client.connection.isLive && seeds.allSatisfy { id in client.fleet.rows.contains { $0.id == id } } }
            for id in seeds {
                await window.select(id, client: client)
                try await wait { session.renderedItems[id]?.contains("p3-legacy-text") == true }
            }
            evidence["sourceTranscriptRendered"] = .bool(true)
            evidence["everySourceTranscriptRendered"] = .bool(true)
            if FileManager.default.fileExists(atPath: selection.root + "/legacy-continuity.json") {
                await window.select("p3-legacy-conversation", client: client)
                try await wait {
                    client.conversation("p3-legacy-conversation").items.contains { $0.streaming && $0.text.contains("w3 ") && session.renderedStreamingItems.contains($0.id) }
                }
                evidence["keptStreamRendered"] = .bool(true)
            }
            let created = await client.perform(.newInstance(id: nonce, cwd: cwd, provider: .claude))
            guard case .accepted(let result) = created, let id = result["instance"].stringValue else { throw IdentityFailure("CUTOVER_POST_CREATE_FAILED") }
            evidence["createdAfterCutover"] = .string(id); try write("cutover")
            try await wait {
                guard let data = try? PrivateFiles.read(selection.root + "/mac-cutover-return.json"), let value = try? JSONValue.decode(data) else { return false }
                return value["nonce"].stringValue == nonce
            }
            await coordinator.handBack()
            guard coordinator.stage == "legacy restored", coordinator.problem == nil else { throw IdentityFailure(coordinator.problem ?? "HANDBACK_UNAVAILABLE") }
            guard client.connection == .offline else { throw IdentityFailure("HANDBACK_CLIENT_STILL_RECONNECTING") }
            evidence["clientDisconnectedAfterHandback"] = .bool(true)
            evidence["ok"] = .bool(true); try write("returned")
        } catch {
            evidence["ok"] = .bool(false); evidence["code"] = .string(MacAppSession.code(error)); try? write("failed")
        }
        #endif
    }
}
