using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Interop;
using System.Windows.Media;
using Cohub.Core;

namespace Cohub;

internal sealed class AboutWindow : Window
{
    private readonly StackPanel details = new() { Margin = new Thickness(0, 10, 0, 0) };
    private readonly Brush attention;
    private readonly List<string> report;

    public AboutWindow(Rgb edge, ImageSource? icon, string heading, string? web)
    {
        var dark = edge.IsDark;
        attention = new SolidColorBrush(dark ? Color.FromRgb(0xFB, 0x92, 0x3C) : Color.FromRgb(0xC2, 0x41, 0x0C));
        report = [heading];
        Title = Strings.L("About Cohub");
        Icon = icon;
        Background = new SolidColorBrush(edge.Media());
        Foreground = dark ? Brushes.White : Brushes.Black;
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        UseLayoutRounding = true;
        SourceInitialized += (_, _) => Native.TintTitleBar(new WindowInteropHelper(this).Handle, edge);

        var root = new StackPanel { Margin = new Thickness(20), MinWidth = 320 };
        var title = new StackPanel { Orientation = Orientation.Horizontal };
        if (icon is not null) title.Children.Add(new Image { Source = icon, Width = 32, Height = 32, Margin = new Thickness(0, 0, 12, 0) });
        title.Children.Add(new TextBlock { Text = heading, FontSize = 16, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        root.Children.Add(title);
        root.Children.Add(details);
        if (web is not null) AddLine(Strings.Format("Web {0}", web), false);

        var source = new Hyperlink(new Run("github.com/netaart/cohub")) { NavigateUri = new Uri(CliAbout.Repository), Foreground = Foreground };
        source.RequestNavigate += (_, e) => ShellWindow.OpenExternally(e.Uri);
        var footer = new TextBlock { Margin = new Thickness(0, 12, 0, 0), FontSize = 12 };
        footer.Inlines.Add(source);
        footer.Inlines.Add(new Run($" · {Strings.L("Open source under Apache-2.0")}"));
        root.Children.Add(footer);

        var copy = new Button { Content = Strings.L("Copy"), Padding = new Thickness(14, 4, 14, 4), Margin = new Thickness(0, 0, 8, 0) };
        copy.Click += async (_, _) =>
        {
            try { Clipboard.SetText(string.Join(Environment.NewLine, report)); }
            catch (ExternalException) { return; }
            copy.Content = Strings.L("Copied");
            await Task.Delay(TimeSpan.FromSeconds(2));
            copy.Content = Strings.L("Copy");
        };
        var close = new Button { Content = Strings.L("Close"), Padding = new Thickness(14, 4, 14, 4), IsCancel = true, IsDefault = true };
        close.Click += (_, _) => Close();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        buttons.Children.Add(copy);
        buttons.Children.Add(close);
        root.Children.Add(buttons);
        Content = root;
    }

    public void ShowCommandLine(CliAbout about)
    {
        foreach (var (text, needsAttention) in about.Describe(Strings.L)) AddLine(text, needsAttention);
    }

    private void AddLine(string text, bool needsAttention)
    {
        report.Add(text);
        var line = new TextBlock { Text = text, FontSize = 12, TextWrapping = TextWrapping.Wrap, MaxWidth = 460, Margin = new Thickness(0, 2, 0, 0), Opacity = needsAttention ? 1 : 0.8 };
        if (needsAttention) line.Foreground = attention;
        details.Children.Add(line);
    }
}
