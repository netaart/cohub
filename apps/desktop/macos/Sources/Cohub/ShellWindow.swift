import AppKit
import CohubCore
import WebKit

@MainActor
final class ShellWindow: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
    private unowned let shell: Shell
    private(set) var tabs: [ShellTab] = []
    private(set) var selected: ShellTab?
    private let strip = TabStrip()
    private let pages = PageStack()
    private var palette: EdgePalette?

    init(shell: Shell) {
        self.shell = shell
        let window = TabWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: true
        )
        window.minSize = NSSize(width: 480, height: 360)
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.titleVisibility = .hidden
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.title = "Cohub"
        window.contentView = WindowContent(strip: strip, pages: pages)
        super.init(window: window)
        window.delegate = self
        strip.owner = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var selectedIndex: Int { selected.flatMap { shown in tabs.firstIndex { $0 === shown } } ?? 0 }

    private var order: [(id: ObjectIdentifier, opener: ObjectIdentifier?)] {
        tabs.map { tab in (id: ObjectIdentifier(tab), opener: tab.opener.map { ObjectIdentifier($0) }) }
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

    @discardableResult
    func add(_ session: TabSession.Tab, at index: Int? = nil, selects: Bool = true, loads: Bool = true, opener: ShellTab? = nil) -> ShellTab {
        let tab = ShellTab(shell: shell, window: self, tab: session)
        tab.opener = opener
        tabs.insert(tab, at: min(max(index ?? tabs.count, 0), tabs.count))
        if selects {
            select(tab)
        } else {
            if loads { tab.load(tab.path) }
            tabsChanged()
        }
        return tab
    }

    func open(_ session: TabSession.Tab, beside anchor: ShellTab, background: Bool) {
        add(session, at: TabOrder.insertion(after: ObjectIdentifier(anchor), in: order), selects: !background, opener: anchor)
    }

    func newTab() {
        add(.init(path: "/"))
    }

    func select(_ tab: ShellTab) {
        if let previous = selected, previous !== tab {
            if tab.opener !== previous { tab.opener = nil }
            previous.hide()
        }
        selected = tab
        tab.show()
        if let webView = tab.webView { window?.makeFirstResponder(webView) }
        tabsChanged()
    }

    func move(_ tab: ShellTab, to index: Int) {
        guard let from = tabs.firstIndex(where: { $0 === tab }) else { return }
        tabs.remove(at: from)
        tabs.insert(tab, at: min(max(index, 0), tabs.count))
        tabsChanged()
    }

    func adopt(_ tab: ShellTab, selects: Bool = true) {
        guard let from = tab.window, from !== self else { return }
        from.detach(tab)
        tab.window = self
        tab.opener = nil
        tabs.append(tab)
        if let webView = tab.webView { host(webView) }
        if selects { select(tab) } else { tabsChanged() }
        if from.tabs.isEmpty { from.discard() }
    }

    func host(_ view: NSView) {
        if view.superview !== pages { pages.addSubview(view) }
        view.frame = pages.bounds
    }

    func close(_ tab: ShellTab) {
        if tabs.count == 1, shell.isLastWindow(self) { return park() }
        whenDiscarded(tab.dirty, L("This tab has unsaved changes")) { [weak self] in self?.remove(tab) }
    }

    func closeOthers(_ kept: ShellTab) {
        let others = tabs.filter { $0 !== kept }
        whenDiscarded(others.contains(where: \.dirty), L("Some tabs have unsaved changes")) { [weak self] in
            guard let self, kept.window === self else { return }
            select(kept)
            for tab in others { remove(tab) }
        }
    }

    func remove(_ tab: ShellTab) {
        guard let index = tabs.firstIndex(where: { $0 === tab }) else { return }
        shell.closed(tab.session, at: index)
        detach(tab)
        tab.close()
        if tabs.isEmpty { discard() }
    }

    private func detach(_ tab: ShellTab) {
        let successor = TabOrder.successor(of: ObjectIdentifier(tab), selected: selected.map { ObjectIdentifier($0) }, in: order)
        tabs.removeAll { $0 === tab }
        for other in tabs where other.opener === tab { other.opener = nil }
        guard selected === tab else { return tabsChanged() }
        selected = nil
        tab.hide()
        if let next = tabs.first(where: { ObjectIdentifier($0) == successor }) { select(next) } else { tabsChanged() }
    }

    func tabChanged(_ tab: ShellTab) {
        tabsChanged()
    }

    private func tabsChanged() {
        updateChrome()
        shell.sessionChanged()
    }

    private func updateChrome() {
        let edge = selected?.edge ?? ShellState.edgeColor ?? .window
        let palette = self.palette.flatMap { $0.edge == edge ? $0 : nil } ?? apply(EdgePalette(edge: edge))
        window?.title = selected?.title ?? "Cohub"
        strip.update(tabs: tabs, selected: selected, palette: palette)
    }

    private func apply(_ palette: EdgePalette) -> EdgePalette {
        self.palette = palette
        window?.appearance = NSAppearance(named: palette.dark ? .darkAqua : .aqua)
        window?.backgroundColor = NSColor(palette.edge)
        pages.layer?.backgroundColor = NSColor(palette.edge).cgColor
        return palette
    }

    func menu(for tab: ShellTab) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let several = tabs.count > 1
        let add = { (title: String, enabled: Bool, action: @escaping @MainActor () -> Void) in
            let item = ActionMenuItem(title, handler: action)
            item.isEnabled = enabled
            menu.addItem(item)
        }
        add(L("New Tab"), true) { [weak self] in self?.newTab() }
        add(L("Duplicate Tab"), true) { [weak self, weak tab] in
            if let self, let tab { self.open(tab.session, beside: tab, background: false) }
        }
        add(L("Move Tab to New Window"), several) { [weak self, weak tab] in
            if let tab { self?.shell.moveToNewWindow(tab) }
        }
        menu.addItem(.separator())
        add(L("Close Tab"), true) { [weak self, weak tab] in
            if let tab { self?.close(tab) }
        }
        add(L("Close Other Tabs"), several) { [weak self, weak tab] in
            if let tab { self?.closeOthers(tab) }
        }
        add(L("Reopen Closed Tab"), shell.canReopenClosedTab) { [weak self] in self?.shell.reopenClosedTab(nil) }
        return menu
    }

    private func whenDiscarded(_ asks: Bool, _ message: String, _ action: @escaping @MainActor () -> Void) {
        guard asks else { return action() }
        Task {
            if await confirmDiscard(message) { action() }
        }
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

    private func closesNow() -> Bool {
        if shell.isLastWindow(self) {
            park()
            return false
        }
        guard tabs.contains(where: \.dirty) else {
            rememberTabs()
            return true
        }
        whenDiscarded(true, L("Some tabs have unsaved changes")) { [weak self] in
            self?.rememberTabs()
            self?.discard()
        }
        return false
    }

    private func rememberTabs() {
        for (index, tab) in tabs.enumerated() { shell.closed(tab.session, at: index) }
    }

    func discard() {
        window?.close()
    }

    private func park() {
        window?.orderOut(nil)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { closesNow() }

    func windowWillClose(_ notification: Notification) {
        for tab in tabs { tab.close() }
        tabs = []
        selected = nil
        shell.closed(self)
    }

    func windowDidBecomeKey(_ notification: Notification) {
        shell.activated(self)
        selected?.show()
        updateChrome()
    }

    func windowDidMove(_ notification: Notification) { shell.sessionChanged() }
    func windowDidResize(_ notification: Notification) { shell.sessionChanged() }
    func windowDidEnterFullScreen(_ notification: Notification) { window?.contentView?.needsLayout = true }
    func windowDidExitFullScreen(_ notification: Notification) { window?.contentView?.needsLayout = true }

    @objc func reloadPage(_ sender: Any?) { selected?.webView?.reload() }
    @objc func navigateBack(_ sender: Any?) { selected?.webView?.goBack() }
    @objc func navigateForward(_ sender: Any?) { selected?.webView?.goForward() }
    @objc func zoomIn(_ sender: Any?) { if let webView = selected?.webView { webView.pageZoom = min(webView.pageZoom + 0.1, 3) } }
    @objc func zoomOut(_ sender: Any?) { if let webView = selected?.webView { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) } }
    @objc func actualSize(_ sender: Any?) { selected?.webView?.pageZoom = 1 }
    @objc func closeTab(_ sender: Any?) { if let selected { close(selected) } }
    @objc func closeWindow(_ sender: Any?) { if closesNow() { discard() } }
    @objc func nextTab(_ sender: Any?) { step(.next) }
    @objc func previousTab(_ sender: Any?) { step(.previous) }
    @objc func moveTabToNewWindow(_ sender: Any?) { if let selected { shell.moveToNewWindow(selected) } }
    @objc func mergeAllWindows(_ sender: Any?) { shell.mergeAllWindows(into: self) }

    @objc func selectTab(_ sender: NSMenuItem) {
        if let index = TabOrder.numbered(sender.tag, count: tabs.count) { select(tabs[index]) }
    }

    private func step(_ move: TabMove) {
        if let index = TabOrder.target(move, selected: selectedIndex, count: tabs.count) { select(tabs[index]) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(navigateBack(_:)): selected?.webView?.canGoBack == true
        case #selector(navigateForward(_:)): selected?.webView?.canGoForward == true
        case #selector(actualSize(_:)): selected?.webView.map { $0.pageZoom != 1 } ?? false
        case #selector(moveTabToNewWindow(_:)): tabs.count > 1
        case #selector(mergeAllWindows(_:)): shell.hasOtherWindows(than: self)
        default: true
        }
    }
}

final class TabWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let capturing = (windowController as? ShellWindow)?.selected?.capturesKeys == true
        return ShellKeys.perform(event, capturing: capturing) || super.performKeyEquivalent(with: event)
    }
}

private final class WindowContent: NSView {
    private let strip: TabStrip
    private let pages: PageStack

    init(strip: TabStrip, pages: PageStack) {
        self.strip = strip
        self.pages = pages
        super.init(frame: .zero)
        addSubview(pages)
        addSubview(strip)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidMoveToWindow() { arrange() }
    override func resizeSubviews(withOldSize oldSize: NSSize) { arrange() }
    override func layout() {
        super.layout()
        arrange()
    }

    private func arrange() {
        guard let window else { return }
        let fullScreen = window.styleMask.contains(.fullScreen)
        let titlebar = bounds.height - window.contentLayoutRect.maxY
        let height = fullScreen || titlebar < TabStrip.minimumHeight ? TabStrip.minimumHeight : titlebar
        let buttons = window.standardWindowButton(.zoomButton).map { $0.convert($0.bounds, to: nil).maxX }
        strip.leading = fullScreen ? 8 : (buttons ?? 70) + 10
        strip.frame = NSRect(x: 0, y: bounds.height - height, width: bounds.width, height: height)
        pages.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(bounds.height - height, 0))
    }
}

private final class PageStack: NSView {
    init() {
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        for view in subviews where !view.isHidden { view.frame = bounds }
    }
}
