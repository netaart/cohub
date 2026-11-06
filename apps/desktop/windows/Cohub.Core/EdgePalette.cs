using System.Globalization;

namespace Cohub.Core;

public readonly record struct Rgb(byte R, byte G, byte B)
{
    public static Rgb? Parse(string? hex) =>
        hex is { Length: 7 } && hex[0] == '#' && uint.TryParse(hex.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value)
            ? new Rgb((byte)(value >> 16), (byte)(value >> 8), (byte)value)
            : null;

    public string Hex => $"#{R:x2}{G:x2}{B:x2}";

    public bool IsDark => 0.2126 * R + 0.7152 * G + 0.0722 * B < 128;

    public Rgb Mix(Rgb other, double amount) => new(Channel(R, other.R, amount), Channel(G, other.G, amount), Channel(B, other.B, amount));

    private static byte Channel(byte from, byte to, double amount) => (byte)Math.Round(from + (to - from) * amount, MidpointRounding.AwayFromZero);
}

public sealed record EdgePalette(bool Dark, Rgb Edge, Rgb Strip, Rgb Hover, Rgb Text, Rgb Muted, Rgb Accent)
{
    public static EdgePalette For(Rgb edge)
    {
        var dark = edge.IsDark;
        var text = dark ? new Rgb(0xFF, 0xFF, 0xFF) : new Rgb(0x1F, 0x1F, 0x1F);
        var strip = edge.Mix(text, 0.1);
        return new(dark, edge, strip, edge.Mix(text, 0.05), text, strip.Mix(text, 0.65),
            dark ? new Rgb(0x60, 0xA5, 0xFA) : new Rgb(0x25, 0x63, 0xEB));
    }
}
