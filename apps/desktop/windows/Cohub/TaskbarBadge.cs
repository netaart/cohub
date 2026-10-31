using System.Globalization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Cohub;

internal static class TaskbarBadge
{
    private const int Size = 32;

    public static ImageSource Render(int count)
    {
        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
        {
            context.DrawEllipse(new SolidColorBrush(Color.FromRgb(0xDC, 0x26, 0x26)), null, new Point(Size / 2.0, Size / 2.0), Size / 2.0, Size / 2.0);
            var text = new FormattedText(count > 9 ? "9+" : count.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI Semibold"), 20, Brushes.White, 1.0);
            context.DrawText(text, new Point((Size - text.Width) / 2, (Size - text.Height) / 2));
        }
        var image = new RenderTargetBitmap(Size, Size, 96, 96, PixelFormats.Pbgra32);
        image.Render(visual);
        image.Freeze();
        return image;
    }
}
