import AppKit
import CohubCore
import UserNotifications

@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    private let open: @MainActor (String) -> Void

    init(open: @escaping @MainActor (String) -> Void) {
        self.open = open
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func register() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    nonisolated func state() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional: "granted"
        case .notDetermined: "prompt"
        default: "denied"
        }
    }

    nonisolated func show(_ params: JSON) async throws -> Bool {
        guard let id = params["id"]?.string, let title = params["title"]?.string,
              let path = params["path"]?.string, WebOrigin.isInAppPath(path)
        else { throw BridgeFailure.failed("notifications.show requires an id, a title and an in-app path") }
        guard await state() == "granted" else { return false }
        let content = UNMutableNotificationContent()
        content.title = title
        if let body = params["body"]?.string { content.body = body }
        content.sound = .default
        content.userInfo = ["path": path]
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        return true
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let path = response.notification.request.content.userInfo["path"] as? String else { return }
        await MainActor.run { open(path) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}
