using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellWindow : Window
{
    private readonly ShellApp app;
    private readonly List<ShellTab> tabs = [];
    private readonly Grid pages = new();
    private readonly TabStrip strip;
    private readonly DispatcherTimer idle = new() { Interval = TimeSpan.FromMinutes(1) };
    private bool discarding;

    public ShellWindow(ShellApp app, Window? cascadeFrom, ShellState.Placement? placement = null)
    {
        this.app = app;
        Title = "Cohub";
        Width = 1280;
        Height = 820;
        MinWidth = 480;
        MinHeight = 360;
        Icon = app.WindowIcon;
        strip = new TabStrip(this);
        var layout = new DockPanel();
        DockPanel.SetDock(strip, Dock.Top);
        layout.Children.Add(strip);
        layout.Children.Add(pages);
        Content = layout;
        Place(cascadeFrom, placement);
        PreviewKeyDown += OnPreviewKeyDown;
        SourceInitialized += (_, _) => Native.TintTitleBar(Handle, Edge);
        Activated += (_, _) =>
        {
            app.WindowActivated(this);
            if (Selected is not { } shown) return;
            shown.Show();
            UpdateChrome();
        };
        LocationChanged += (_, _) => app.SessionChanged();
        SizeChanged += (_, _) => app.SessionChanged();
        StateChanged += (_, _) => app.SessionChanged();
        idle.Tick += (_, _) =>
        {
            var now = DateTimeOffset.Now;
            foreach (var tab in tabs) if (tab != Selected) tab.SuspendIfIdle(now);
        };
        idle.Start();
    }

    public IntPtr Handle => new WindowInteropHelper(this).Handle;
    public IReadOnlyList<ShellTab> Tabs => tabs;
    public ShellTab? Selected { get; private set; }
    public int SelectedIndex => Selected is null ? 0 : Math.Max(tabs.IndexOf(Selected), 0);
    private Color Edge => app.EdgeColor(Selected?.Edge);

    public ShellTab Add(SessionTab session, int? index = null, bool select = true, bool loads = true)
    {
        var tab = new ShellTab(app, this, session);
        Insert(tab, index ?? tabs.Count);
        if (select) Select(tab);
        else if (loads) tab.Load(tab.Path);
        return tab;
    }

    public void OpenBeside(SessionTab session, ShellTab anchor, bool background = false)
    {
        var index = TabOrder.Insertion<ShellTab>(anchor, [.. tabs.Select(tab => (tab, tab.Opener))]);
        Add(session, index, select: !background).Opener = anchor;
    }

    public void NewTab()
    {
        Add(new SessionTab("/"));
        Reveal();
    }

    public void Adopt(ShellTab tab, int index, bool select = true)
    {
        var from = tab.Window;
        from.Detach(tab);
        tab.Window = this;
        tab.Opener = null;
        Insert(tab, index);
        if (tab.View is { } view) pages.Children.Add(view);
        if (select) Select(tab);
        if (from.tabs.Count == 0) from.Discard();
        app.SessionChanged();
    }

    private void Insert(ShellTab tab, int index)
    {
        tabs.Insert(Math.Clamp(index, 0, tabs.Count), tab);
        UpdateChrome();
    }

    private void Detach(ShellTab tab)
    {
        var successor = TabOrder.Successor<ShellTab>(tab, Selected, [.. tabs.Select(item => (item, item.Opener))]);
        if (tab.View is { } view) pages.Children.Remove(view);
        tabs.Remove(tab);
        foreach (var other in tabs.Where(other => other.Opener == tab)) other.Opener = null;
        if (Selected != tab) { UpdateChrome(); return; }
        Selected = null;
        if (successor is not null) Select(successor);
        else UpdateChrome();
    }

    public void Host(ShellTab tab)
    {
        if (tab.View is { } view && !pages.Children.Contains(view)) pages.Children.Add(view);
    }

    public void Select(ShellTab tab)
    {
        if (Selected is { } previous && previous != tab)
        {
            if (tab.Opener != previous) tab.Opener = null;
            previous.Hide();
        }
        Selected = tab;
        tab.Show();
        UpdateChrome();
        app.SessionChanged();
    }

    public void Move(TabMove move)
    {
        if (Selected is { } selected && TabOrder.Target(move, tabs.IndexOf(selected), tabs.Count) is { } index) Select(tabs[index]);
    }

    public void SelectNumbered(int number)
    {
        if (TabOrder.Numbered(number, tabs.Count) is { } index) Select(tabs[index]);
    }

    public void CloseTab(ShellTab tab)
    {
        if (tabs.Count == 1 && app.IsLastWindow(this))
        {
            Hide();
            return;
        }
        if (tab.Dirty && !ConfirmDiscard(Strings.L("This tab has unsaved changes"))) return;
        app.Closed(tab, tabs.IndexOf(tab));
        Release(tab);
        if (tabs.Count == 0) Discard();
    }

    public void CloseOthers(ShellTab kept)
    {
        var others = tabs.Where(tab => tab != kept).ToList();
        if (others.Any(tab => tab.Dirty) && !ConfirmDiscard(Strings.L("Some tabs have unsaved changes"))) return;
        Select(kept);
        foreach (var tab in others)
        {
            app.Closed(tab, tabs.IndexOf(tab));
            Release(tab);
        }
    }

    public void Release(ShellTab tab)
    {
        Detach(tab);
        tab.Dispose();
        app.SessionChanged();
    }

    public void Discard()
    {
        discarding = true;
        Close();
    }

    public void TabChanged(ShellTab tab)
    {
        if (tab == Selected) UpdateChrome();
        else strip.Update(tabs, Selected, Edge);
        app.SessionChanged();
    }

    private void UpdateChrome()
    {
        var edge = Edge;
        Title = Selected?.Title ?? "Cohub";
        Background = new SolidColorBrush(edge);
        if (Handle != IntPtr.Zero) Native.TintTitleBar(Handle, edge);
        strip.Update(tabs, Selected, edge);
    }

    public void Reveal()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    public void ShowBadge(ImageSource? overlay)
    {
        TaskbarItemInfo ??= new System.Windows.Shell.TaskbarItemInfo();
        TaskbarItemInfo.Overlay = overlay;
    }

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        var modifiers = Keyboard.Modifiers;
        if (!modifiers.HasFlag(ModifierKeys.Control) || modifiers.HasFlag(ModifierKeys.Alt) || Selected?.CapturesKeys == true) return;
        if (KeyName(e.Key == Key.System ? e.SystemKey : e.Key) is not { } key || ShellShortcuts.Find(key, modifiers.HasFlag(ModifierKeys.Shift)) is not { } shortcut) return;
        e.Handled = true;
        if (e.IsRepeat && !ShellShortcuts.Repeats(shortcut.Command)) return;
        switch (shortcut.Command)
        {
            case TabCommand.NewTab: NewTab(); break;
            case TabCommand.NewWindow: app.OpenWindow("/"); break;
            case TabCommand.CloseTab: if (Selected is { } tab) CloseTab(tab); break;
            case TabCommand.CloseWindow: Close(); break;
            case TabCommand.ReopenClosedTab: app.ReopenClosedTab(this); break;
            case TabCommand.NextTab: Move(TabMove.Next); break;
            case TabCommand.PreviousTab: Move(TabMove.Previous); break;
            case TabCommand.SelectTab: SelectNumbered(shortcut.Tab); break;
        }
    }

    private static string? KeyName(Key key) => key switch
    {
        >= Key.A and <= Key.Z => key.ToString(),
        >= Key.D1 and <= Key.D9 => $"{key - Key.D0}",
        Key.Tab => "Tab",
        Key.PageUp => "PageUp",
        Key.PageDown => "PageDown",
        Key.F4 => "F4",
        _ => null,
    };

    public static void OpenExternally(Uri url) => Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true })?.Dispose();

    public async Task<System.Text.Json.Nodes.JsonNode?> PickFolderAsync(HostService service, string? handedOver)
    {
        var path = handedOver;
        if (path is null)
        {
            var dialog = new Microsoft.Win32.OpenFolderDialog { Title = Strings.L("Choose a folder for agents to work in."), Multiselect = false };
            if (dialog.ShowDialog(this) != true) throw BridgeException.Canceled();
            path = dialog.FolderName;
        }
        var reply = await service.CallAsync(new BridgeRequest("browse", HostProtocol.Methods.RuntimeBrowse, new System.Text.Json.Nodes.JsonObject { ["path"] = path }));
        return reply.Failure is { } failure ? throw failure : reply.Result;
    }

    public Task<bool> ConfirmConnectAsync(string root)
    {
        var name = System.IO.Path.GetFileName(root.TrimEnd('\\', '/'));
        return Task.FromResult(Confirm(
            Strings.Format("Connect “{0}” to a Space?", string.IsNullOrEmpty(name) ? root : name),
            Strings.L("People and agents in the Space can change files in this folder and run commands as you on this PC. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space."),
            Strings.L("Connect"),
            System.Windows.Forms.TaskDialogIcon.ShieldWarningYellowBar));
    }

    public Task<bool> ConfirmShareAsync() => Task.FromResult(Confirm(
        Strings.L("Share this screen with the Space?"),
        Strings.L("People and agents in the Space can see this screen and control this PC until you stop sharing or quit Cohub."),
        Strings.L("Share"),
        System.Windows.Forms.TaskDialogIcon.ShieldWarningYellowBar));

    public bool ConfirmDiscard(string heading)
    {
        Reveal();
        return Confirm(heading, Strings.L("Your changes will be lost."), Strings.L("Close"), System.Windows.Forms.TaskDialogIcon.Warning);
    }

    private bool Confirm(string heading, string text, string accept, System.Windows.Forms.TaskDialogIcon icon)
    {
        var button = new System.Windows.Forms.TaskDialogButton(accept);
        var page = new System.Windows.Forms.TaskDialogPage
        {
            Caption = "Cohub",
            Heading = heading,
            Text = text,
            Icon = icon,
            Buttons = { button, System.Windows.Forms.TaskDialogButton.Cancel },
            DefaultButton = button,
        };
        return System.Windows.Forms.TaskDialog.ShowDialog(Handle, page) == button;
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        base.OnClosing(e);
        if (app.Quitting || discarding) return;
        if (app.IsLastWindow(this))
        {
            e.Cancel = true;
            Hide();
            return;
        }
        if (tabs.Any(tab => tab.Dirty) && !ConfirmDiscard(Strings.L("Some tabs have unsaved changes")))
        {
            e.Cancel = true;
            return;
        }
        for (var index = 0; index < tabs.Count; index++) app.Closed(tabs[index], index);
    }

    protected override void OnClosed(EventArgs e)
    {
        idle.Stop();
        foreach (var tab in tabs) tab.Dispose();
        tabs.Clear();
        app.Closed(this);
        base.OnClosed(e);
    }

    private void Place(Window? cascadeFrom, ShellState.Placement? saved)
    {
        if (saved is not null && IsOnScreen(saved))
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            (Left, Top, Width, Height) = (saved.Left, saved.Top, saved.Width, saved.Height);
            if (saved.Maximized) WindowState = WindowState.Maximized;
            return;
        }
        if (cascadeFrom is not null)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Width = cascadeFrom.ActualWidth;
            Height = cascadeFrom.ActualHeight;
            Left = cascadeFrom.Left + 28;
            Top = cascadeFrom.Top + 28;
            return;
        }
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
    }

    private static bool IsOnScreen(ShellState.Placement placement) =>
        placement.Width >= 480 && placement.Height >= 360
        && placement.Left + 80 < SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth
        && placement.Top + 40 < SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight
        && placement.Left + placement.Width - 80 > SystemParameters.VirtualScreenLeft
        && placement.Top >= SystemParameters.VirtualScreenTop - 8;

    public ShellState.Placement Placement()
    {
        var bounds = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        return new(bounds.Left, bounds.Top, bounds.Width, bounds.Height, WindowState == WindowState.Maximized);
    }
}
