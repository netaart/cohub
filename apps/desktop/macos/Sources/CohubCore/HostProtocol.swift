public enum HostProtocol {
    public static let version = 1
    public static let global = "cohubHost"
    public static let shareFileMaxBytes = 12 * 1024 * 1024

    public enum Capability {
        public static let authToken = "auth.token"
        public static let authSignIn = "auth.signIn"
        public static let authSession = "auth.session"
        public static let haptics = "haptics"
        public static let shareIncoming = "share.incoming"
        public static let notifications = "notifications"
        public static let share = "share"
        public static let navigation = "navigation"
        public static let cache = "cache"
        public static let appearance = "appearance"
        public static let launch = "launch"
        public static let files = "files"
        public static let shortcuts = "shortcuts"
        public static let mediaCapture = "media.capture"
        public static let runtime = "runtime"
        public static let runtimePicker = "runtime.picker"
        public static let permissions = "permissions"
        public static let badge = "badge"
        public static let launchAtLogin = "app.launchAtLogin"
        public static let globalShortcut = "app.globalShortcut"
        public static let workspace = "workspace"
        public static let workspaceFiles = "workspace.files"
        public static let tabs = "tabs"
        public static let about = "app.about"
    }

    public enum Method {
        public static let describe = "host.describe"
        public static let authGetAccessToken = "auth.getAccessToken"
        public static let authGetSessionVersion = "auth.getSessionVersion"
        public static let authGetSession = "auth.getSession"
        public static let authSignIn = "auth.signIn"
        public static let authSignOut = "auth.signOut"
        public static let hapticsPerform = "haptics.perform"
        public static let shareTake = "share.take"
        public static let shareReadFile = "share.readFile"
        public static let appReady = "app.ready"
        public static let appearanceSet = "appearance.set"
        public static let navigationOpenPath = "navigation.openPath"
        public static let shareText = "share.text"
        public static let filesSave = "files.save"
        public static let filesReveal = "files.reveal"
        public static let cacheClear = "cache.clear"
        public static let notificationsRegister = "notifications.register"
        public static let notificationsShow = "notifications.show"
        public static let shortcutsPush = "shortcuts.push"
        public static let tabsUpdate = "tabs.update"
        public static let runtimeList = "runtime.list"
        public static let runtimeBrowse = "runtime.browse"
        public static let runtimeStart = "runtime.start"
        public static let runtimeStop = "runtime.stop"
        public static let runtimePickFolder = "runtime.pickFolder"
        public static let displayShare = "display.share"
        public static let displayStop = "display.stop"
        public static let displayOpenControlSettings = "display.openControlSettings"
        public static let permissionsStatus = "permissions.status"
        public static let permissionsRequest = "permissions.request"
        public static let permissionsOpenSettings = "permissions.openSettings"
        public static let badgeSet = "badge.set"
        public static let launchAtLogin = "app.launchAtLogin"
        public static let globalShortcut = "app.globalShortcut"
        public static let workspaceCall = "workspace.call"
        public static let appAbout = "app.about"
    }

    public enum Event {
        public static let authChanged = "auth.changed"
        public static let authSignedOut = "auth.signedOut"
        public static let appForeground = "app.foreground"
        public static let appBackground = "app.background"
        public static let runtimeChanged = "runtime.changed"
        public static let displayChanged = "display.changed"
        public static let filesProgress = "files.progress"
    }

    public enum ErrorCode {
        public static let unsupported = "unsupported"
        public static let canceled = "canceled"
        public static let failed = "failed"
        public static let denied = "denied"
        public static let unavailable = "unavailable"
    }

    public enum ShellEvent {
        public static let open = "shell.open"
    }

    /// Asked of the CLI by the shell itself; the page can never reach them.
    public enum ServiceMethod {
        public static let workspaceEndpoint = "workspace.endpoint"
        public static let cliAbout = "cli.about"
    }

    public static let serviceVersion = 1
}

public struct BridgeFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public static func canceled(_ message: String = "Canceled") -> BridgeFailure { .init(HostProtocol.ErrorCode.canceled, message) }
    public static func failed(_ message: String) -> BridgeFailure { .init(HostProtocol.ErrorCode.failed, message) }
    public static func unsupported(_ method: String) -> BridgeFailure { .init(HostProtocol.ErrorCode.unsupported, "Unsupported method: \(method)") }
}
