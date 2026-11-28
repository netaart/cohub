public struct BridgeRequest: Sendable, Equatable {
    public let id: String
    public let method: String
    public let params: JSON

    public init(id: String, method: String, params: JSON = .null) {
        self.id = id
        self.method = method
        self.params = params
    }

    public static func parse(_ text: String) -> BridgeRequest? {
        guard text.utf8.count <= 32 * 1024 * 1024,
            let message = JSON.parse(text),
            message["type"]?.string == "request",
            let id = message["id"]?.string, (1...128).contains(id.count),
            let method = message["method"]?.string, (1...64).contains(method.count)
        else { return nil }
        return BridgeRequest(id: id, method: method, params: message["params"] ?? .null)
    }

    public func text(id: String) -> String {
        var fields: [String: JSON] = ["type": "request", "id": .string(id), "method": .string(method)]
        if params != .null { fields["params"] = params }
        return JSON.object(fields).text
    }
}

public enum BridgeReply: Sendable, Equatable {
    case result(JSON)
    case failure(BridgeFailure)

    public func text(id: String) -> String {
        switch self {
        case .result(let result):
            return JSON.object(["type": "response", "id": .string(id), "result": result]).text
        case .failure(let failure):
            let message = failure.message.isEmpty ? "Host call failed" : String(failure.message.prefix(2_000))
            return JSON.object([
                "type": "response", "id": .string(id),
                "error": ["code": .string(failure.code), "message": .string(message)],
            ]).text
        }
    }
}

public enum BridgeEvent {
    public static func text(name: String, payload: JSON?) -> String {
        var fields: [String: JSON] = ["type": "event", "name": .string(name)]
        if let payload { fields["payload"] = payload }
        return JSON.object(fields).text
    }
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
