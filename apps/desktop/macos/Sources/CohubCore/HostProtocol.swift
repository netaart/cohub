public enum HostProtocol {
    public static let version = 1
    public static let global = "cohubHost"

    public enum Capability {
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
    }

    public enum Method {
        public static let describe = "host.describe"
        public static let appReady = "app.ready"
        public static let appearanceSet = "appearance.set"
        public static let navigationOpenPath = "navigation.openPath"
        public static let shareText = "share.text"
        public static let filesSave = "files.save"
        public static let cacheClear = "cache.clear"
        public static let notificationsRegister = "notifications.register"
        public static let notificationsShow = "notifications.show"
        public static let shortcutsPush = "shortcuts.push"
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
    }

    public enum Event {
        public static let authChanged = "auth.changed"
        public static let runtimeChanged = "runtime.changed"
        public static let displayChanged = "display.changed"
    }

    public enum ErrorCode {
        public static let unsupported = "unsupported"
        public static let canceled = "canceled"
        public static let failed = "failed"
        public static let denied = "denied"
    }

    public enum ShellEvent {
        public static let open = "shell.open"
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
