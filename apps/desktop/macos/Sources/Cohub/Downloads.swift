import AppKit
import CohubCore
import WebKit

@MainActor
final class Downloads: NSObject, WKDownloadDelegate {
    static let shared = Downloads()

    private var destinations: [ObjectIdentifier: URL] = [:]

    private var saved: [String: URL] = [:]

    static func save(_ params: JSON, emit: @escaping @MainActor @Sendable (JSON) -> Void) async throws -> JSON {
        guard let name = params["name"]?.string else { throw BridgeFailure.failed("files.save requires a name") }
        // Pages older than `files.progress` send no id.
        let id = params["id"]?.string ?? UUID().uuidString
        let destination = try unique(name)
        if let data = params["data"]?.string {
            guard let bytes = Data(base64Encoded: data) else { throw BridgeFailure.failed("files.save data is not base64") }
            try bytes.write(to: destination, options: .withoutOverwriting)
        } else if let link = params["url"]?.string, let url = URL(string: link), url.scheme == "https" {
            try await FileTransfer.download(URLRequest(url: url), to: destination) { received, total in
                Task { @MainActor in emit(FileTransfer.progressEvent(id: id, received: received, total: total)) }
            }
        } else {
            throw BridgeFailure.failed("files.save requires an https url or data")
        }
        shared.saved[id] = destination
        finished(destination)
        return ["location": "downloads", "revealable": true]
    }

    static func reveal(_ params: JSON) -> Bool {
        guard let file = params["id"]?.string.flatMap({ shared.saved[$0] }), FileManager.default.fileExists(atPath: file.path) else { return false }
        NSWorkspace.shared.activateFileViewerSelecting([file])
        return true
    }

    static func unique(_ suggested: String) throws -> URL {
        let directory = try FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var name = (suggested as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
        if name.isEmpty || name.hasPrefix(".") { name = "download\(name)" }
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var candidate = directory.appendingPathComponent(name)
        var index = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = directory.appendingPathComponent(ext.isEmpty ? "\(base) (\(index))" : "\(base) (\(index)).\(ext)")
            index += 1
        }
        return candidate
    }

    static func finished(_ file: URL) {
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: file.resolvingSymlinksInPath().path)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        guard let destination = try? Self.unique(suggestedFilename) else { return nil }
        destinations[ObjectIdentifier(download)] = destination
        return destination
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) { Self.finished(destination) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        destinations.removeValue(forKey: ObjectIdentifier(download))
    }
}
