import CohubCore
import Foundation
import WebKit

@MainActor
final class ShareSchemeHandler: NSObject, WKURLSchemeHandler {
    private enum Event: Sendable {
        case response(status: Int, headers: [String: String])
        case data(Data)
        case finished
        case failed
    }

    nonisolated private static let chunk = 256 * 1024

    private let inbox: SharedInbox?
    private let origin: String
    private var loads: [ObjectIdentifier: (task: any WKURLSchemeTask, reader: Task<Void, Never>)] = [:]

    init(inbox: SharedInbox?, origin: String) {
        self.inbox = inbox
        self.origin = origin
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        let target = (task.request.httpMethod ?? "GET") == "GET" ? task.request.url.flatMap(SharedInbox.target(of:)) : nil
        let (inbox, origin) = (self.inbox, self.origin)
        let emit: @Sendable (Event) async -> Void = { [weak self] event in await self?.deliver(event, to: id) }
        let reader = Task.detached {
            guard let target, let shared = try? inbox?.file(id: target.id, index: target.index) else {
                await emit(.response(status: 404, headers: Self.headers(origin: origin, type: nil, length: 0)))
                return await emit(.finished)
            }
            await Self.stream(shared.url, type: shared.file.mimeType, origin: origin, emit: emit)
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
            task.didFailWithError(URLError(.fileDoesNotExist))
        }
    }

    nonisolated private static func stream(_ file: URL, type: String, origin: String, emit: @Sendable (Event) async -> Void) async {
        guard let handle = try? FileHandle(forReadingFrom: file),
            let length = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
        else { return await emit(.failed) }
        defer { try? handle.close() }
        await emit(.response(status: 200, headers: headers(origin: origin, type: type, length: length)))
        do {
            while !Task.isCancelled, let data = try handle.read(upToCount: chunk), !data.isEmpty {
                await emit(.data(data))
            }
            await emit(.finished)
        } catch {
            await emit(.failed)
        }
    }

    nonisolated private static func headers(origin: String, type: String?, length: Int) -> [String: String] {
        var headers = ["Access-Control-Allow-Origin": origin, "Cache-Control": "no-store", "Content-Length": String(length)]
        if let type { headers["Content-Type"] = type }
        return headers
    }
}
