import AppKit
import CohubCore
import ServiceManagement

@MainActor
enum Permissions {
    static func openSettings(_ kind: String?) -> Bool {
        guard let url = kind.flatMap(PermissionSettings.url(for:)) else { return false }
        return NSWorkspace.shared.open(url)
    }

    static func setLaunchAtLogin(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}
