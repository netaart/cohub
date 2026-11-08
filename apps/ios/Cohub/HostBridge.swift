import CohubCore
import UIKit

@MainActor
enum HostBridge {
    typealias M = HostProtocol.Method
    typealias C = HostProtocol.Capability

    static let capabilities = [
        C.authToken, C.authSignIn, C.authSession, C.launch, C.appearance, C.navigation, C.share, C.shareIncoming,
        C.files, C.haptics, C.shortcuts, C.mediaCapture, C.permissions, C.about,
    ]

    static func router(for surface: ShellViewController, shell: Shell) -> BridgeRouter {
        let auth = shell.auth
        let handlers: [String: BridgeRouter.Handler] = [
            M.authGetAccessToken: { params in
                let token = await auth.accessToken(forceRefresh: params["forceRefresh"]?.bool == true)
                return token.map(JSON.string) ?? .null
            },
            M.authGetSessionVersion: { _ in .number(Double(await auth.version)) },
            M.authGetSession: { _ in
                let signedIn = await auth.signedIn
                let subject = await auth.subject
                return ["authenticated": .bool(signedIn), "userUuid": .null, "subject": subject.map(JSON.string) ?? .null, "email": .null]
            },
            M.authSignIn: { params in
                shell.signIn(redirectPath: params["redirectPath"]?.string)
                return true
            },
            M.authSignOut: { [weak surface] _ in
                await shell.signOut()
                surface?.emit(HostProtocol.Event.authSignedOut)
                return true
            },
            M.appReady: { [weak surface] _ in
                surface?.reveal()
                if await auth.signedIn { QuickActions.refresh(signedIn: true) }
                return true
            },
            M.appearanceSet: { [weak surface] params in
                guard let color = params["backgroundColor"]?.string.flatMap(RGB.init(hex:)) else { throw BridgeFailure.failed("appearance.set requires a #rrggbb backgroundColor") }
                surface?.apply(edge: color)
                return true
            },
            M.navigationOpenPath: { [weak surface] params in
                guard let path = params["path"]?.string, WebOrigin.isInAppPath(path) else { throw BridgeFailure.failed("navigation.openPath requires an in-app path") }
                surface?.load(path)
                return true
            },
            M.shareText: { [weak surface] params in
                guard let text = params["text"]?.string else { throw BridgeFailure.failed("share.text requires text") }
                surface?.share(text)
                return true
            },
            M.shareTake: { _ in shell.inbox?.take()?.json ?? .null },
            M.shareReadFile: { params in
                guard let inbox = shell.inbox, let id = params["id"]?.string, let index = params["index"]?.number.map(Int.init) else {
                    throw BridgeFailure.failed("share.readFile requires an id and an index")
                }
                let data = try await Task.detached(priority: .userInitiated) { try inbox.read(id: id, index: index).base64EncodedString() }.value
                return ["data": .string(data)]
            },
            M.filesSave: { [weak surface] params in
                guard let surface else { throw BridgeFailure.canceled() }
                return try await surface.files.save(params) { [weak surface] payload in surface?.emit(HostProtocol.Event.filesProgress, payload) }
            },
            M.hapticsPerform: { params in .bool(Haptics.perform(params["kind"]?.string)) },
            M.shortcutsPush: { params in
                guard let shortcut = HostShortcut(params) else { throw BridgeFailure.failed("shortcuts.push requires an id, a label and an in-app path") }
                QuickActions.push(shortcut)
                return true
            },
            M.permissionsStatus: { _ in await HostPermissions.status(notifications: nil) },
            M.permissionsRequest: { params in try await HostPermissions.request(params["kind"]?.string, notifications: nil) },
            M.permissionsOpenSettings: { params in .bool(await openSettings(params["kind"]?.string)) },
            M.appAbout: { [weak surface] params in
                if let surface { AboutPanel.show(from: surface, config: shell.config, web: params["web"]?.string) }
                return true
            },
        ]
        return BridgeRouter(
            platform: "ios",
            hostId: ShellState.hostId,
            capabilities: capabilities,
            handlers: handlers,
            service: nil,
            consent: { _ in false },
            send: { [weak surface] text in surface?.deliver(text) }
        )
    }

    private static func openSettings(_ kind: String?) async -> Bool {
        guard kind == "microphone" || kind == "camera", let url = URL(string: UIApplication.openSettingsURLString) else { return false }
        return await UIApplication.shared.open(url)
    }
}

@MainActor
enum Haptics {
    private static let selection = UISelectionFeedbackGenerator()
    private static let notification = UINotificationFeedbackGenerator()
    private static let impact = UIImpactFeedbackGenerator(style: .medium)

    @discardableResult
    static func perform(_ kind: String?) -> Bool {
        switch kind {
        case "tick": selection.selectionChanged()
        case "confirm": notification.notificationOccurred(.success)
        case "reject": notification.notificationOccurred(.error)
        case "longPress": impact.impactOccurred()
        default: return false
        }
        return true
    }
}

@MainActor
enum AboutPanel {
    static func show(from host: UIViewController, config: ShellConfig, web: String?) {
        var lines = [L("Version \([config.version, config.commit].filter { !$0.isEmpty }.joined(separator: " · "))")]
        if let web { lines.append(L("Web \(web)")) }
        lines.append(L("Open source under Apache-2.0."))
        let alert = UIAlertController(title: L("About Cohub"), message: lines.joined(separator: "\n"), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: L("Source code"), style: .default) { _ in UIApplication.shared.open(ShellConfig.repository) })
        alert.addAction(UIAlertAction(title: L("OK"), style: .cancel))
        host.topmost.present(alert, animated: true)
    }
}
