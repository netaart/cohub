import CohubCore
import Photos
import UIKit
import UniformTypeIdentifiers

@MainActor
final class FileSaver {
    nonisolated private static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Saves", isDirectory: true)

    private weak var host: UIViewController?
    private let api: WebOrigin
    private let auth: AuthSession

    init(host: UIViewController, api: WebOrigin, auth: AuthSession) {
        self.host = host
        self.api = api
        self.auth = auth
    }

    func save(_ params: JSON, emit: @escaping @MainActor @Sendable (JSON) -> Void) async throws -> JSON {
        guard let name = params["name"]?.string else { throw BridgeFailure.failed("files.save requires a name") }
        // Pages older than `files.progress` send no id.
        let id = params["id"]?.string ?? UUID().uuidString
        let mimeType = params["mimeType"]?.string
        let location: String
        switch (params["url"]?.string, params["data"]?.string) {
        case (let link?, nil):
            guard let url = URL(string: link), url.scheme == "https" else { throw BridgeFailure.failed("files.save only downloads https URLs") }
            location = try await deliver(name: name, mimeType: mimeType) { [self] file in
                try await download(url, to: file) { received, total in
                    Task { @MainActor in emit(FileTransfer.progressEvent(id: id, received: received, total: total)) }
                }
            }
        case (nil, let data?):
            location = try await deliver(name: name, mimeType: mimeType) { file in
                guard let bytes = Data(base64Encoded: data) else { throw CocoaError(.fileWriteUnknown) }
                try bytes.write(to: file)
            }
        default:
            throw BridgeFailure.failed("files.save requires exactly one of url or data")
        }
        return ["location": .string(location), "revealable": false]
    }

    /// Downloads the page navigated to; nothing on the page reports it, so the shell does.
    func save(url: URL, name: String, mimeType: String?) {
        Task {
            do {
                let location = try await deliver(name: name, mimeType: mimeType) { [self] file in
                    try await download(url, to: file) { _, _ in }
                }
                if location == "photos" { Toast.show(L("Saved to Photos"), in: host?.view) }
            } catch let failure as BridgeFailure where failure.code == HostProtocol.ErrorCode.canceled {
            } catch {
                logger.error("Could not save \(name, privacy: .private): \(error.localizedDescription, privacy: .public)")
                Toast.show(L("Couldn't save the file."), in: host?.view)
            }
        }
    }

    nonisolated static func removeLeftovers() {
        try? FileManager.default.removeItem(at: folder)
    }

    private func download(_ url: URL, to file: URL, progress: @escaping FileTransfer.Progress) async throws {
        var request = URLRequest(url: url)
        // Only the API origin may see the session's token.
        if api.contains(url), let token = await auth.accessToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        try await FileTransfer.download(request, to: file, progress: progress)
    }

    private func deliver(name: String, mimeType: String?, write: (URL) async throws -> Void) async throws -> String {
        let directory = Self.folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(Self.fileName(name))
        try await write(file)
        if await Self.addToPhotos(file, mimeType: mimeType) {
            Haptics.perform("confirm")
            return "photos"
        }
        guard await export(file) else { throw BridgeFailure.canceled("Not saved") }
        return "files"
    }

    private func export(_ file: URL) async -> Bool {
        guard let host else { return false }
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        let outcome = ExportOutcome()
        picker.delegate = outcome
        let saved = await withCheckedContinuation { continuation in
            outcome.continuation = continuation
            host.topmost.present(picker, animated: true)
            picker.presentationController?.delegate = outcome
        }
        withExtendedLifetime(outcome) {}
        return saved
    }

    private static func addToPhotos(_ file: URL, mimeType: String?) async -> Bool {
        let type = mimeType.flatMap { UTType(mimeType: $0) } ?? UTType(filenameExtension: file.pathExtension)
        let resource: PHAssetResourceType
        if type?.conforms(to: .movie) == true { resource = .video }
        else if type?.conforms(to: .image) == true, type?.conforms(to: .svg) != true { resource = .photo }
        else { return false }
        guard await PHPhotoLibrary.requestAuthorization(for: .addOnly) == .authorized else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: resource, fileURL: file, options: nil)
            }
            return true
        } catch {
            return false
        }
    }

    private static func fileName(_ suggested: String) -> String {
        let name = (suggested as NSString).lastPathComponent.replacingOccurrences(of: ":", with: "-")
        return name.isEmpty || name.hasPrefix(".") ? "download\(name)" : String(name.prefix(255))
    }
}

@MainActor
private final class ExportOutcome: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    var continuation: CheckedContinuation<Bool, Never>?

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(true) }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(false) }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(false) }

    private func finish(_ saved: Bool) {
        continuation?.resume(returning: saved)
        continuation = nil
    }
}
