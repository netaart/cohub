import CohubCore
import UIKit

@MainActor
enum QuickActions {
    private static let recentLimit = 3

    static func push(_ shortcut: HostShortcut) {
        ShellState.shortcuts = shortcut.pushed(onto: ShellState.shortcuts, limit: recentLimit)
        refresh(signedIn: true)
    }

    static func refresh(signedIn: Bool) {
        guard signedIn else {
            UIApplication.shared.shortcutItems = []
            return
        }
        let newChat = item(title: L("New chat"), symbol: "square.and.pencil", path: WebOrigin.newChatPath)
        UIApplication.shared.shortcutItems = [newChat] + ShellState.shortcuts.map { item(title: $0.label, symbol: "square.stack", path: $0.path) }
    }

    static func path(of item: UIApplicationShortcutItem) -> String? {
        guard let path = item.userInfo?["path"] as? String, WebOrigin.isInAppPath(path) else { return nil }
        return path
    }

    private static func item(title: String, symbol: String, path: String) -> UIApplicationShortcutItem {
        UIApplicationShortcutItem(type: "open", localizedTitle: title, localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: symbol), userInfo: ["path": path as NSString])
    }
}
