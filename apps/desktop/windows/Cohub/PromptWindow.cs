using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Cohub.Core;

namespace Cohub;

internal sealed class PromptWindow : Window
{
    private readonly TextBox answer;

    public PromptWindow(Rgb edge, string? heading, string message, string? text)
    {
        Title = "Cohub";
        Background = new SolidColorBrush(edge.Media());
        Foreground = edge.IsDark ? Brushes.White : Brushes.Black;
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        UseLayoutRounding = true;
        SourceInitialized += (_, _) => Native.TintTitleBar(new WindowInteropHelper(this).Handle, edge);

        var root = new StackPanel { Margin = new Thickness(20), MinWidth = 360 };
        if (heading is not null) root.Children.Add(new TextBlock { Text = heading, FontSize = 16, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) });
        root.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, MaxWidth = 460 });
        answer = new TextBox { Text = text ?? "", Margin = new Thickness(0, 12, 0, 0), Padding = new Thickness(4, 3, 4, 3) };
        root.Children.Add(answer);

        var accept = new Button { Content = Strings.L("OK"), Padding = new Thickness(14, 4, 14, 4), Margin = new Thickness(0, 0, 8, 0), IsDefault = true };
        accept.Click += (_, _) => DialogResult = true;
        var cancel = new Button { Content = Strings.L("Cancel"), Padding = new Thickness(14, 4, 14, 4), IsCancel = true };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0) };
        buttons.Children.Add(accept);
        buttons.Children.Add(cancel);
        root.Children.Add(buttons);
        Content = root;
        Loaded += (_, _) =>
        {
            answer.Focus();
            answer.SelectAll();
        };
    }

    public string Answer => answer.Text;
}
