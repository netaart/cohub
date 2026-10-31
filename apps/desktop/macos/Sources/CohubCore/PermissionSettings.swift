import Foundation

public enum PermissionSettings {
    public static func url(for kind: String) -> URL? {
        let pane: String
        switch kind {
        case "files": pane = "com.apple.preference.security?Privacy_FilesAndFolders"
        case "microphone": pane = "com.apple.preference.security?Privacy_Microphone"
        case "camera": pane = "com.apple.preference.security?Privacy_Camera"
        case "screen": pane = "com.apple.preference.security?Privacy_ScreenCapture"
        case "control": pane = "com.apple.preference.security?Privacy_Accessibility"
        case "notifications": pane = "com.apple.Notifications-Settings.extension"
        default: return nil
        }
        return URL(string: "x-apple.systempreferences:\(pane)")
    }
}
