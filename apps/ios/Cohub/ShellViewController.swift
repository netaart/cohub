import CohubCore
import Network
import UIKit
import WebKit

final class ShellViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    static let revealTimeout: Duration = .milliseconds(2_500)
    static let slowTimeout: Duration = .seconds(8)

    private let shell: Shell
    private let startPath: String
    private let cover = LaunchCover()
    private var webView: WKWebView!
    private var router: BridgeRouter!
    private(set) lazy var files = FileSaver(host: self, webView: webView, origin: shell.config.origin, api: shell.config.api, auth: shell.auth)
    private let dialogs = PageDialogs()
    private var edge: RGB
    private var observation: NSKeyValueObservation?
    private var loadStarted: ContinuousClock.Instant? = .now
    private var needsReload = false
    private var foreground = true
    private var committed = false
    private var revealDue = false
    private var coverClock: Task<Void, Never>?
    private var crashedBeforeReady = false
    private var retryPath: String
    private var network: NWPathMonitor?
    private var networkReported = false

    init(shell: Shell, path: String, dark: Bool) {
        self.shell = shell
        startPath = path
        retryPath = path
        edge = ShellState.edge(dark: dark) ?? (dark ? RGB(0x10, 0x12, 0x13) : RGB(0xFF, 0xFF, 0xFF))
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        cover.superview != nil ? .default : edge.isDark ? .lightContent : .darkContent
    }

    override func loadView() {
        let view = UIView()
        view.backgroundColor = UIColor(edge)
        let webView = makeWebView()
        webView.frame = view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(webView)
        cover.frame = view.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.onAction = { [weak self] in self?.retry() }
        view.addSubview(cover)
        self.view = view
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        holdCover()
        load(startPath)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            let dark = self.traitCollection.userInterfaceStyle == .dark
            if let stored = ShellState.edge(dark: dark) { self.paint(stored) }
        }
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(source: BridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let messages = ScriptMessageProxy()
        messages.target = self
        configuration.userContentController.add(messages, contentWorld: .page, name: HostProtocol.global)
        configuration.setURLSchemeHandler(ShareSchemeHandler(inbox: shell.inbox, origin: shell.config.origin.origin), forURLScheme: HostProtocol.shareScheme)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(edge)
        webView.underPageBackgroundColor = UIColor(edge)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsLinkPreview = false
        webView.isInspectable = shell.config.isDevelopment
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observation = webView.observe(\.url) { [weak self] webView, _ in
            MainActor.assumeIsolated { self?.navigated(to: webView.url) }
        }
        self.webView = webView
        router = HostBridge.router(for: self, shell: shell)
        return webView
    }

    func load(_ path: String) {
        guard let url = shell.config.origin.url(for: path) else { return }
        dialogs.cancel()
        needsReload = false
        if cover.failure != nil { holdCover() }
        retryPath = path
        webView.load(URLRequest(url: url))
    }

    func appReady() {
        crashedBeforeReady = false
        if let started = loadStarted {
            loadStarted = nil
            logger.info("First screen in \(Int((ContinuousClock.now - started) / .milliseconds(1))) ms")
        }
        lift()
    }

    private func holdCover() {
        committed = false
        revealDue = false
        watchNetwork(false)
        present()
        cover.state = .loading
        coverClock?.cancel()
        coverClock = Task { [weak self] in
            try? await Task.sleep(for: Self.revealTimeout)
            guard let self, !Task.isCancelled else { return }
            self.revealDue = true
            if self.committed { self.lift() }
            try? await Task.sleep(for: Self.slowTimeout - Self.revealTimeout)
            if !Task.isCancelled { self.cover.state = .slow }
        }
    }

    private func present() {
        cover.hold()
        guard cover.superview == nil else { return }
        cover.frame = view.bounds
        view.addSubview(cover)
        setNeedsStatusBarAppearanceUpdate()
    }

    private func lift() {
        coverClock?.cancel()
        watchNetwork(false)
        guard cover.superview != nil else { return }
        cover.lift { [weak self] in
            self?.cover.removeFromSuperview()
            self?.setNeedsStatusBarAppearanceUpdate()
        }
    }

    private func failed(_ error: Error) {
        guard let failure = LaunchFailure(error) else { return }
        // WebKit keeps a page that is on screen; only an empty surface needs the cover.
        guard cover.superview != nil, !cover.lifting else { return Toast.show(L("Can't reach Cohub"), in: view) }
        let path = (error as? URLError)?.failingURL.flatMap(shell.config.origin.path(of:))
        fail(failure, path: path ?? retryPath)
    }

    private func fail(_ failure: LaunchFailure, path: String) {
        coverClock?.cancel()
        retryPath = path
        present()
        cover.state = .failed(failure)
        UIAccessibility.post(notification: .screenChanged, argument: cover)
        watchNetwork(failure == .offline)
    }

    private func retry() {
        holdCover()
        load(retryPath)
    }

    // The first-launch cellular data prompt also returns here.
    func becameActive() {
        if cover.failure == .offline { retry() }
    }

    private func watchNetwork(_ on: Bool) {
        guard on != (network != nil) else { return }
        network?.cancel()
        network = nil
        networkReported = false
        guard on else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            MainActor.assumeIsolated { self?.networkChanged(satisfied) }
        }
        monitor.start(queue: .main)
        network = monitor
    }

    private func networkChanged(_ satisfied: Bool) {
        let changed = networkReported
        networkReported = true
        if satisfied, changed { retry() }
    }

    func apply(edge: RGB) {
        ShellState.setEdge(edge, dark: traitCollection.userInterfaceStyle == .dark)
        paint(edge)
    }

    private func paint(_ edge: RGB) {
        guard edge != self.edge else { return }
        self.edge = edge
        let color = UIColor(edge)
        view.backgroundColor = color
        webView.backgroundColor = color
        webView.underPageBackgroundColor = color
        setNeedsStatusBarAppearanceUpdate()
    }

    private func navigated(to url: URL?) {
        guard let url, let path = shell.config.origin.path(of: url), WebOrigin.isResumable(path) else { return }
        ShellState.lastPage = path
    }

    func enteredForeground() {
        foreground = true
        if needsReload { recover() }
        router.emit(HostProtocol.Event.appForeground)
    }

    func enteredBackground() {
        foreground = false
        router.emit(HostProtocol.Event.appBackground)
    }

    private func recover() {
        dialogs.cancel()
        needsReload = false
        retryPath = ShellState.lastPage ?? startPath
        holdCover()
        if webView.url == nil { load(ShellState.lastPage ?? startPath) } else { webView.reload() }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame,
            shell.config.origin.isOrigin(scheme: origin.protocol, host: origin.host, port: origin.port),
            let text = message.body as? String
        else { return }
        router.receive(text)
    }

    func deliver(_ text: String) {
        webView.__callAsyncJavaScript(BridgeScript.receive, arguments: ["data": text], inFrame: nil, in: .page, completionHandler: nil)
    }

    func emit(_ name: String, _ payload: JSON? = nil) {
        router.emit(name, payload)
    }

    func share(_ text: String) {
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.safeAreaInsets.top, width: 1, height: 1)
        topmost.present(sheet, animated: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        let mainFrame = action.targetFrame?.isMainFrame != false
        if mainFrame, action.shouldPerformDownload {
            if url.scheme == "https" { files.save(url: url, name: url.lastPathComponent, mimeType: nil) }
            return .cancel
        }
        return route(url, mainFrame: mainFrame) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        guard response.isForMainFrame, !response.canShowMIMEType, let url = response.response.url else { return .allow }
        if url.scheme == "https" { files.save(url: url, name: response.response.suggestedFilename ?? url.lastPathComponent, mimeType: response.response.mimeType) }
        return .cancel
    }

    private func route(_ url: URL, mainFrame: Bool = true) -> Bool {
        switch shell.config.origin.navigation(to: url, mainFrame: mainFrame) {
        case .allow: return true
        case .external(let url): UIApplication.shared.open(url)
        case .deny: break
        }
        return false
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        dialogs.cancel()
        committed = true
        if revealDue, cover.failure == nil { lift() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        logger.warning("Web content process terminated")
        dialogs.cancel()
        guard foreground else {
            needsReload = true
            return
        }
        // Reloading a page that dies again before it is back would only loop; start over from home.
        if crashedBeforeReady { return fail(.broken, path: "/") }
        crashedBeforeReady = true
        recover()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if let path = shell.config.origin.path(of: url) { load(path) } else { _ = route(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        frame.isMainFrame && shell.config.origin.isOrigin(scheme: origin.protocol, host: origin.host, port: origin.port) ? .grant : .prompt
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo) async -> WKPermissionDecision {
        frame.isMainFrame && shell.config.origin.isOrigin(scheme: origin.protocol, host: origin.host, port: origin.port) ? .grant : .prompt
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await dialog(message, from: frame, cancels: false)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await dialog(message, from: frame) != nil
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await dialog(prompt, from: frame, field: defaultText ?? "")
    }

    func cancelDialog() {
        dialogs.cancel()
    }

    private func dialog(_ message: String, from frame: WKFrameInfo, cancels: Bool = true, field: String? = nil) async -> String? {
        let origin = frame.securityOrigin
        let title = shell.config.origin.dialogTitle(scheme: origin.protocol, host: origin.host, port: origin.port)
        let alert = UIAlertController(title: title.map { $0.isEmpty ? L("An embedded page") : $0 }, message: message, preferredStyle: .alert)
        if let field { alert.addTextField { $0.text = field } }
        return await dialogs.show { answer in
            alert.addAction(UIAlertAction(title: L("OK"), style: .default) { [weak alert] _ in answer(alert?.textFields?.first?.text ?? "") })
            if cancels { alert.addAction(UIAlertAction(title: L("Cancel"), style: .cancel) { _ in answer(nil) }) }
            topmost.present(alert, animated: true)
        } dismiss: { [weak alert] in
            alert?.dismiss(animated: true)
        }
    }
}

@MainActor
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShellViewController?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}

extension UIViewController {
    var topmost: UIViewController {
        var top: UIViewController = self
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        return top
    }
}

extension UIColor {
    convenience init(_ rgb: RGB) {
        self.init(red: CGFloat(rgb.red) / 255, green: CGFloat(rgb.green) / 255, blue: CGFloat(rgb.blue) / 255, alpha: 1)
    }
}
