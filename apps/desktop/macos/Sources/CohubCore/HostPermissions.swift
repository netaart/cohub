#if canImport(AVFoundation) && canImport(UserNotifications)
@preconcurrency import AVFoundation

@MainActor
public enum HostPermissions {
    public static func status(notifications: Notifications?) async -> JSON {
        var fields: [String: JSON] = ["microphone": .string(state(.audio)), "camera": .string(state(.video))]
        if let notifications { fields["notifications"] = .string(await notifications.state()) }
        return .object(fields)
    }

    public static func request(_ kind: String?, notifications: Notifications?) async throws -> JSON {
        switch kind {
        case "microphone": _ = await AVCaptureDevice.requestAccess(for: .audio); return .string(state(.audio))
        case "camera": _ = await AVCaptureDevice.requestAccess(for: .video); return .string(state(.video))
        case "notifications":
            guard let notifications else { throw BridgeFailure.failed("Notifications are not available") }
            _ = await notifications.register()
            return .string(await notifications.state())
        default: throw BridgeFailure.failed("This permission cannot be requested")
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
#endif
