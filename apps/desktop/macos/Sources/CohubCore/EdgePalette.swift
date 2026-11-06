import Foundation

public struct RGB: Equatable, Sendable {
    public var red: UInt8
    public var green: UInt8
    public var blue: UInt8

    public init(_ red: UInt8, _ green: UInt8, _ blue: UInt8) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    public init?(hex: String) {
        guard hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF))
    }

    public var hex: String { String(format: "#%02x%02x%02x", red, green, blue) }

    public var isDark: Bool { 0.2126 * Double(red) + 0.7152 * Double(green) + 0.0722 * Double(blue) < 128 }

    public func mixed(with other: RGB, _ amount: Double) -> RGB {
        let channel = { (from: UInt8, to: UInt8) in UInt8((Double(from) + (Double(to) - Double(from)) * amount).rounded()) }
        return RGB(channel(red, other.red), channel(green, other.green), channel(blue, other.blue))
    }
}

public struct EdgePalette: Equatable, Sendable {
    public let dark: Bool
    public let edge: RGB
    public let strip: RGB
    public let hover: RGB
    public let text: RGB
    public let muted: RGB
    public let accent: RGB

    public init(edge: RGB) {
        dark = edge.isDark
        text = dark ? RGB(0xFF, 0xFF, 0xFF) : RGB(0x1F, 0x1F, 0x1F)
        self.edge = edge
        strip = edge.mixed(with: text, 0.1)
        hover = edge.mixed(with: text, 0.05)
        muted = strip.mixed(with: text, 0.65)
        accent = dark ? RGB(0x60, 0xA5, 0xFA) : RGB(0x25, 0x63, 0xEB)
    }
}
