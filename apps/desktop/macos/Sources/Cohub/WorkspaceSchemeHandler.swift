import CohubCore
import Foundation
import WebKit

/// Answers `cohub-workspace://` with files this Mac serves, streamed in chunks
/// with ranges. WebKit requires each task's callbacks on the main thread and
/// never after it stopped the task, so delivery goes through `loads`.
@MainActor
final class WorkspaceSchemeHandler: NSObject, WKURLSchemeHandler {
    private enum Event: Sendable {
        case response(status: Int, headers: [String: String])
        case data(Data)
        case finished
        case failed
    }

    nonisolated private static let chunk = 256 * 1024

    /// Never a proxy: requests carry the Runtime's token.
    nonisolated private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        return URLSession(configuration: configuration)
    }()

    private let files: WorkspaceFiles
    private let origin: String
    private var loads: [ObjectIdentifier: (task: any WKURLSchemeTask, reader: Task<Void, Never>)] = [:]

    init(files: WorkspaceFiles, origin: String) {
        self.files = files
        self.origin = origin
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let headers = task.request.allHTTPHeaderFields ?? [:]
        let target = (task.request.httpMethod ?? "GET") == "GET" ? WorkspaceFiles.target(of: url) : nil
        let (files, origin) = (self.files, self.origin)
        let reader = Task.detached { [weak self] in
            let emit: @Sendable (Event) async -> Void = { event in await self?.deliver(event, to: id) }
            guard let target else { return await Self.end(404, origin: origin, emit: emit) }
            await Self.stream(files: files, target: target, headers: headers, origin: origin, emit: emit)
        }
        loads[id] = (task, reader)
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        loads.removeValue(forKey: ObjectIdentifier(task))?.reader.cancel()
    }

    private func deliver(_ event: Event, to id: ObjectIdentifier) {
        guard let task = loads[id]?.task else { return }
        switch event {
        case .response(let status, let headers):
            guard let url = task.request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                return deliver(.failed, to: id)
            }
            task.didReceive(response)
        case .data(let data): task.didReceive(data)
        case .finished:
            loads[id] = nil
            task.didFinish()
        case .failed:
            loads[id] = nil
            task.didFailWithError(URLError(.networkConnectionLost))
        }
    }

    nonisolated private static func stream(files: WorkspaceFiles, target: (spaceId: String, path: String), headers: [String: String], origin: String, emit: @Sendable (Event) async -> Void) async {
        guard let request = await files.request(spaceId: target.spaceId, path: target.path, headers: headers) else {
            return await end(503, origin: origin, emit: emit)
        }
        let bytes: URLSession.AsyncBytes
        let response: HTTPURLResponse
        do {
            let (body, answer) = try await session.bytes(for: request)
            guard let http = answer as? HTTPURLResponse, http.statusCode != 401 else {
                body.task.cancel()
                return await end(503, origin: origin, emit: emit)
            }
            bytes = body
            response = http
        } catch let error as URLError where error.code == .cannotConnectToHost {
            return await end(503, origin: origin, emit: emit)
        } catch {
            return await emit(.failed)
        }
        var fields = response.allHeaderFields.reduce(into: [String: String]()) { fields, header in
            guard let name = header.key as? String, let value = header.value as? String,
                  WorkspaceFiles.passedHeaders.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else { return }
            fields[name] = value
        }
        fields["Access-Control-Allow-Origin"] = origin
        await emit(.response(status: response.statusCode, headers: fields))
        do {
            var buffer = Data(capacity: chunk)
            for try await byte in bytes {
                buffer.append(byte)
                if buffer.count == chunk {
                    await emit(.data(buffer))
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            if !buffer.isEmpty { await emit(.data(buffer)) }
            await emit(.finished)
        } catch {
            await emit(.failed)
        }
    }

    nonisolated private static func end(_ status: Int, origin: String, emit: @Sendable (Event) async -> Void) async {
        await emit(.response(status: status, headers: ["Access-Control-Allow-Origin": origin, "Cache-Control": "no-store", "Content-Length": "0"]))
        await emit(.finished)
    }
}
