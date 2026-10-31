import AppKit
import CohubCore
import WebKit

@MainActor
final class ShellWindow: NSWindowController, NSWindowDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private unowned let shell: Shell
    private var router: BridgeRouter?
    private var revealed = false
    private var observations: [NSKeyValueObservation] = []

    static let revealTimeout: Duration = .milliseconds(2_500)

    init(shell: Shell, path: String, cascadeFrom previous: NSWindow? = nil) {
        self.shell = shell
        let messages = ScriptMessageProxy()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        configuration.userContentController.add(messages, contentWorld: .page, name: HostProtocol.global)
        if let files = shell.workspaceFiles {
            configuration.setURLSchemeHandler(WorkspaceSchemeHandler(files: files, origin: shell.config.origin.origin), forURLScheme: WorkspaceFiles.scheme)
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.alphaValue = 0
        if #available(macOS 13.3, *) { webView.isInspectable = shell.config.isDevelopment }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.minSize = NSSize(width: 480, height: 360)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .automatic
        window.isReleasedWhenClosed = false
        window.contentView = webView
        super.init(window: window)

        messages.target = self
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        router = shell.router(for: self)
        apply(edge: ShellState.edgeColor ?? .windowBackgroundColor)
        if let previous {
            window.setFrame(previous.frame, display: false)
            window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: previous.frame.minX, y: previous.frame.maxY)))
        } else {
            if !window.setFrameUsingName("Cohub") { window.center() }
            window.setFrameAutosaveName("Cohub")
        }
        observations = [
            webView.observe(\.title) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.window?.title = webView.title ?? "Cohub" }
            },
            webView.observe(\.url) { [weak self] webView, _ in
                MainActor.assumeIsolated {
                    guard let self, let url = webView.url, let path = self.shell.config.origin.path(of: url) else { return }
                    self.shell.navigated(to: path)
                }
            },
        ]
        load(path)
        Task { [weak self] in
            try? await Task.sleep(for: Self.revealTimeout)
            self?.reveal()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func load(_ path: String) {
        guard let url = shell.config.origin.url(for: path) else { return }
        webView.load(URLRequest(url: url))
    }

    func reveal() {
        guard !revealed else { return }
        revealed = true
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            webView.animator().alphaValue = 1
        }
    }

    func apply(edge color: NSColor) {
        window?.backgroundColor = color
        webView.underPageBackgroundColor = color
    }

    func emit(_ name: String, _ payload: JSON?) {
        router?.emit(name, payload)
    }

    func serviceStarted() {
        if router?.describedWithoutService == true { webView.reload() }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        // Only the top-level Cohub page may drive native behaviour.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")" == shell.config.origin.origin,
              let text = message.body as? String
        else { return }
        router?.receive(text)
    }

    func deliver(_ text: String) {
        webView.callAsyncJavaScript("window.__cohubHostReceive?.(data)", arguments: ["data": text], in: nil, in: .page, completionHandler: nil)
    }

    func share(_ text: String) {
        let picker = NSSharingServicePicker(items: [text])
        let top = webView.isFlipped ? 0 : webView.bounds.maxY - 1
        picker.show(relativeTo: NSRect(x: webView.bounds.midX, y: top, width: 1, height: 1), of: webView, preferredEdge: .minY)
    }

    func pickFolder(service: HostService, handedOver: String?) async throws -> JSON {
        guard let window else { throw BridgeFailure.canceled() }
        var path = handedOver
        if path == nil {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = L("Choose")
            panel.message = L("Choose a folder for agents to work in.")
            guard await panel.beginSheetModal(for: window) == .OK, let url = panel.url else { throw BridgeFailure.canceled() }
            path = url.path
        }
        switch await service.call(BridgeRequest(id: "browse", method: HostProtocol.Method.runtimeBrowse, params: ["path": .string(path ?? "")])) {
        case .result(let listing): return listing
        case .failure(let failure): throw failure
        }
    }

    func confirmConnect(root: String) async -> Bool {
        guard let window else { return false }
        let alert = NSAlert()
        alert.messageText = L("Connect “\(URL(fileURLWithPath: root).lastPathComponent)” to a Space?")
        alert.informativeText = L("People and agents in the Space can change files in this folder and run commands as you on this Mac. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space.")
        alert.icon = NSWorkspace.shared.icon(forFile: root)
        alert.addButton(withTitle: L("Connect"))
        alert.addButton(withTitle: L("Cancel"))
        return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
    }

    func confirmShare() async -> Bool {
        guard let window else { return false }
        let alert = NSAlert()
        alert.messageText = L("Share this screen with the Space?")
        alert.informativeText = L("People and agents in the Space can see this screen and control this Mac until you stop sharing or quit Cohub.")
        alert.addButton(withTitle: L("Share"))
        alert.addButton(withTitle: L("Cancel"))
        return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
    }

    @objc func reloadPage(_ sender: Any?) { webView.reload() }
    @objc func navigateBack(_ sender: Any?) { webView.goBack() }
    @objc func navigateForward(_ sender: Any?) { webView.goForward() }
    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func actualSize(_ sender: Any?) { webView.pageZoom = 1 }

    override func newWindowForTab(_ sender: Any?) {
        shell.openWindow(path: "/", tabbedWith: window)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(navigateBack(_:)): webView.canGoBack
        case #selector(navigateForward(_:)): webView.canGoForward
        case #selector(actualSize(_:)): webView.pageZoom != 1
        default: true
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard shell.isLastWindow(self) else { return true }
        sender.orderOut(nil)
        return false
    }

    func windowWillClose(_ notification: Notification) {
        shell.closed(self)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url else { return .allow }
        if navigationAction.shouldPerformDownload { return .download }
        switch shell.config.origin.navigation(to: url) {
        case .allow: return .allow
        case .external(let url):
            NSWorkspace.shared.open(url)
            return .cancel
        case .deny: return .cancel
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        navigationResponse.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if let path = shell.config.origin.path(of: url) {
            shell.openWindow(path: path)
        } else if case .external(let url) = shell.config.origin.navigation(to: url) {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await panel(message, buttons: [L("OK")])
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await panel(message, buttons: [L("OK"), L("Cancel")]) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        return await panel(prompt, buttons: [L("OK"), L("Cancel")], accessory: field) == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        guard let window else { return nil }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        let requester = "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")"
        return frame.isMainFrame && requester == shell.config.origin.origin ? .grant : .prompt
    }

    private func panel(_ message: String, buttons: [String], accessory: NSView? = nil) async -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = message
        alert.accessoryView = accessory
        for button in buttons { alert.addButton(withTitle: button) }
        guard let window, window.isVisible else { return alert.runModal() }
        return await alert.beginSheetModal(for: window)
    }

    private static let bridgeScript = """
    (() => {
      const handler = window.webkit?.messageHandlers?.\(HostProtocol.global);
      if (!handler || window.\(HostProtocol.global)) return;
      const listeners = new Set();
      Object.defineProperty(window, "__cohubHostReceive", {
        value: (data) => {
          for (const listener of listeners) {
            try { listener({ data }); } catch (error) { console.error(error); }
          }
        },
      });
      Object.defineProperty(window, "\(HostProtocol.global)", {
        value: Object.freeze({
          postMessage: (message) => handler.postMessage(String(message)),
          addEventListener: (type, listener) => { if (type === "message") listeners.add(listener); },
          removeEventListener: (type, listener) => { if (type === "message") listeners.delete(listener); },
        }),
      });
    })();
    """
}

@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShellWindow?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}
