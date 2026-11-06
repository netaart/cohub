using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Cohub.Core;

namespace Cohub;

internal sealed class TabStrip : Border
{
    private const double MinTabWidth = 72;
    private const double MaxTabWidth = 240;
    private const string Glyphs = "Segoe Fluent Icons, Segoe MDL2 Assets";

    private readonly ShellWindow window;
    private readonly TabRow row = new() { ClipToBounds = true };
    private readonly Border add;
    private readonly Dictionary<ShellTab, Chip> chips = [];
    private Paints palette = Paints.For(EdgePalette.For(new Rgb(0xFF, 0xFF, 0xFF)));

    public TabStrip(ShellWindow window)
    {
        this.window = window;
        Height = 36;
        Padding = new Thickness(6, 4, 6, 0);
        Visibility = Visibility.Collapsed;
        add = Button("\uE710", Strings.L("New Tab"), window.NewTab);
        add.Margin = new Thickness(2, 0, 0, 4);
        var layout = new DockPanel { LastChildFill = false };
        DockPanel.SetDock(row, Dock.Left);
        DockPanel.SetDock(add, Dock.Left);
        layout.Children.Add(row);
        layout.Children.Add(add);
        Child = layout;
    }

    private static ShellApp App => (ShellApp)Application.Current;

    public void Update(IReadOnlyList<ShellTab> tabs, ShellTab? selected, EdgePalette edge)
    {
        Visibility = tabs.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        if (palette.Source != edge)
        {
            palette = Paints.For(edge);
            Background = palette.Strip;
            ((TextBlock)add.Child).Foreground = palette.Text;
        }
        foreach (var gone in chips.Keys.Except(tabs).ToList())
        {
            row.Children.Remove(chips[gone]);
            chips.Remove(gone);
        }
        for (var index = 0; index < tabs.Count; index++)
        {
            var tab = tabs[index];
            if (!chips.TryGetValue(tab, out var chip)) chips[tab] = chip = new Chip(this, tab);
            if (row.Children.IndexOf(chip) != index)
            {
                row.Children.Remove(chip);
                row.Children.Insert(index, chip);
            }
            chip.Update(tab == selected, palette);
        }
        row.Selected = selected is null ? 0 : Math.Max(tabs.ToList().IndexOf(selected), 0);
    }

    private Border Button(string glyph, string label, Action run)
    {
        var button = new Border
        {
            Width = 28,
            CornerRadius = new CornerRadius(6),
            Background = Brushes.Transparent,
            ToolTip = label,
            Child = new TextBlock { Text = glyph, FontFamily = new FontFamily(Glyphs), FontSize = 10, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center },
        };
        AutomationProperties.SetName(button, label);
        button.MouseEnter += (_, _) => button.Background = palette.Control;
        button.MouseLeave += (_, _) => button.Background = Brushes.Transparent;
        // Pressing a chip's button must not select the chip first.
        button.MouseLeftButtonDown += (_, e) => e.Handled = true;
        button.MouseLeftButtonUp += (_, e) =>
        {
            e.Handled = true;
            run();
        };
        return button;
    }

    private sealed record Paints(EdgePalette Source, Brush Strip, Brush Selected, Brush Hover, Brush Text, Brush Muted, Brush Dot, Brush Control)
    {
        public static Paints For(EdgePalette palette) => new(
            palette,
            Frozen(palette.Strip.Media()),
            Frozen(palette.Edge.Media()),
            Frozen(palette.Hover.Media()),
            Frozen(palette.Text.Media()),
            Frozen(palette.Muted.Media()),
            Frozen(palette.Accent.Media()),
            Frozen(Color.FromArgb(0x1A, palette.Text.R, palette.Text.G, palette.Text.B)));

        private static SolidColorBrush Frozen(Color color)
        {
            var brush = new SolidColorBrush(color);
            brush.Freeze();
            return brush;
        }
    }

    private sealed class Chip : Border
    {
        private static readonly CornerRadius Raised = new(7, 7, 0, 0);
        private static readonly CornerRadius Rounded = new(6);
        private static readonly Thickness Inset = new(0, 0, 0, 4);

        private readonly TabStrip strip;
        private readonly Border fill = new();
        private readonly ShellTab tab;
        private readonly TextBlock title = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        private readonly Ellipse dot = new() { Width = 6, Height = 6, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center };
        private readonly Border close;
        private bool selected;

        public Chip(TabStrip strip, ShellTab tab)
        {
            this.strip = strip;
            this.tab = tab;
            Background = Brushes.Transparent;
            Margin = new Thickness(0, 0, 2, 0);
            close = strip.Button("\uE8BB", Strings.L("Close Tab"), () => tab.Window.CloseTab(tab));
            close.Width = 22;
            close.Height = 22;
            var content = new DockPanel { Margin = new Thickness(10, 0, 4, 0) };
            DockPanel.SetDock(dot, Dock.Left);
            DockPanel.SetDock(close, Dock.Right);
            content.Children.Add(dot);
            content.Children.Add(close);
            content.Children.Add(title);
            var layers = new Grid();
            layers.Children.Add(fill);
            layers.Children.Add(content);
            Child = layers;
            MouseLeftButtonDown += (_, e) =>
            {
                e.Handled = true;
                if (tab.Window.Selected != tab) tab.Window.Select(tab);
            };
            MouseUp += (_, e) =>
            {
                if (e.ChangedButton != MouseButton.Middle) return;
                e.Handled = true;
                tab.Window.CloseTab(tab);
            };
            MouseEnter += (_, _) => Paint();
            MouseLeave += (_, _) => Paint();
            ContextMenu = new ContextMenu();
            ContextMenuOpening += (_, _) => BuildMenu();
        }

        public void Update(bool selected, Paints palette)
        {
            this.selected = selected;
            var label = tab.Title ?? "Cohub";
            title.Text = label;
            title.Foreground = selected ? palette.Text : palette.Muted;
            dot.Fill = palette.Dot;
            dot.Visibility = tab.Attention && !selected ? Visibility.Visible : Visibility.Collapsed;
            ((TextBlock)close.Child).Foreground = palette.Text;
            ToolTip = label;
            AutomationProperties.SetName(this, label);
            Paint();
        }

        private void Paint()
        {
            fill.Background = selected ? strip.palette.Selected : IsMouseOver ? strip.palette.Hover : null;
            fill.CornerRadius = selected ? Raised : Rounded;
            fill.Margin = selected ? default : Inset;
            close.Visibility = selected || IsMouseOver ? Visibility.Visible : Visibility.Hidden;
        }

        private void BuildMenu()
        {
            var several = tab.Window.Tabs.Count > 1;
            ContextMenu.Items.Clear();
            Add(Strings.L("New Tab"), tab.Window.NewTab);
            Add(Strings.L("Duplicate Tab"), () => tab.Window.OpenBeside(tab.Session, tab));
            Add(Strings.L("Move Tab to New Window"), () => App.MoveToNewWindow(tab), several);
            ContextMenu.Items.Add(new Separator());
            Add(Strings.L("Close Tab"), () => tab.Window.CloseTab(tab));
            Add(Strings.L("Close Other Tabs"), () => tab.Window.CloseOthers(tab), several);
            Add(Strings.L("Reopen Closed Tab"), () => App.ReopenClosedTab(tab.Window), App.CanReopenClosedTab);
        }

        private void Add(string header, Action run, bool enabled = true)
        {
            var item = new MenuItem { Header = header, IsEnabled = enabled };
            item.Click += (_, _) => run();
            ContextMenu.Items.Add(item);
        }
    }

    private sealed class TabRow : Panel
    {
        private const double ButtonRoom = 32;
        private int selected;
        private double offset;

        public int Selected
        {
            get => selected;
            set
            {
                if (selected == value) return;
                selected = value;
                InvalidateArrange();
            }
        }

        private double TabWidth(double room) => InternalChildren.Count == 0 ? 0 : Math.Clamp(room / InternalChildren.Count, MinTabWidth, MaxTabWidth);

        protected override Size MeasureOverride(Size available)
        {
            var room = double.IsInfinity(available.Width) ? MaxTabWidth * InternalChildren.Count : Math.Max(available.Width - ButtonRoom, 0);
            var width = TabWidth(room);
            var height = 0.0;
            foreach (UIElement chip in InternalChildren)
            {
                chip.Measure(new Size(width, available.Height));
                height = Math.Max(height, chip.DesiredSize.Height);
            }
            return new Size(Math.Min(width * InternalChildren.Count, room), height);
        }

        protected override Size ArrangeOverride(Size final)
        {
            var width = TabWidth(final.Width);
            var overflow = Math.Max(width * InternalChildren.Count - final.Width, 0);
            offset = Math.Clamp(Math.Clamp(offset, (selected + 1) * width - final.Width, selected * width), 0, overflow);
            for (var index = 0; index < InternalChildren.Count; index++)
                InternalChildren[index].Arrange(new Rect(index * width - offset, 0, width, final.Height));
            return final;
        }
    }
}
