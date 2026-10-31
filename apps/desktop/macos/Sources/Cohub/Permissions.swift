import AppKit
@preconcurrency import AVFoundation
import CohubCore
import ServiceManagement

@MainActor
enum Permissions {
    static func status(notifications: Notifications?) async -> JSON {
        var fields: [String: JSON] = ["microphone": .string(state(.audio)), "camera": .string(state(.video))]
        if let notifications { fields["notifications"] = .string(await notifications.state()) }
        return .object(fields)
    }

    static func request(_ kind: String?, notifications: Notifications?) async throws -> JSON {
        switch kind {
        case "microphone": await ask(.audio); return .string(state(.audio))
        case "camera": await ask(.video); return .string(state(.video))
        case "notifications":
            guard let notifications else { throw BridgeFailure.failed("Notifications are not available") }
            _ = await notifications.register()
            return .string(await notifications.state())
        default: throw BridgeFailure.failed("This permission cannot be requested")
        }
    }

    static func openSettings(_ kind: String?) -> Bool {
        guard let url = kind.flatMap(PermissionSettings.url(for:)) else { return false }
        return NSWorkspace.shared.open(url)
    }

    static func setLaunchAtLogin(_ enabled: Bool) throws {
        if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    private static func ask(_ media: AVMediaType) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            AVCaptureDevice.requestAccess(for: media) { _ in continuation.resume() }
        }
    }

    private static func state(_ media: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .authorized: "granted"
        case .notDetermined: "prompt"
        default: "denied"
        }
    }
}
