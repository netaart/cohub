import AppKit
import CohubCore
import os
import ServiceManagement
import Sparkle
import WebKit

@MainActor
final class Shell: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    let config = ShellConfig.load()
    let log = Logger(subsystem: "live.cohub.desktop", category: "shell")
    private var windows: [ShellWindow] = []
    private var closedTabs = ClosedTabs()
    private var repeats = RepeatFilter()
    private var saving: Task<Void, Never>?
    private var remembersClosedTabs = true
    private var service: HostService?
    private(set) var workspaceFiles: WorkspaceFiles?
    private var updater: SPUStandardUpdaterController?
    private var notifications: Notifications?
    private var launched = false
    private var pendingPaths: [String] = []
    private lazy var shortcut = GlobalShortcut { [weak self] in self?.showPrimary() }
    private lazy var status = StatusMenu(actions: .init(
        openSpace: { [weak self] spaceId in self?.open(path: "/spaces/\(spaceId)") },
        disconnect: { [weak self] spaceId in self?.disconnect(spaceId) },
        newSpace: { [weak self] in self?.open(path: "/spaces/new") },
        stopSharing: { [weak self] in self?.stopSharing() },
        showCohub: { [weak self] in self?.showPrimary() }
    ))

    func applicationDidFinishLaunching(_ notification: Notification) {
        let bundled = Bundle.main.bundleIdentifier != nil
        let updates = ["SUFeedURL", "SUPublicEDKey"].allSatisfy { (Bundle.main.object(forInfoDictionaryKey: $0) as? String)?.isEmpty == false }
        if bundled, updates {
            updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        }
        if bundled { notifications = Notifications { [weak self] path in self?.open(path: path) } }
        NSApp.mainMenu = MainMenu.build(updater: updater.map { updater in
            let item = NSMenuItem(title: L("Check for Updates…"), action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
            item.target = updater
            return item
        })
        NSWindow.allowsAutomaticWindowTabbing = false
        startService()
        if ShellState.globalShortcut { shortcut.set(enabled: true) }
        restore(ShellState.session)
        launched = true
        for path in pendingPaths { open(path: path) }
        pendingPaths = []
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showPrimary() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allTabs.contains(where: \.dirty), !confirmQuit() { return .terminateCancel }
        remembersClosedTabs = false
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveSession()
        service?.stop()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let folder = url.isFileURL ? WebOrigin.newSpacePath(folder: url.path) : nil
            guard let path = folder ?? WebOrigin.path(fromDeepLink: url, scheme: config.urlScheme) ?? config.origin.path(of: url) else { continue }
            if launched { open(path: path) } else { pendingPaths.append(path) }
        }
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        for shortcut in ShellState.shortcuts {
            menu.addItem(ActionMenuItem(shortcut.label) { [weak self] in self?.open(path: shortcut.path) })
        }
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        menu.addItem(ActionMenuItem(L("New Window")) { [weak self] in self?.openWindow(path: "/") })
        return menu
    }

    private func restore(_ session: TabSession?) {
        guard let session, !session.windows.isEmpty else {
            openWindow(path: "/")
            return
        }
        for saved in session.windows {
            let window = ShellWindow(shell: self)
            window.place(frame: saved.frame)
            windows.append(window)
            for tab in saved.tabs { window.add(tab, selects: false, loads: false) }
            window.select(window.tabs[min(saved.selected, window.tabs.count - 1)])
            window.showWindow(nil)
        }
    }

    private var allTabs: [ShellTab] { windows.flatMap(\.tabs) }

    private func newWindow() -> ShellWindow {
        let window = ShellWindow(shell: self)
        window.place(cascadingFrom: primary?.window)
        windows.append(window)
        return window
    }

    @discardableResult
    func openWindow(path: String) -> ShellWindow {
        let window = newWindow()
        window.add(.init(path: path))
        window.showWindow(nil)
        return window
    }

    func moveToNewWindow(_ tab: ShellTab) {
        guard let from = tab.window, from.tabs.count > 1 else { return }
        let window = newWindow()
        window.adopt(tab)
        window.showWindow(nil)
    }

    func mergeAllWindows(into window: ShellWindow) {
        for other in windows where other !== window {
            // The shown tab goes last, so taking it never shows (and loads) another.
            let shown = other.selected
            for tab in other.tabs where tab !== shown { window.adopt(tab, selects: false) }
            if let shown { window.adopt(shown, selects: false) }
        }
        window.showWindow(nil)
    }

    func hasOtherWindows(than window: ShellWindow) -> Bool { windows.contains { $0 !== window } }

    func open(path: String) {
        guard WebOrigin.isInAppPath(path) else { return }
        defer { activate() }
        if let shown = allTabs.last(where: { TabSession.samePage($0.path, path) && ($0.path == path || !$0.dirty) }), let window = shown.window {
            if shown.path != path { shown.load(path) }
            window.select(shown)
            window.showWindow(nil)
        } else {
            show(.init(path: path), reusing: { $0.path == "/" })
        }
    }

    private func show(_ tab: TabSession.Tab, at index: Int? = nil, reusing reuses: (ShellTab) -> Bool = { _ in false }) {
        guard let front = primary else {
            openWindow(path: tab.path)
            return
        }
        if let shown = front.selected, reuses(shown), !shown.dirty {
            shown.load(tab.path)
        } else {
            front.add(tab, at: index)
        }
        front.showWindow(nil)
    }

    func isLastWindow(_ window: ShellWindow) -> Bool { windows.count == 1 && windows.first === window }

    var canReopenClosedTab: Bool { !closedTabs.isEmpty }

    func closed(_ tab: TabSession.Tab, at index: Int) {
        if remembersClosedTabs { closedTabs.push(tab, index: index) }
    }

    func closed(_ window: ShellWindow) {
        windows.removeAll { $0 === window }
        sessionChanged()
    }

    func activated(_ window: ShellWindow) {
        windows.removeAll { $0 === window }
        windows.append(window)
        sessionChanged()
    }

    func sessionChanged() {
        saving?.cancel()
        saving = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.saveSession()
        }
    }

    private func saveSession() {
        saving?.cancel()
        ShellState.session = TabSession(windows: windows.filter { !$0.tabs.isEmpty }.map { window in
            TabSession.Window(tabs: window.tabs.map(\.session), selected: window.selectedIndex, frame: window.window?.frameDescriptor)
        }).sanitized()
    }

    private var primary: ShellWindow? {
        windows.first { $0.window === NSApp.keyWindow } ?? windows.last { $0.window?.isVisible == true } ?? windows.last
    }

    private func showPrimary() {
        if let window = primary { window.showWindow(nil) } else { openWindow(path: "/") }
        activate()
    }

    private func activate() {
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    private func confirmQuit() -> Bool {
        let alert = NSAlert()
        alert.messageText = L("Some tabs have unsaved changes")
        alert.informativeText = L("Your changes will be lost.")
        alert.addButton(withTitle: L("Quit"))
        alert.addButton(withTitle: L("Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }

    func router(for tab: ShellTab) -> BridgeRouter {
        typealias M = HostProtocol.Method
        typealias C = HostProtocol.Capability
        var capabilities = [C.launch, C.appearance, C.navigation, C.share, C.files, C.cache, C.shortcuts, C.mediaCapture, C.permissions, C.badge, C.globalShortcut, C.tabs, C.about]
        if notifications != nil { capabilities.append(C.notifications) }
        if Bundle.main.bundleIdentifier != nil { capabilities.append(C.launchAtLogin) }
        if service != nil { capabilities.append(C.runtimePicker) }
        if workspaceFiles != nil { capabilities.append(C.workspaceFiles) }
        var handlers: [String: BridgeRouter.Handler] = [
            M.appReady: { [weak tab] _ in tab?.reveal(); return true },
            M.appAbout: { [weak self] params in
                Task { await AboutPanel.show(service: self?.service, web: params["web"]?.string) }
                return true
            },
            M.appearanceSet: { [weak tab] params in
                guard let color = params["backgroundColor"]?.string.flatMap(RGB.init(hex:)) else { throw BridgeFailure.failed("appearance.set requires a #rrggbb backgroundColor") }
                ShellState.edgeColor = color
                tab?.apply(edge: color)
                return true
            },
            M.navigationOpenPath: { [weak tab] params in
                guard let path = params["path"]?.string, WebOrigin.isInAppPath(path) else { throw BridgeFailure.failed("navigation.openPath requires an in-app path") }
                tab?.load(path)
                return true
            },
            M.tabsUpdate: { [weak tab] params in
                tab?.update(dirty: params["dirty"]?.bool, attention: params["attention"]?.bool == true, capturesKeys: params["captureKeys"]?.bool)
                return true
            },
            M.shareText: { [weak tab] params in
                guard let text = params["text"]?.string else { throw BridgeFailure.failed("share.text requires text") }
                tab?.share(text)
                return true
            },
            M.filesSave: { [weak tab] params in
                try await Downloads.save(params) { [weak tab] payload in tab?.emit(HostProtocol.Event.filesProgress, payload) }
            },
            M.filesReveal: { params in .bool(Downloads.reveal(params)) },
            M.permissionsStatus: { [weak self] _ in await HostPermissions.status(notifications: self?.notifications) },
            M.permissionsRequest: { [weak self] params in try await HostPermissions.request(params["kind"]?.string, notifications: self?.notifications) },
            M.permissionsOpenSettings: { params in .bool(Permissions.openSettings(params["kind"]?.string)) },
            M.displayOpenControlSettings: { _ in .bool(Permissions.openSettings("control")) },
            M.badgeSet: { params in
                let count = params["count"]?.number ?? 0
                NSApp.dockTile.badgeLabel = count > 0 ? String(Int(count)) : nil
                return true
            },
            M.globalShortcut: { [weak self] params in
                guard let self else { return false }
                if let enabled = params["enabled"]?.bool {
                    ShellState.globalShortcut = enabled
                    self.shortcut.set(enabled: enabled)
                }
                return .bool(ShellState.globalShortcut)
            },
            M.launchAtLogin: { params in
                if let enabled = params["enabled"]?.bool {
                    do { try Permissions.setLaunchAtLogin(enabled) }
                    catch { throw BridgeFailure.failed(error.localizedDescription) }
                }
                return .bool(SMAppService.mainApp.status == .enabled)
            },
            M.cacheClear: { _ in
                await WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast)
                return true
            },
            M.shortcutsPush: { params in
                guard let shortcut = HostShortcut(params) else { throw BridgeFailure.failed("shortcuts.push requires an id, a label and an in-app path") }
                ShellState.shortcuts = shortcut.pushed(onto: ShellState.shortcuts, limit: 5)
                return true
            },
        ]
        if let notifications {
            handlers[M.notificationsRegister] = { _ in .bool(await notifications.register()) }
            handlers[M.notificationsShow] = { [weak self] params in
                let key = ["id", "title", "body"].map { params[$0]?.string ?? "" }.joined(separator: "\n")
                if self?.repeats.admits(key) == false { return true }
                return .bool(try await notifications.show(params))
            }
        }
        if let service {
            handlers[M.runtimePickFolder] = { [weak tab] params in
                guard let tab else { throw BridgeFailure.canceled() }
                return try await tab.pickFolder(service: service, handedOver: params["path"]?.string)
            }
        }
        return BridgeRouter(
            platform: "macos",
            hostId: ShellState.hostId,
            capabilities: capabilities,
            handlers: handlers,
            service: service,
            consent: { [weak tab] request in
                switch request {
                case .folder(let root): return await tab?.confirmConnect(root: root) ?? false
                case .screen: return await tab?.confirmShare() ?? false
                }
            },
            send: { [weak tab] text in tab?.deliver(text) }
        )
    }

    private func startService() {
        guard let launch = config.service else {
            log.notice("No Cohub CLI bundled; the page signs in on its own")
            return
        }
        let log = self.log
        let service = HostService(
            launch: launch,
            known: ShellState.serviceHello,
            onEvent: { name, payload in Task { @MainActor in self.serviceEvent(name, payload) } },
            onHello: { hello in
                Task { @MainActor in
                    ShellState.serviceHello = hello
                    for tab in self.allTabs { tab.serviceStarted() }
                }
            },
            log: { line in log.info("\(line, privacy: .public)") }
        )
        self.service = service
        workspaceFiles = WorkspaceFiles(service: service)
        service.start()
    }

    private func serviceEvent(_ name: String, _ payload: JSON?) {
        switch name {
        case HostProtocol.ShellEvent.open:
            if let link = payload?["url"]?.string, let url = URL(string: link), ["https", "http"].contains(url.scheme?.lowercased()) {
                NSWorkspace.shared.open(url)
            }
            return
        case HostProtocol.Event.runtimeChanged:
            if let payload, let overview = RuntimeOverview(payload) { status.update(overview) }
        case HostProtocol.Event.displayChanged:
            status.update(sharing: payload?["sharedWith"]?.string != nil)
        case HostProtocol.Event.authChanged:
            accountChanged(payload)
        default:
            break
        }
        for tab in allTabs { tab.emit(name, payload) }
    }

    private func accountChanged(_ payload: JSON?) {
        let authenticated = payload?["authenticated"]?.bool ?? false
        let redirect = payload?["redirectPath"]?.string.flatMap { WebOrigin.isInAppPath($0) ? $0 : nil }
        let front = primary
        if !authenticated {
            closedTabs.removeAll()
            remembersClosedTabs = false
            for window in windows where window !== front { window.discard() }
            if let front, let kept = front.selected {
                for tab in front.tabs where tab !== kept { front.remove(tab) }
                kept.load("/")
            }
            remembersClosedTabs = true
            sessionChanged()
            return
        }
        for tab in allTabs {
            if tab === front?.selected, let redirect { tab.load(redirect) } else { tab.refresh() }
        }
        if redirect != nil { showPrimary() }
    }

    private func disconnect(_ spaceId: String, force: Bool = false) {
        guard let service else { return }
        Task {
            var params: [String: JSON] = ["spaceId": .string(spaceId)]
            if force { params["force"] = .bool(true) }
            switch await service.call(BridgeRequest(id: "stop", method: HostProtocol.Method.runtimeStop, params: .object(params))) {
            case .result(let runtime):
                guard runtime["refused"]?.string != nil else { return }
                let alert = NSAlert()
                alert.messageText = L("A task’s result hasn’t been confirmed yet")
                alert.informativeText = L("Disconnecting stops the Runtime. Results and files are kept.")
                alert.addButton(withTitle: L("Disconnect"))
                alert.addButton(withTitle: L("Cancel"))
                if alert.runModal() == .alertFirstButtonReturn { disconnect(spaceId, force: true) }
            case .failure(let failure):
                let alert = NSAlert()
                alert.messageText = L("Couldn’t disconnect this folder")
                alert.informativeText = failure.message
                alert.runModal()
            }
        }
    }

    private func stopSharing() {
        guard let service else { return }
        Task { _ = await service.call(BridgeRequest(id: "stop", method: HostProtocol.Method.displayStop)) }
    }

    @objc func newTab(_ sender: Any?) {
        show(.init(path: "/"))
        activate()
    }

    @objc func newWindow(_ sender: Any?) {
        openWindow(path: "/")
        activate()
    }

    @objc func reopenClosedTab(_ sender: Any?) {
        guard let entry = closedTabs.pop() else { return }
        show(entry.tab, at: entry.index)
        activate()
    }

    @objc func newSpace(_ sender: Any?) {
        open(path: "/spaces/new")
    }

    @objc func openSettings(_ sender: Any?) {
        open(path: "/settings/general")
    }

    @objc func installCommandLineTool(_ sender: Any?) {
        CommandLineTool.install(config.commandLineTool)
    }

    @objc func showAbout(_ sender: Any?) {
        Task { await AboutPanel.show(service: service) }
    }

    @objc func openHelp(_ sender: Any?) {
        if let url = config.origin.url(for: "/docs") { NSWorkspace.shared.open(url) }
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        item.action == #selector(reopenClosedTab(_:)) ? !closedTabs.isEmpty : true
    }
}

@main
enum CohubApp {
    @MainActor
    static func main() {
        // A write to an exited CLI must fail the call, not end the app.
        signal(SIGPIPE, SIG_IGN)
        let app = NSApplication.shared
        let shell = Shell()
        app.delegate = shell
        app.setActivationPolicy(.regular)
        app.run()
    }
}
