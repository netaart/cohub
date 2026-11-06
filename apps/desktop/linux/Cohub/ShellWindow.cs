using System.Text.Json.Nodes;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellWindow
{
    public static readonly (string Name, string[] Accels)[] Accelerators =
    [
        ("reload", ["<Control>r", "F5"]),
        ("back", ["<Alt>Left"]),
        ("forward", ["<Alt>Right"]),
        ("zoom-in", ["<Control>plus", "<Control>equal"]),
        ("zoom-out", ["<Control>minus"]),
        ("zoom-reset", ["<Control>0"]),
    ];

    private readonly ShellApp app;
    private readonly Gtk.MenuButton menuButton;
    private readonly Gtk.ShortcutController keys = Gtk.ShortcutController.New();
    private Adw.TabPage? menuPage;
    private ShellTab? selected;
    private bool discarding;
    private bool closed;
    /// <summary>An empty view selects the first page it gets; that must not load a tab added in the background.</summary>
    private bool adding;

    public ShellWindow(ShellApp app, ShellWindow? sizeFrom, ShellState.Placement? placement = null)
    {
        this.app = app;
        var config = app.Config;
        Window = Gtk.ApplicationWindow.New(app.Application);
        Window.Title = config.Title;
        Window.AddCssClass("cohub");
        Window.SetSizeRequest(480, 360);
        if (sizeFrom is not null)
        {
            sizeFrom.Window.GetDefaultSize(out var width, out var height);
            Window.SetDefaultSize(width, height);
        }
        else if (placement is { Width: >= 480, Height: >= 360 })
        {
            Window.SetDefaultSize((int)placement.Width, (int)placement.Height);
            if (placement.Maximized) Window.Maximize();
        }
        else
        {
            Window.SetDefaultSize(1280, 820);
        }

        menuButton = Gtk.MenuButton.New();
        menuButton.SetIconName("open-menu-symbolic");
        menuButton.SetMenuModel(app.Menu);
        menuButton.Primary = true;
        menuButton.TooltipText = config.Title;
        var header = Gtk.HeaderBar.New();
        header.PackEnd(menuButton);
        Window.SetTitlebar(header);

        TabView.Vexpand = true;
        TabView.Shortcuts = Adw.TabViewShortcuts.None;
        TabView.MenuModel = TabMenu();
        TabView.OnClosePage += (_, args) =>
        {
            RequestClose(args.Page);
            return true;
        };
        TabView.OnPageAttached += (_, args) => Attached(args.Page);
        TabView.OnPageDetached += (_, args) => Detached(args.Page);
        TabView.OnPageReordered += (_, _) => app.SessionChanged();
        TabView.OnCreateWindow += (_, _) =>
        {
            var window = app.NewWindow(this);
            window.Present();
            return window.TabView;
        };
        TabView.OnSetupMenu += (_, args) => { if (args.Page is not null) menuPage = args.Page; };
        TabView.OnNotify += (_, args) => { if (args.Pspec.GetName() == "selected-page") SelectionChanged(); };
        var bar = Adw.TabBar.New();
        bar.View = TabView;
        bar.Autohide = true;
        var layout = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
        layout.Append(bar);
        layout.Append(TabView);
        Window.SetChild(layout);

        AddKeys();
        AddWindowActions();
        Window.OnCloseRequest += (_, _) => CloseRequested();
        Window.OnNotify += (_, args) =>
        {
            switch (args.Pspec.GetName())
            {
                case "is-active" when Window.IsActive:
                    app.WindowActivated(this);
                    selected?.Show();
                    break;
                case "default-width" or "default-height" or "maximized":
                    app.SessionChanged();
                    break;
            }
        };
        ShowState(app.Summary);
    }

    public Gtk.ApplicationWindow Window { get; }
    public Adw.TabView TabView { get; } = Adw.TabView.New();
    public ShellTab? Selected => selected;

    public IReadOnlyList<ShellTab> Tabs => [.. Enumerable.Range(0, TabView.NPages).Select(index => TabView.GetNthPage(index)).Select(TabOf).OfType<ShellTab>()];

    public int SelectedIndex => TabView.SelectedPage is { } page ? TabView.GetPagePosition(page) : 0;

    private ShellTab? TabOf(Adw.TabPage page) => page.Child is { } child ? app.TabOf(child) : null;

    public ShellTab Add(SessionTab session, int? position = null, bool select = true, bool loads = true, ShellTab? parent = null)
    {
        var tab = new ShellTab(app, this, session);
        app.Track(tab);
        adding = true;
        var page = parent?.Page is { } opener ? TabView.AddPage(tab.Container, opener)
            : position is { } index ? TabView.Insert(tab.Container, Math.Clamp(index, 0, TabView.NPages))
            : TabView.Append(tab.Container);
        adding = false;
        tab.Page = page;
        page.Title = session.Title ?? app.Config.Title;
        if (select) Select(tab);
        else if (loads) tab.Load(tab.Path);
        app.SessionChanged();
        return tab;
    }

    public void OpenBeside(SessionTab session, ShellTab anchor, bool background = false) => Add(session, select: !background, parent: anchor);

    public void NewTab()
    {
        Add(new SessionTab("/"));
        Present();
    }

    public void Select(ShellTab tab)
    {
        if (tab.Page is not { } page) return;
        TabView.SelectedPage = page;
        SelectionChanged();
    }

    public void Release(ShellTab tab)
    {
        if (tab.Page is not { } page) return;
        tab.Closing = true;
        TabView.ClosePage(page);
    }

    private void Attached(Adw.TabPage page)
    {
        if (TabOf(page) is not { } tab) return;
        tab.Window = this;
        tab.Page = page;
        ShowTabbed();
        app.SessionChanged();
    }

    private void ShowTabbed()
    {
        if (TabView.NPages > 1) Window.AddCssClass("cohub-tabbed");
        else Window.RemoveCssClass("cohub-tabbed");
    }

    private void Detached(Adw.TabPage page)
    {
        if (TabOf(page) is not { } tab) return;
        ShowTabbed();
        if (tab == selected) selected = null;
        if (tab.Closing)
        {
            tab.Close();
            app.Forget(tab);
        }
        if (TabView.NPages == 0 && !closed) GLib.Functions.IdleAdd(0, () =>
        {
            if (TabView.NPages == 0) Discard();
            return false;
        });
        app.SessionChanged();
    }

    private void SelectionChanged()
    {
        if (adding) return;
        var tab = TabView.SelectedPage is { } page ? TabOf(page) : null;
        if (tab == selected) return;
        selected?.Hide();
        selected = tab;
        if (tab is null) return;
        tab.Show();
        UpdateChrome();
        app.SessionChanged();
    }

    private async void RequestClose(Adw.TabPage page)
    {
        var tab = TabOf(page);
        if (tab is null || tab.Closing)
        {
            TabView.ClosePageFinish(page, true);
            return;
        }
        if (TabView.NPages == 1 && app.IsLastWindow(this))
        {
            TabView.ClosePageFinish(page, false);
            Window.SetVisible(false);
            return;
        }
        var confirmed = !tab.Dirty || await ConfirmAsync(Strings.L("This tab has unsaved changes"), Strings.L("Your changes will be lost."), Strings.L("Close"));
        if (confirmed)
        {
            tab.Closing = true;
            app.Closed(tab, TabView.GetPagePosition(page));
        }
        TabView.ClosePageFinish(page, confirmed);
    }

    public void TabChanged(ShellTab tab)
    {
        if (tab.Page is { } page) page.Title = tab.Title ?? app.Config.Title;
        if (tab == selected) UpdateChrome();
        app.SessionChanged();
    }

    private void UpdateChrome()
    {
        if (selected is not { } tab) return;
        Window.Title = tab.Title ?? app.Config.Title;
        keys.SetPropagationPhase(tab.CapturesKeys ? Gtk.PropagationPhase.None : Gtk.PropagationPhase.Capture);
        if (Window.IsActive || app.IsLastWindow(this)) app.ApplyEdge(tab.Edge);
    }

    public void Present()
    {
        if (!closed) Window.Present();
    }

    public void Discard()
    {
        if (closed) return;
        discarding = true;
        Window.Close();
    }

    public void ShowState(RuntimeOverview.State? summary)
    {
        foreach (var name in new[] { "cohub-ready", "cohub-connecting", "cohub-error" }) menuButton.RemoveCssClass(name);
        if (summary is { } state && state != RuntimeOverview.State.Stopped) menuButton.AddCssClass($"cohub-{state.ToString().ToLowerInvariant()}");
        menuButton.TooltipText = summary is { } current ? $"{app.Config.Title} · {ShellApp.Describe(current)}" : app.Config.Title;
    }

    public static void OpenExternally(string uri)
    {
        try { Gio.Functions.AppInfoLaunchDefaultForUri(uri, null); }
        catch (GLib.GException error) { ShellApp.Log($"Could not open {uri}: {error.Message}"); }
    }

    public async Task<JsonNode?> PickFolderAsync(HostService service, string? handedOver)
    {
        var path = handedOver;
        if (path is null)
        {
            var dialog = Gtk.FileDialog.New();
            dialog.Title = Strings.L("Choose a folder for agents to work in.");
            dialog.AcceptLabel = Strings.L("Choose");
            dialog.Modal = true;
            Gio.File? folder;
            try { folder = await dialog.SelectFolderAsync(Window); }
            catch (GLib.GException) { throw BridgeException.Canceled(); }
            path = folder?.GetPath() ?? throw BridgeException.Canceled();
        }
        var reply = await service.CallAsync(new BridgeRequest("browse", HostProtocol.Methods.RuntimeBrowse, new JsonObject { ["path"] = path }));
        return reply.Failure is { } failure ? throw failure : reply.Result;
    }

    public Task<bool> ConfirmConnectAsync(string root)
    {
        var name = System.IO.Path.GetFileName(root.TrimEnd('/'));
        return ConfirmAsync(
            Strings.Format("Connect “{0}” to a Space?", string.IsNullOrEmpty(name) ? root : name),
            Strings.L("People and agents in the Space can change files in this folder and run commands as you on this computer. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space."),
            Strings.L("Connect"));
    }

    public async Task<bool> ConfirmAsync(string message, string detail, string accept)
    {
        var dialog = Alert(message, detail);
        dialog.Buttons = [Strings.L("Cancel"), accept];
        dialog.CancelButton = 0;
        dialog.DefaultButton = 1;
        Present();
        try { return await dialog.ChooseAsync(Window) == 1; }
        catch (GLib.GException) { return false; }
    }

    public void Inform(string message, string detail)
    {
        Present();
        Alert(message, detail).Show(Window);
    }

    private static Gtk.AlertDialog Alert(string message, string detail)
    {
        var dialog = Gtk.AlertDialog.NewWithProperties([]);
        dialog.Message = message;
        dialog.Detail = detail;
        dialog.Modal = true;
        return dialog;
    }

    public ShellState.Placement Placement()
    {
        Window.GetDefaultSize(out var width, out var height);
        return new(0, 0, width, height, Window.IsMaximized());
    }

    private bool CloseRequested()
    {
        if (!app.Quitting && !discarding)
        {
            if (app.IsLastWindow(this))
            {
                Window.SetVisible(false);
                return true;
            }
            var open = Tabs;
            if (open.Any(tab => tab.Dirty))
            {
                _ = ConfirmCloseAsync();
                return true;
            }
            for (var index = 0; index < open.Count; index++) app.Closed(open[index], index);
        }
        closed = true;
        foreach (var tab in Tabs)
        {
            tab.Close();
            app.Forget(tab);
        }
        app.Closed(this);
        return false;
    }

    private async Task ConfirmCloseAsync()
    {
        if (!await ConfirmAsync(Strings.L("Some tabs have unsaved changes"), Strings.L("Your changes will be lost."), Strings.L("Close"))) return;
        var open = Tabs;
        for (var index = 0; index < open.Count; index++) app.Closed(open[index], index);
        Discard();
    }

    private void AddKeys()
    {
        keys.SetPropagationPhase(Gtk.PropagationPhase.Capture);
        foreach (var shortcut in ShellShortcuts.All)
        {
            foreach (var accel in Accels(shortcut))
            {
                if (Gtk.ShortcutTrigger.ParseString(accel) is not { } trigger) continue;
                keys.AddShortcut(Gtk.Shortcut.New(trigger, Gtk.CallbackAction.New((_, _) =>
                {
                    Run(shortcut);
                    return true;
                })));
            }
        }
        Window.AddController(keys);
    }

    public static IEnumerable<string> Accels(ShellShortcut shortcut)
    {
        var modifiers = shortcut.Shift ? "<Control><Shift>" : "<Control>";
        yield return modifiers + shortcut.Key switch
        {
            "PageUp" => "Page_Up",
            "PageDown" => "Page_Down",
            "Tab" or "F4" => shortcut.Key,
            _ => shortcut.Key.ToLowerInvariant(),
        };
        if (shortcut.Key == "Tab" && shortcut.Shift) yield return $"{modifiers}ISO_Left_Tab";
    }

    private void Run(ShellShortcut shortcut)
    {
        switch (shortcut.Command)
        {
            case TabCommand.NewTab: NewTab(); break;
            case TabCommand.NewWindow: app.OpenWindow("/"); break;
            case TabCommand.CloseTab: if (TabView.SelectedPage is { } page) TabView.ClosePage(page); break;
            case TabCommand.CloseWindow: Window.Close(); break;
            case TabCommand.ReopenClosedTab: app.ReopenClosedTab(this); break;
            case TabCommand.NextTab: Move(TabMove.Next); break;
            case TabCommand.PreviousTab: Move(TabMove.Previous); break;
            case TabCommand.SelectTab: if (TabOrder.Numbered(shortcut.Tab, TabView.NPages) is { } index) TabView.SelectedPage = TabView.GetNthPage(index); break;
        }
    }

    private void Move(TabMove move)
    {
        if (TabOrder.Target(move, SelectedIndex, TabView.NPages) is { } index) TabView.SelectedPage = TabView.GetNthPage(index);
    }

    private static Gio.Menu TabMenu()
    {
        var create = Gio.Menu.New();
        create.Append(Strings.L("Duplicate Tab"), "win.tab-duplicate");
        create.Append(Strings.L("Move Tab to New Window"), "win.tab-move");
        var close = Gio.Menu.New();
        close.Append(Strings.L("Close Tab"), "win.tab-close");
        close.Append(Strings.L("Close Other Tabs"), "win.tab-close-others");
        var menu = Gio.Menu.New();
        menu.AppendSection(null, create);
        menu.AppendSection(null, close);
        return menu;
    }

    private void AddWindowActions()
    {
        void Add(string name, Action run)
        {
            var action = Gio.SimpleAction.New(name, null);
            action.OnActivate += (_, _) => run();
            Window.AddAction(action);
        }
        foreach (var (name, _) in Accelerators) Add(name, () => selected?.Act(name));
        Add("new-tab", NewTab);
        Add("reopen-closed-tab", () => app.ReopenClosedTab(this));
        ShellTab? Menu() => (menuPage ?? TabView.SelectedPage) is { } page ? TabOf(page) : null;
        Add("tab-duplicate", () => { if (Menu() is { } tab) OpenBeside(tab.Session, tab); });
        Add("tab-move", () =>
        {
            if (Menu() is not { Page: { } page } || TabView.NPages < 2) return;
            var window = app.NewWindow(this);
            TabView.TransferPage(page, window.TabView, 0);
            window.Present();
        });
        Add("tab-close", () => { if (Menu() is { Page: { } page }) TabView.ClosePage(page); });
        Add("tab-close-others", () => { if (Menu() is { Page: { } page }) CloseOthers(page); });
    }

    private async void CloseOthers(Adw.TabPage kept)
    {
        var others = Tabs.Where(tab => tab.Page != kept).ToList();
        if (others.Any(tab => tab.Dirty) && !await ConfirmAsync(Strings.L("Some tabs have unsaved changes"), Strings.L("Your changes will be lost."), Strings.L("Close"))) return;
        TabView.SelectedPage = kept;
        foreach (var tab in others)
        {
            app.Closed(tab, TabView.GetPagePosition(tab.Page!));
            Release(tab);
        }
    }
}
