import Carbon.HIToolbox

@MainActor
final class GlobalShortcut {
    private static let signature: OSType = 0x4348_5542 // 'CHUB'
    private nonisolated(unsafe) static var action: (@MainActor () -> Void)?

    private var key: EventHotKeyRef?
    private var handler: EventHandlerRef?

    init(action: @escaping @MainActor () -> Void) {
        Self.action = action
    }

    var isEnabled: Bool { key != nil }

    func set(enabled: Bool) {
        if enabled == isEnabled { return }
        if enabled { register() } else { unregister() }
    }

    private func register() {
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { GlobalShortcut.action?() }
            return OSStatus(noErr)
        }, 1, &type, nil, &handler)
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &key)
    }

    private func unregister() {
        if let key { UnregisterEventHotKey(key) }
        if let handler { RemoveEventHandler(handler) }
        key = nil
        handler = nil
    }
}
