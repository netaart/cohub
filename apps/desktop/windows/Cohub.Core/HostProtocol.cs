namespace Cohub.Core;

public static class HostProtocol
{
    public const int Version = 1;
    public const string Global = "cohubHost";
    public const int ServiceVersion = 1;

    public static class Capabilities
    {
        public const string Notifications = "notifications";
        public const string Share = "share";
        public const string Navigation = "navigation";
        public const string Cache = "cache";
        public const string Appearance = "appearance";
        public const string Launch = "launch";
        public const string Shortcuts = "shortcuts";
        public const string MediaCapture = "media.capture";
        public const string Runtime = "runtime";
        public const string RuntimePicker = "runtime.picker";
        public const string Permissions = "permissions";
        public const string Badge = "badge";
        public const string LaunchAtLogin = "app.launchAtLogin";
        public const string GlobalShortcut = "app.globalShortcut";
    }

    public static class Methods
    {
        public const string Describe = "host.describe";
        public const string AppReady = "app.ready";
        public const string AppearanceSet = "appearance.set";
        public const string NavigationOpenPath = "navigation.openPath";
        public const string ShareText = "share.text";
        public const string CacheClear = "cache.clear";
        public const string NotificationsRegister = "notifications.register";
        public const string NotificationsShow = "notifications.show";
        public const string ShortcutsPush = "shortcuts.push";
        public const string RuntimeList = "runtime.list";
        public const string RuntimeBrowse = "runtime.browse";
        public const string RuntimeStart = "runtime.start";
        public const string RuntimeStop = "runtime.stop";
        public const string RuntimePickFolder = "runtime.pickFolder";
        public const string DisplayShare = "display.share";
        public const string DisplayStop = "display.stop";
        public const string DisplayOpenControlSettings = "display.openControlSettings";
        public const string PermissionsStatus = "permissions.status";
        public const string PermissionsRequest = "permissions.request";
        public const string PermissionsOpenSettings = "permissions.openSettings";
        public const string BadgeSet = "badge.set";
        public const string LaunchAtLogin = "app.launchAtLogin";
        public const string GlobalShortcut = "app.globalShortcut";
    }

    public static class Events
    {
        public const string AuthChanged = "auth.changed";
        public const string RuntimeChanged = "runtime.changed";
        public const string DisplayChanged = "display.changed";
    }

    public static class ErrorCodes
    {
        public const string Unsupported = "unsupported";
        public const string Canceled = "canceled";
        public const string Failed = "failed";
        public const string Denied = "denied";
    }

    public static class ShellEvents
    {
        public const string Open = "shell.open";
    }
}

public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public static BridgeException Canceled(string message = "Canceled") => new(HostProtocol.ErrorCodes.Canceled, message);
    public static BridgeException Failed(string message) => new(HostProtocol.ErrorCodes.Failed, message);
    public static BridgeException Unsupported(string method) => new(HostProtocol.ErrorCodes.Unsupported, $"Unsupported method: {method}");
}
