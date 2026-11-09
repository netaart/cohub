import CohubCore
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private static let deadline: Duration = .seconds(8)
    private static let openGrace: Duration = .milliseconds(1_500)

    private var finished = false
    private var completed = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        guard let group = Bundle.main.object(forInfoDictionaryKey: "CohubAppGroup") as? String,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
              let draft = try? SharedInbox(root: container.appendingPathComponent("Inbox", isDirectory: true)).draft()
        else { return finish(nil) }
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task {
            await Self.collect(items, into: draft)
            finish(draft)
        }
        Task {
            try? await Task.sleep(for: Self.deadline)
            finish(draft)
        }
    }

    private static func collect(_ items: [NSExtensionItem], into draft: SharedInbox.Draft) async {
        for item in items {
            if let caption = item.attributedContentText?.string { draft.add(text: caption) }
            for provider in item.attachments ?? [] {
                if let shared = await Self.text(from: provider) {
                    draft.add(text: shared)
                } else {
                    await Self.copyFile(from: provider, into: draft)
                }
            }
        }
    }

    private static func text(from provider: NSItemProvider) async -> String? {
        for type in [UTType.url, .plainText] where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            let item = try? await provider.loadItem(forTypeIdentifier: type.identifier)
            if let url = item as? URL, !url.isFileURL { return url.absoluteString }
            if let text = item as? String, !text.isEmpty { return text }
        }
        return nil
    }

    private static func copyFile(from provider: NSItemProvider, into draft: SharedInbox.Draft) async {
        guard let type = provider.registeredTypeIdentifiers.compactMap({ UTType($0) }).first(where: { $0.conforms(to: .data) }) else { return }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                if let url {
                    var name = provider.suggestedName ?? url.deletingPathExtension().lastPathComponent
                    if let ext = type.preferredFilenameExtension, (name as NSString).pathExtension.isEmpty { name += ".\(ext)" }
                    try? draft.add(fileAt: url, name: name, mimeType: type.preferredMIMEType ?? "application/octet-stream")
                }
                done.resume()
            }
        }
    }

    private func finish(_ draft: SharedInbox.Draft?) {
        guard !finished else { return }
        finished = true
        guard let draft, !draft.isEmpty, (try? draft.commit()) != nil else {
            extensionContext?.cancelRequest(withError: CocoaError(.fileReadUnknown))
            return
        }
        guard let scheme = Bundle.main.object(forInfoDictionaryKey: "CohubURLScheme") as? String,
              let url = URL(string: "\(scheme)://open\(WebOrigin.newChatPath)"),
              openHostApp(url)
        else { return complete() }
        Task { [weak self] in
            try? await Task.sleep(for: Self.openGrace)
            self?.complete()
        }
    }

    private func complete() {
        guard !completed else { return }
        completed = true
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func openHostApp(_ url: URL) -> Bool {
        typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, @convention(block) (Bool) -> Void) -> Void
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current is UIApplication, current.responds(to: selector) {
                let open = unsafeBitCast(current.method(for: selector), to: Open.self)
                open(current, selector, url as NSURL, NSDictionary()) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.complete() }
                }
                return true
            }
            responder = current.next
        }
        return false
    }
}
