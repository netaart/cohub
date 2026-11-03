import AppKit
import CohubCore
import WebKit

@MainActor
final class ShellWindow: NSWindowController, NSWindowDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView?
    private unowned let shell: Shell
    private var router: BridgeRouter?
    private var revealed = false
    private var observations: [NSKeyValueObservation] = []
    private var loadStarted: ContinuousClock.Instant?
    private(set) var path: String
    private var title: String?
    private var edge: NSColor
    private(set) var dirty = false
    private(set) var parked = false
    private var stale = false
    weak var opener: ShellWindow?

    static let revealTimeout: Duration = .milliseconds(2_500)

    init(shell: Shell, tab: TabSession.Tab, loads: Bool) {
        self.shell = shell
        path = tab.path
        title = tab.title
        edge = tab.edge.flatMap(NSColor.init(hex:)) ?? ShellState.edgeColor ?? .windowBackgroundColor
        let window = TabWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: true
        )
        window.minSize = NSSize(width: 480, height: 360)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .automatic
        window.isReleasedWhenClosed = false
        window.title = tab.title ?? "Cohub"
        super.init(window: window)
        window.delegate = self
        apply(edge: edge)
        if loads { load(path) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var tab: TabSession.Tab { .init(path: path, title: title, edge: edge.hex) }

    var tabs: [ShellWindow] {
        let group = window?.tabGroup?.windows.compactMap { $0.windowController as? ShellWindow } ?? []
        return group.isEmpty ? [self] : group
    }

    func place(frame: String?) {
        guard let window else { return }
        if let frame { window.setFrame(from: frame) } else if !window.setFrameUsingName("Cohub") { window.center() }
    }

    func place(cascadingFrom previous: NSWindow?) {
        guard let window, let previous else { return place(frame: nil) }
        window.setFrame(previous.frame, display: false)
        window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: previous.frame.minX, y: previous.frame.maxY)))
    }

    func load(_ path: String) {
        guard let url = shell.config.origin.url(for: path) else { return }
        self.path = path
        loadStarted = .now
        makeWebView().load(URLRequest(url: url))
    }

    func refresh() {
        guard let webView else { return }
        if window?.isVisible == true { webView.reload() } else { stale = true }
    }

    private func makeWebView() -> WKWebView {
        if let webView { return webView }
        let messages = ScriptMessageProxy()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        configuration.userContentController.add(messages, contentWorld: .page, name: HostProtocol.global)
        if let files = shell.workspaceFiles {
            configuration.setURLSchemeHandler(WorkspaceSchemeHandler(files: files, origin: shell.config.origin.origin), forURLScheme: WorkspaceFiles.scheme)
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.alphaValue = 0
        if #available(macOS 13.3, *) { webView.isInspectable = shell.config.isDevelopment }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = edge
        self.webView = webView
        window?.contentView = webView
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
        title = TabSession.title(documentTitle)
        window?.title = title ?? "Cohub"
        shell.sessionChanged()
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

    func apply(edge color: NSColor) {
        edge = color
        window?.backgroundColor = color
        webView?.underPageBackgroundColor = color
        shell.sessionChanged()
    }

    func update(dirty: Bool?, attention: Bool, capturesKeys: Bool?) {
        if let dirty { self.dirty = dirty }
        if let capturesKeys { (window as? TabWindow)?.capturesKeys = capturesKeys }
        if attention, window?.isKeyWindow != true { showAttention(true) }
    }

    private func showAttention(_ shown: Bool) {
        guard let tab = window?.tab, (tab.accessoryView != nil) != shown else { return }
        tab.accessoryView = shown ? AttentionDot() : nil
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
              "\(origin.protocol)://\(origin.host)\(origin.port == 0 ? "" : ":\(origin.port)")" == shell.config.origin.origin,
              let text = message.body as? String
        else { return }
        router?.receive(text)
    }

    func deliver(_ text: String) {
        webView?.callAsyncJavaScript("window.__cohubHostReceive?.(data)", arguments: ["data": text], in: nil, in: .page, completionHandler: nil)
    }

    func share(_ text: String) {
        guard let webView else { return }
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

    private func confirmDiscard(_ message: String) async -> Bool {
        showWindow(nil)
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = L("Your changes will be lost.")
        alert.addButton(withTitle: L("Close"))
        alert.addButton(withTitle: L("Cancel"))
        guard let window else { return alert.runModal() == .alertFirstButtonReturn }
        return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
    }

    @objc func reloadPage(_ sender: Any?) { webView?.reload() }
    @objc func navigateBack(_ sender: Any?) { webView?.goBack() }
    @objc func navigateForward(_ sender: Any?) { webView?.goForward() }
    @objc func zoomIn(_ sender: Any?) { if let webView { webView.pageZoom = min(webView.pageZoom + 0.1, 3) } }
    @objc func zoomOut(_ sender: Any?) { if let webView { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) } }
    @objc func actualSize(_ sender: Any?) { webView?.pageZoom = 1 }
    @objc func closeTab(_ sender: Any?) { window?.performClose(sender) }

    @objc func closeWindow(_ sender: Any?) {
        let group = tabs
        Task {
            if group.contains(where: \.dirty), !(await confirmDiscard(L("Some tabs have unsaved changes"))) { return }
            let kept = shell.isOnlyWindow(group) ? self : nil
            for tab in group where tab !== kept { tab.window?.close() }
            kept?.park()
        }
    }

    private func park() {
        parked = true
        window?.orderOut(nil)
    }

    @objc func selectTab(_ sender: NSMenuItem) {
        let group = tabs
        if let target = TabOrder.numbered(sender.tag, count: group.count) { group[target].showWindow(nil) }
    }

    override func newWindowForTab(_ sender: Any?) {
        shell.openTab(.init(path: "/"), beside: self, at: tabs.count)
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(navigateBack(_:)): webView?.canGoBack == true
        case #selector(navigateForward(_:)): webView?.canGoForward == true
        case #selector(actualSize(_:)): webView.map { $0.pageZoom != 1 } ?? false
        default: true
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        parked = false
        shell.activated(self)
        showAttention(false)
        if webView == nil {
            load(path)
        } else if stale {
            stale = false
            webView?.reload()
        }
    }

    func windowDidMove(_ notification: Notification) { shell.sessionChanged() }
    func windowDidResize(_ notification: Notification) { shell.sessionChanged() }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if shell.isLastWindow(self) {
            park()
            return false
        }
        guard dirty else {
            shell.willClose(self)
            return true
        }
        Task {
            guard await confirmDiscard(L("This tab has unsaved changes")) else { return }
            shell.willClose(self)
            sender.close()
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        observations = []
        shell.closed(self)
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
            shell.openTab(.init(path: path), beside: self, background: background)
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
        (window as? TabWindow)?.capturesKeys = false
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
            shell.openTab(.init(path: path), beside: self, background: Self.inBackground(navigationAction) ?? false)
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

final class TabWindow: NSWindow {
    var capturesKeys = false

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        ShellKeys.perform(event, capturing: capturesKeys) || super.performKeyEquivalent(with: event)
    }
}

private final class AttentionDot: NSView {
    override var intrinsicContentSize: NSSize { NSSize(width: 8, height: 8) }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlAccentColor.setFill()
        NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5)).fill()
    }
}

@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShellWindow?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}
