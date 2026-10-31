import AppKit
import CohubCore
import UserNotifications

@MainActor
final class Notifications: NSObject, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let open: @MainActor (String) -> Void

    init(open: @escaping @MainActor (String) -> Void) {
        self.open = open
        super.init()
        center.delegate = self
    }

    func register() async -> Bool {
        await withCheckedContinuation { continuation in
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in continuation.resume(returning: granted) }
        }
    }

    func state() async -> String {
        switch await authorizationStatus() {
        case .authorized, .provisional: "granted"
        case .notDetermined: "prompt"
        default: "denied"
        }
    }

    private func authorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { continuation.resume(returning: $0.authorizationStatus) }
        }
    }

    func show(_ params: JSON) async throws -> Bool {
        guard let id = params["id"]?.string, let title = params["title"]?.string,
              let path = params["path"]?.string, WebOrigin.isInAppPath(path)
        else { throw BridgeFailure.failed("notifications.show requires an id, a title and an in-app path") }
        guard await state() == "granted" else { return false }
        let content = UNMutableNotificationContent()
        content.title = title
        if let body = params["body"]?.string { content.body = body }
        content.sound = .default
        content.userInfo = ["path": path]
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
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
