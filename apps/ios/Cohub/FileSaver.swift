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

    func save(_ params: JSON) throws {
        guard let name = params["name"]?.string else { throw BridgeFailure.failed("files.save requires a name") }
        let mimeType = params["mimeType"]?.string
        switch (params["url"]?.string, params["data"]?.string) {
        case (let link?, nil):
            guard let url = URL(string: link), url.scheme == "https" else { throw BridgeFailure.failed("files.save only downloads https URLs") }
            save(url: url, name: name, mimeType: mimeType)
        case (nil, let data?):
            deliver(name: name, mimeType: mimeType) { file in
                guard let bytes = Data(base64Encoded: data) else { throw CocoaError(.fileWriteUnknown) }
                try bytes.write(to: file)
            }
        default:
            throw BridgeFailure.failed("files.save requires exactly one of url or data")
        }
    }

    func save(url: URL, name: String, mimeType: String?) {
        let session = api.contains(url) ? auth : nil
        deliver(name: name, mimeType: mimeType) { file in
            var request = URLRequest(url: url)
            if let token = await session?.accessToken() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (download, response) = try await URLSession.shared.download(for: request)
            guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
                try? FileManager.default.removeItem(at: download)
                throw URLError(.badServerResponse)
            }
            try FileManager.default.moveItem(at: download, to: file)
        }
    }

    nonisolated static func removeLeftovers() {
        try? FileManager.default.removeItem(at: folder)
    }

    private func deliver(name: String, mimeType: String?, write: @escaping @Sendable (URL) async throws -> Void) {
        Task {
            do {
                let directory = Self.folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent(Self.fileName(name))
                try await write(file)
                if await Self.addToPhotos(file, mimeType: mimeType) {
                    try? FileManager.default.removeItem(at: directory)
                    Haptics.perform("confirm")
                    Toast.show(L("Saved to Photos"), in: host?.view)
                } else if let host {
                    host.topmost.present(UIDocumentPickerViewController(forExporting: [file], asCopy: true), animated: true)
                }
            } catch {
                logger.error("Could not save \(name, privacy: .private): \(error.localizedDescription, privacy: .public)")
                Toast.show(L("Couldn't save the file."), in: host?.view)
            }
        }
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
