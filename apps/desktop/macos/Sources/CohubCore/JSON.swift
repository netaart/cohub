import Foundation

public enum JSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public subscript(key: String) -> JSON? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var array: [JSON]? {
        if case .array(let values) = self { return values }
        return nil
    }

    public static func parse(_ text: String) -> JSON? {
        guard let data = text.data(using: .utf8) else { return nil }
        return parse(data)
    }

    public static func parse(_ data: Data) -> JSON? {
        guard let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return JSON(foundation: value)
    }

    init?(foundation value: Any) {
        switch value {
        case is NSNull: self = .null
        case let number as NSNumber:
            if type(of: number) == JSON.booleanType { self = .bool(number.boolValue) } else { self = .number(number.doubleValue) }
        case let string as String: self = .string(string)
        case let array as [Any]:
            var values: [JSON] = []
            for item in array {
                guard let json = JSON(foundation: item) else { return nil }
                values.append(json)
            }
            self = .array(values)
        case let object as [String: Any]:
            var fields: [String: JSON] = [:]
            for (key, item) in object {
                guard let json = JSON(foundation: item) else { return nil }
                fields[key] = json
            }
            self = .object(fields)
        default: return nil
        }
    }

    public var text: String {
        switch self {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value):
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 { return String(Int64(value)) }
            return value.isFinite ? String(value) : "null"
        case .string(let value): return JSON.quote(value)
        case .array(let values): return "[\(values.map(\.text).joined(separator: ","))]"
        case .object(let fields):
            return "{\(fields.sorted { $0.key < $1.key }.map { "\(JSON.quote($0.key)):\($0.value.text)" }.joined(separator: ","))}"
        }
    }

    private static let booleanType = type(of: NSNumber(value: true))

    static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSON)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
}
