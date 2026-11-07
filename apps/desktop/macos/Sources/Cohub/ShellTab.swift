import AppKit
import CohubCore
import WebKit

@MainActor
final class ShellTab: NSObject, WKNavigationDelegate, WKUIDelegate {
    private unowned let shell: Shell
    weak var window: ShellWindow?
    weak var opener: ShellTab?
    private(set) var webView: WKWebView?
    private var router: BridgeRouter?
    private var revealed = false
    private var observations: [NSKeyValueObservation] = []
    private var loadStarted: ContinuousClock.Instant?
    private(set) var path: String
    private(set) var title: String?
    private(set) var edge: RGB
    private(set) var dirty = false
    private(set) var capturesKeys = false
    private(set) var attention = false
    private var stale = false

    static let revealTimeout: Duration = .milliseconds(2_500)

    init(shell: Shell, window: ShellWindow, tab: TabSession.Tab) {
        self.shell = shell
        self.window = window
        path = tab.path
        title = tab.title
        edge = tab.edge.flatMap(RGB.init(hex:)) ?? ShellState.edgeColor ?? .window
        super.init()
    }

    var session: TabSession.Tab { .init(path: path, title: title, edge: edge.hex) }

    private var isShown: Bool { window?.selected === self && window?.window?.isVisible == true }

    func load(_ path: String) {
        guard let url = shell.config.origin.url(for: path) else { return }
        self.path = path
        loadStarted = .now
        makeWebView().load(URLRequest(url: url))
    }

    func refresh() {
        guard let webView else { return }
        if isShown { webView.reload() } else { stale = true }
    }

    func show() {
        attention = false
        guard let webView else { return load(path) }
        window?.host(webView)
        webView.isHidden = false
        if stale {
            stale = false
            webView.reload()
        }
    }

    func hide() {
        webView?.isHidden = true
    }

    func close() {
        observations = []
        router = nil
        webView?.stopLoading()
        webView?.removeFromSuperview()
        webView = nil
    }

    private func makeWebView() -> WKWebView {
        if let webView { return webView }
        let messages = ScriptMessageProxy()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addUserScript(WKUserScript(source: BridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        configuration.userContentController.add(messages, contentWorld: .page, name: HostProtocol.global)
        if let files = shell.workspaceFiles {
            configuration.setURLSchemeHandler(WorkspaceSchemeHandler(files: files, origin: shell.config.origin.origin), forURLScheme: WorkspaceFiles.scheme)
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.alphaValue = 0
        webView.isHidden = window?.selected !== self
        if #available(macOS 13.3, *) { webView.isInspectable = shell.config.isDevelopment }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(edge)
        self.webView = webView
        window?.host(webView)
        messages.target = self
        router = shell.router(for: self)
        observations = [
            webView.observe(\.title) { [weak self] webView, _ in
                MainActor.assumeIsolated { self?.titled(webView.title) }
            },
            webView.observe(\.url) { [weak self] webView, _ in
                MainActor.assumeIsolated {
                    guard let self, let url = webView.url, let path = self.shell.config.origin.path(of: url) else { return }
                    self.path = path
                    self.shell.sessionChanged()
                }
            },
        ]
        Task { [weak self] in
            try? await Task.sleep(for: Self.revealTimeout)
            self?.reveal()
        }
        return webView
    }

    private func titled(_ documentTitle: String?) {
        let title = TabSession.title(documentTitle)
        guard title != self.title else { return }
        self.title = title
        window?.tabChanged(self)
    }

    func reveal() {
        if let started = loadStarted {
            loadStarted = nil
            shell.log.info("First screen in \(Int((ContinuousClock.now - started) / .milliseconds(1))) ms")
        }
        guard !revealed, let webView else { return }
        revealed = true
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            webView.animator().alphaValue = 1
        }
    }

    func apply(edge: RGB) {
        guard edge != self.edge else { return }
        self.edge = edge
        webView?.underPageBackgroundColor = NSColor(edge)
        window?.tabChanged(self)
    }

    func update(dirty: Bool?, attention: Bool, capturesKeys: Bool?) {
        if let dirty { self.dirty = dirty }
        if let capturesKeys { self.capturesKeys = capturesKeys }
        guard attention, !self.attention, !(isShown && window?.window?.isKeyWindow == true) else { return }
        self.attention = true
        window?.tabChanged(self)
    }

    func emit(_ name: String, _ payload: JSON?) {
        router?.emit(name, payload)
    }

    func serviceStarted() {
        if router?.describedWithoutService == true { refresh() }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        // Only the top-level Cohub page may drive native behaviour.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
              shell.config.origin.isOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
              let text = message.body as? String
        else { return }
        router?.receive(text)
    }

    func deliver(_ text: String) {
        webView?.callAsyncJavaScript(BridgeScript.receive, arguments: ["data": text], in: nil, in: .page, completionHandler: nil)
    }

    func share(_ text: String) {
        guard let webView else { return }
        let picker = NSSharingServicePicker(items: [text])
        let top = webView.isFlipped ? 0 : webView.bounds.maxY - 1
        picker.show(relativeTo: NSRect(x: webView.bounds.midX, y: top, width: 1, height: 1), of: webView, preferredEdge: .minY)
    }

    func pickFolder(service: HostService, handedOver: String?) async throws -> JSON {
        var path = handedOver
        if path == nil {
            guard let sheet = window?.window else { throw BridgeFailure.canceled() }
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = L("Choose")
            panel.message = L("Choose a folder for agents to work in.")
            guard await panel.beginSheetModal(for: sheet) == .OK, let url = panel.url else { throw BridgeFailure.canceled() }
            path = url.path
        }
        switch await service.call(BridgeRequest(id: "browse", method: HostProtocol.Method.runtimeBrowse, params: ["path": .string(path ?? "")])) {
        case .result(let listing): return listing
        case .failure(let failure): throw failure
        }
    }

    func confirmConnect(root: String) async -> Bool {
        guard let sheet = window?.window else { return false }
        let alert = NSAlert()
        alert.messageText = L("Connect “\(URL(fileURLWithPath: root).lastPathComponent)” to a Space?")
        alert.informativeText = L("People and agents in the Space can change files in this folder and run commands as you on this Mac. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space.")
        alert.icon = NSWorkspace.shared.icon(forFile: root)
        alert.addButton(withTitle: L("Connect"))
        alert.addButton(withTitle: L("Cancel"))
        return await alert.beginSheetModal(for: sheet) == .alertFirstButtonReturn
    }

    func confirmShare() async -> Bool {
        guard let sheet = window?.window else { return false }
        let alert = NSAlert()
        alert.messageText = L("Share this screen with the Space?")
        alert.informativeText = L("People and agents in the Space can see this screen and control this Mac until you stop sharing or quit Cohub.")
        alert.addButton(withTitle: L("Share"))
        alert.addButton(withTitle: L("Cancel"))
        return await alert.beginSheetModal(for: sheet) == .alertFirstButtonReturn
    }

    private static func inBackground(_ action: WKNavigationAction) -> Bool? {
        let flags = action.modifierFlags
        guard flags.contains(.command) || action.buttonNumber == 2 else { return nil }
        return !flags.contains(.shift)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame != false, let url = navigationAction.request.url else { return .allow }
        if navigationAction.shouldPerformDownload { return .download }
        if navigationAction.navigationType == .linkActivated, let background = Self.inBackground(navigationAction), let path = shell.config.origin.path(of: url) {
            window?.open(.init(path: path), beside: self, background: background)
            return .cancel
        }
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

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        resetPageState()
    }

    private func resetPageState() {
        dirty = false
        capturesKeys = false
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = Downloads.shared
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        resetPageState()
        refresh()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if let path = shell.config.origin.path(of: url) {
            window?.open(.init(path: path), beside: self, background: Self.inBackground(navigationAction) ?? false)
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
        guard let sheet = window?.window else { return nil }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        return await panel.beginSheetModal(for: sheet) == .OK ? panel.urls : nil
    }

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        frame.isMainFrame && shell.config.origin.isOrigin(scheme: origin.protocol, host: origin.host, port: origin.port) ? .grant : .prompt
    }

    private func panel(_ message: String, buttons: [String], accessory: NSView? = nil) async -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = message
        alert.accessoryView = accessory
        for button in buttons { alert.addButton(withTitle: button) }
        guard isShown, let sheet = window?.window else { return alert.runModal() }
        return await alert.beginSheetModal(for: sheet)
    }
}

@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShellTab?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}
