import AppKit
import CohubCore
import os
import ServiceManagement
import Sparkle
import WebKit

@MainActor
final class Shell: NSObject, NSApplicationDelegate {
    let config = ShellConfig.load()
    private let log = Logger(subsystem: "live.cohub.desktop", category: "shell")
    private var windows: [ShellWindow] = []
    private var service: HostService?
    private var updater: SPUStandardUpdaterController?
    private var notifications: Notifications?
    private var launched = false
    private var pendingPath: String?
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
        if bundled, Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil {
            updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        }
        if bundled { notifications = Notifications { [weak self] path in self?.open(path: path) } }
        NSApp.mainMenu = MainMenu.build(updater: updater.map { updater in
            let item = NSMenuItem(title: L("Check for Updates…"), action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
            item.target = updater
            return item
        })
        startService()
        if ShellState.globalShortcut { shortcut.set(enabled: true) }
        openWindow(path: pendingPath ?? ShellState.lastPath ?? "/")
        pendingPath = nil
        launched = true
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showPrimary() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        service?.stop()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let folder = url.isFileURL ? WebOrigin.newSpacePath(folder: url.path) : nil
            guard let path = folder ?? WebOrigin.path(fromDeepLink: url, scheme: config.urlScheme) ?? config.origin.path(of: url) else { continue }
            if launched { open(path: path) } else { pendingPath = path }
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

    @discardableResult
    func openWindow(path: String, tabbedWith tab: NSWindow? = nil) -> ShellWindow {
        let window = ShellWindow(shell: self, path: path, cascadeFrom: windows.isEmpty ? nil : (tab ?? NSApp.keyWindow ?? windows.last?.window))
        windows.append(window)
        if let tab, let added = window.window { tab.addTabbedWindow(added, ordered: .above) }
        window.showWindow(nil)
        return window
    }

    func open(path: String) {
        guard WebOrigin.isInAppPath(path) else { return }
        if let window = primary {
            window.load(path)
            window.showWindow(nil)
        } else {
            openWindow(path: path)
        }
        activate()
    }

    func isLastWindow(_ window: ShellWindow) -> Bool { windows.count == 1 && windows.first === window }

    func closed(_ window: ShellWindow) {
        windows.removeAll { $0 === window }
    }

    func navigated(to path: String) {
        ShellState.lastPath = path
    }

    private var primary: ShellWindow? {
        windows.first { $0.window === NSApp.keyWindow } ?? windows.first { $0.window?.isVisible == true } ?? windows.first
    }

    private func showPrimary() {
        if let window = primary { window.showWindow(nil) } else { openWindow(path: ShellState.lastPath ?? "/") }
        activate()
    }

    private func activate() {
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    func router(for window: ShellWindow) -> BridgeRouter {
        typealias M = HostProtocol.Method
        typealias C = HostProtocol.Capability
        var capabilities = [C.launch, C.appearance, C.navigation, C.share, C.files, C.cache, C.shortcuts, C.mediaCapture, C.permissions, C.badge, C.globalShortcut]
        if notifications != nil { capabilities.append(C.notifications) }
        if Bundle.main.bundleIdentifier != nil { capabilities.append(C.launchAtLogin) }
        if service != nil { capabilities.append(C.runtimePicker) }
        var handlers: [String: BridgeRouter.Handler] = [
            M.appReady: { [weak window] _ in window?.reveal(); return true },
            M.appearanceSet: { [weak window] params in
                guard let color = params["backgroundColor"]?.string.flatMap(NSColor.init(hex:)) else { throw BridgeFailure.failed("appearance.set requires a #rrggbb backgroundColor") }
                ShellState.edgeColor = color
                window?.apply(edge: color)
                return true
            },
            M.navigationOpenPath: { [weak window] params in
                guard let path = params["path"]?.string, WebOrigin.isInAppPath(path) else { throw BridgeFailure.failed("navigation.openPath requires an in-app path") }
                window?.load(path)
                return true
            },
            M.shareText: { [weak window] params in
                guard let text = params["text"]?.string else { throw BridgeFailure.failed("share.text requires text") }
                window?.share(text)
                return true
            },
            M.filesSave: { params in try await Downloads.save(params); return true },
            M.permissionsStatus: { [weak self] _ in await Permissions.status(notifications: self?.notifications) },
            M.permissionsRequest: { [weak self] params in try await Permissions.request(params["kind"]?.string, notifications: self?.notifications) },
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
                guard let id = params["id"]?.string, let label = params["label"]?.string, let path = params["path"]?.string, WebOrigin.isInAppPath(path) else {
                    throw BridgeFailure.failed("shortcuts.push requires an id, a label and an in-app path")
                }
                ShellState.shortcuts = [.init(id: id, label: label, path: path)] + ShellState.shortcuts.filter { $0.id != id }
                return true
            },
        ]
        if let notifications {
            handlers[M.notificationsRegister] = { _ in .bool(await notifications.register()) }
            handlers[M.notificationsShow] = { params in .bool(try await notifications.show(params)) }
        }
        if let service {
            handlers[M.runtimePickFolder] = { [weak window] params in
                guard let window else { throw BridgeFailure.canceled() }
                return try await window.pickFolder(service: service, handedOver: params["path"]?.string)
            }
        }
        return BridgeRouter(
            platform: "macos",
            hostId: ShellState.hostId,
            capabilities: capabilities,
            handlers: handlers,
            service: service,
            consent: { [weak window] request in
                switch request {
                case .folder(let root): return await window?.confirmConnect(root: root) ?? false
                case .screen: return await window?.confirmShare() ?? false
                }
            },
            send: { [weak window] text in window?.deliver(text) }
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
                    for window in self.windows { window.serviceStarted() }
                }
            },
            log: { line in log.info("\(line, privacy: .public)") }
        )
        self.service = service
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
        for window in windows { window.emit(name, payload) }
    }

    private func accountChanged(_ payload: JSON?) {
        let authenticated = payload?["authenticated"]?.bool ?? false
        let redirect = payload?["redirectPath"]?.string.flatMap { WebOrigin.isInAppPath($0) ? $0 : nil }
        if !authenticated { ShellState.lastPath = nil }
        let front = primary
        for window in windows {
            if !authenticated { window.load("/") } else if window === front, let redirect { window.load(redirect) } else { window.webView.reload() }
        }
        if authenticated, redirect != nil { showPrimary() }
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

    @objc func newWindow(_ sender: Any?) {
        openWindow(path: "/")
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

    @objc func openHelp(_ sender: Any?) {
        if let url = config.origin.url(for: "/docs") { NSWorkspace.shared.open(url) }
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
