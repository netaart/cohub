using System.Globalization;
using System.Text.Json.Nodes;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellApp : IDisposable
{
    private readonly List<ShellWindow> windows = [];
    private readonly Dictionary<IntPtr, ShellTab> tabs = [];
    private readonly ClosedTabs closedTabs = new();
    private readonly RepeatFilter repeats = new();
    private readonly CancellationTokenSource stopping = new();
    private readonly Gio.Menu folders = Gio.Menu.New();
    private readonly Gio.Menu updateSection = Gio.Menu.New();
    private SynchronizationContext? main;
    private HostService? service;
    private Updates? updates;
    private Gtk.CssProvider? edgeStyle;
    private RuntimeOverview overview = RuntimeOverview.Empty;
    private string? appliedEdge;
    private bool saveQueued;
    private Gtk.AboutDialog? about;

    public ShellApp(ShellConfig config)
    {
        Config = config;
        State = ShellState.Load(config.DataDirectory);
        // A second launch hands its URI to this instance over D-Bus and exits.
        Application = Adw.Application.New(config.AppId, Gio.ApplicationFlags.HandlesOpen);
        Application.OnStartup += (_, _) => Startup();
        Application.OnActivate += (_, _) => Handle(null);
        Application.OnOpen += (_, args) =>
        {
            foreach (var file in args.Files) Handle(file.GetUri(), file.GetPath());
        };
        Application.OnShutdown += (_, _) => Shutdown();
    }

    public ShellConfig Config { get; }
    public ShellState State { get; }
    public Adw.Application Application { get; }
    public Gio.Menu Menu { get; } = Gio.Menu.New();
    public WebKit.NetworkSession Session { get; private set; } = null!;
    public bool Quitting { get; private set; }

    public string EdgeColor => State.EdgeColor is { } hex && IsColor(hex) ? hex : "#ffffff";
    public bool CanReopenClosedTab => !closedTabs.IsEmpty;

    public int Run(string[] args)
    {
        // X11 groups windows under the launcher entry by WM_CLASS, which GTK takes from the program name.
        GLib.Functions.SetPrgname(Config.AppId);
        GLib.Functions.SetApplicationName(Config.Title);
        return Application.RunWithSynchronizationContext([ShellConfig.Executable, .. args]);
    }

    private void Startup()
    {
        main = SynchronizationContext.Current;
        Gtk.Window.SetDefaultIconName(Config.AppId);
        Session = WebKit.NetworkSession.New(Path.Combine(Config.DataDirectory, "WebKit"), Path.Combine(Config.CacheDirectory, "WebKit"));
        Session.OnDownloadStarted += (_, args) => Downloads.Track(args.Download, Notify);
        edgeStyle = Gtk.CssProvider.New();
        if (Gdk.Display.GetDefault() is { } display) Gtk.StyleContext.AddProviderForDisplay(display, edgeStyle, 600);
        ApplyEdge(EdgeColor);
        AddActions();
        BuildMenu();
        try { DesktopEntry.Write(Config, State.Shortcuts); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Log($"Could not write the desktop entry: {error.Message}"); }
        StartService();
        updates = new Updates(Config.FeedUrl, () => Post(() => { updateSection.RemoveAll(); updateSection.Append(Strings.L("Restart to Update"), "app.restart-to-update"); }), Log,
            new Updates.Gate(Path.Combine(Config.DataDirectory, "update.lock"), AppImage.Superseded, () => AppImage.Relaunch([])));
        _ = updates.RunAsync(stopping.Token);
    }

    private void Shutdown()
    {
        updates?.ApplyOnExit();
        Dispose();
    }

    public void Dispose()
    {
        stopping.Cancel();
        stopping.Dispose();
        service?.Dispose();
    }

    public void Post(Action action) => main?.Post(_ => action(), null);

    private void Restore()
    {
        foreach (var saved in State.Session?.Windows ?? [])
        {
            var window = NewWindow(placement: saved.Placement);
            foreach (var tab in saved.Tabs) window.Add(tab, select: false, loads: false);
            window.Select(window.Tabs[saved.Selected]);
            window.Present();
        }
    }

    public ShellWindow NewWindow(ShellWindow? sizeFrom = null, ShellState.Placement? placement = null)
    {
        var window = new ShellWindow(this, sizeFrom ?? (placement is null ? windows.LastOrDefault(item => item.Window.GetVisible()) : null), placement);
        windows.Add(window);
        return window;
    }

    public ShellWindow OpenWindow(string path)
    {
        var window = NewWindow();
        window.Add(new SessionTab(path));
        window.Present();
        return window;
    }

    public void ReopenClosedTab(ShellWindow window)
    {
        if (closedTabs.Pop() is not { } closed) return;
        window.Add(closed.Tab, closed.Index);
        window.Present();
    }

    public void Open(string path)
    {
        if (!WebOrigin.IsInAppPath(path)) return;
        var shown = windows.SelectMany(window => window.Tabs).LastOrDefault(tab => TabSession.SamePage(tab.Path, path) && (tab.Path == path || !tab.Dirty));
        if (shown is not null)
        {
            if (shown.Path != path) shown.Load(path);
            shown.Window.Select(shown);
            shown.Window.Present();
        }
        else if (Primary is { } front)
        {
            if (front.Selected is { Path: "/" } home) home.Load(path);
            else front.Add(new SessionTab(path));
            front.Present();
        }
        else
        {
            OpenWindow(path);
        }
    }

    public bool IsLastWindow(ShellWindow window) => windows.Count == 1 && windows[0] == window;

    public void WindowActivated(ShellWindow window)
    {
        windows.Remove(window);
        windows.Add(window);
        if (window.Selected is { } tab) ApplyEdge(tab.Edge);
        SessionChanged();
    }

    public void Closed(ShellWindow window)
    {
        windows.Remove(window);
        SessionChanged();
    }

    public void Closed(ShellTab tab, int index)
    {
        if (!Quitting) closedTabs.Push(tab.Session, index);
    }

    public void Track(ShellTab tab) => tabs[tab.Container.Handle.DangerousGetHandle()] = tab;

    public void Forget(ShellTab tab) => tabs.Remove(tab.Container.Handle.DangerousGetHandle());

    public ShellTab? TabOf(Gtk.Widget child) => tabs.GetValueOrDefault(child.Handle.DangerousGetHandle());

    public void SessionChanged()
    {
        if (Quitting || saveQueued) return;
        saveQueued = true;
        GLib.Functions.TimeoutAdd(0, 500, () =>
        {
            SaveSession();
            return false;
        });
    }

    private void SaveSession()
    {
        saveQueued = false;
        var saved = windows.Select(window => (window, open: window.Tabs)).Where(item => item.open.Count > 0).Select(item =>
            new SessionWindow([.. item.open.Select(tab => tab.Session)], item.window.SelectedIndex, item.window.Placement()));
        State.Session = new TabSession([.. saved]).Sanitized();
        State.Save();
    }

    private ShellWindow? Primary => windows.LastOrDefault(window => window.Window.IsActive) ?? windows.LastOrDefault(window => window.Window.GetVisible()) ?? windows.LastOrDefault();

    private void ShowPrimary()
    {
        if (Primary is { } window) window.Present();
        else OpenWindow("/");
    }

    private void Handle(string? argument, string? local = null)
    {
        if (windows.Count == 0) Restore();
        if (local is not null && Directory.Exists(local) && WebOrigin.NewSpacePath(local) is { } newSpace) Open(newSpace);
        else if (argument == $"{Config.UrlScheme}://new-window") OpenWindow("/");
        else if (argument is not null && WebOrigin.PathFromDeepLink(argument, Config.UrlScheme) is { } path) Open(path);
        else ShowPrimary();
    }

    private async void Quit()
    {
        if (windows.SelectMany(window => window.Tabs).FirstOrDefault(tab => tab.Dirty) is { } dirty
            && !await dirty.Window.ConfirmAsync(Strings.L("Some tabs have unsaved changes"), Strings.L("Your changes will be lost."), Strings.L("Quit"))) return;
        SaveSession();
        Quitting = true;
        foreach (var window in windows.ToList()) window.Window.Close();
        Application.Quit();
    }

    private void AddActions()
    {
        void Add(string name, Action run, params string[] accels)
        {
            var action = Gio.SimpleAction.New(name, null);
            action.OnActivate += (_, _) => run();
            Application.AddAction(action);
            if (accels.Length > 0) Application.SetAccelsForAction($"app.{name}", accels);
        }
        void AddWithText(string name, Action<string> run)
        {
            var action = Gio.SimpleAction.New(name, GLib.VariantType.New("s"));
            action.OnActivate += (_, args) => { if (args.Parameter?.GetString(out var _) is { } text) run(text); };
            Application.AddAction(action);
        }
        Add("new-window", () => OpenWindow("/"));
        Add("quit", Quit, "<Control>q");
        Add("install-command-line-tool", () => _ = InstallCommandLineToolAsync());
        Add("restart-to-update", () => updates?.RestartNow());
        Add("about", () => ShowAbout(null));
        AddWithText("open-path", Open);
        AddWithText("open-space", spaceId => Open($"/spaces/{spaceId}"));
        AddWithText("show-folder", root => ShellWindow.OpenExternally(new Uri(root).AbsoluteUri));
        AddWithText("disconnect", spaceId => Disconnect(spaceId));
        foreach (var (name, accels) in ShellWindow.Accelerators) Application.SetAccelsForAction($"win.{name}", accels);
    }

    private void BuildMenu()
    {
        var windowSection = Gio.Menu.New();
        windowSection.AppendItem(WithAccel(Strings.L("New Tab"), "win.new-tab", TabCommand.NewTab));
        windowSection.AppendItem(WithAccel(Strings.L("New Window"), "app.new-window", TabCommand.NewWindow));
        windowSection.AppendItem(WithAccel(Strings.L("Reopen Closed Tab"), "win.reopen-closed-tab", TabCommand.ReopenClosedTab));
        var toolSection = Gio.Menu.New();
        toolSection.Append(Strings.L("Install Command Line Tool"), "app.install-command-line-tool");
        toolSection.Append(Strings.L("About Cohub"), "app.about");
        var quitSection = Gio.Menu.New();
        quitSection.Append(Strings.L("Quit Cohub"), "app.quit");
        Menu.AppendSection(null, windowSection);
        Menu.AppendSection(Strings.L("Connected Folders"), folders);
        Menu.AppendSection(null, toolSection);
        Menu.AppendSection(null, updateSection);
        Menu.AppendSection(null, quitSection);
    }

    private void UpdateFolders(RuntimeOverview next)
    {
        if (next.Equals(overview)) return;
        overview = next;
        folders.RemoveAll();
        foreach (var folder in next.Connected)
        {
            var entry = Gio.Menu.New();
            var details = Gio.Menu.New();
            details.Append(folder.Label, null);
            details.Append(Describe(folder.State), null);
            entry.AppendSection(null, details);
            var commands = Gio.Menu.New();
            commands.AppendItem(Item(Strings.L("Open Space"), "app.open-space", folder.SpaceId));
            commands.AppendItem(Item(Strings.L("Show in Files"), "app.show-folder", folder.Root));
            entry.AppendSection(null, commands);
            var disconnect = Gio.Menu.New();
            disconnect.AppendItem(Item(Strings.L("Disconnect"), "app.disconnect", folder.SpaceId));
            entry.AppendSection(null, disconnect);
            folders.AppendSubmenu($"{folder.Name} · {Describe(folder.State)}", entry);
        }
        foreach (var window in windows) window.ShowState(next.Summary);
    }

    private static Gio.MenuItem WithAccel(string label, string action, TabCommand command)
    {
        var item = Gio.MenuItem.New(label, action);
        if (ShellShortcuts.All.FirstOrDefault(shortcut => shortcut.Command == command) is { Key: not null } shortcut)
            item.SetAttributeValue("accel", GLib.Variant.NewString(ShellWindow.Accels(shortcut).First()));
        return item;
    }

    private static Gio.MenuItem Item(string label, string action, string target)
    {
        var item = Gio.MenuItem.New(label, null);
        item.SetActionAndTargetValue(action, GLib.Variant.NewString(target));
        return item;
    }

    public RuntimeOverview.State? Summary => overview.Summary;

    public static string Describe(RuntimeOverview.State state) => state switch
    {
        RuntimeOverview.State.Ready => Strings.L("Connected"),
        RuntimeOverview.State.Connecting => Strings.L("Connecting…"),
        RuntimeOverview.State.Error => Strings.L("Needs attention"),
        _ => Strings.L("Not connected"),
    };

    public void ApplyEdge(string? edge)
    {
        var hex = edge is not null && IsColor(edge) ? edge : EdgeColor;
        if (hex == appliedEdge) return;
        appliedEdge = hex;
        var value = uint.Parse(hex.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var dark = 0.2126 * (value >> 16 & 0xFF) + 0.7152 * (value >> 8 & 0xFF) + 0.0722 * (value & 0xFF) < 128;
        Adw.StyleManager.GetDefault().ColorScheme = dark ? Adw.ColorScheme.ForceDark : Adw.ColorScheme.ForceLight;
        var foreground = dark ? "#ffffff" : "#1f1f1f";
        edgeStyle?.LoadFromData($$"""
            window.cohub, window.cohub headerbar, window.cohub tabbar .box { background: {{hex}}; color: {{foreground}}; }
            window.cohub headerbar, window.cohub tabbar .box { box-shadow: none; border-bottom: none; }
            menubutton.cohub-ready image { color: #16a34a; }
            menubutton.cohub-connecting image { color: #eab308; }
            menubutton.cohub-error image { color: #dc2626; }
            """, -1);
    }

    public BridgeRouter Router(ShellTab tab)
    {
        List<string> capabilities = [
            HostProtocol.Capabilities.Launch, HostProtocol.Capabilities.Appearance, HostProtocol.Capabilities.Navigation,
            HostProtocol.Capabilities.Notifications, HostProtocol.Capabilities.Shortcuts, HostProtocol.Capabilities.MediaCapture,
            HostProtocol.Capabilities.Tabs,
            HostProtocol.Capabilities.About,
        ];
        var handlers = new Dictionary<string, BridgeRouter.Handler>
        {
            [HostProtocol.Methods.AppReady] = _ =>
            {
                tab.ReportReady();
                return Ok();
            },
            [HostProtocol.Methods.AppearanceSet] = parameters =>
            {
                if (JsonFields.Text(parameters, "backgroundColor") is not { } hex || !IsColor(hex)) throw BridgeException.Failed("appearance.set requires a #rrggbb backgroundColor");
                if (State.EdgeColor != hex)
                {
                    State.EdgeColor = hex;
                    SessionChanged();
                }
                tab.ApplyEdge(hex);
                return Ok();
            },
            [HostProtocol.Methods.NavigationOpenPath] = parameters =>
            {
                if (JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path)) throw BridgeException.Failed("navigation.openPath requires an in-app path");
                tab.Load(path);
                return Ok();
            },
            [HostProtocol.Methods.TabsUpdate] = parameters =>
            {
                tab.Update(parameters);
                return Ok();
            },
            [HostProtocol.Methods.AppAbout] = parameters =>
            {
                ShowAbout(JsonFields.Text(parameters, "web"));
                return Ok();
            },
            [HostProtocol.Methods.NotificationsRegister] = _ => Ok(),
            [HostProtocol.Methods.NotificationsShow] = parameters =>
            {
                if (JsonFields.Text(parameters, "id") is not { } id || JsonFields.Text(parameters, "title") is not { } title || JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path))
                    throw BridgeException.Failed("notifications.show requires an id, a title and an in-app path");
                var body = JsonFields.Text(parameters, "body");
                if (repeats.Admits($"{id}\n{title}\n{body}", DateTimeOffset.Now)) Notify(id, title, body, "app.open-path", path);
                return Ok();
            },
            [HostProtocol.Methods.ShortcutsPush] = parameters =>
            {
                if (JsonFields.Text(parameters, "id") is not { } id || JsonFields.Text(parameters, "label") is not { } label || JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path))
                    throw BridgeException.Failed("shortcuts.push requires an id, a label and an in-app path");
                State.PushShortcut(new(id, label, path));
                try { DesktopEntry.Write(Config, State.Shortcuts); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Log($"Could not write the desktop entry: {error.Message}"); }
                return Ok();
            },
        };
        if (service is { } host)
        {
            capabilities.Add(HostProtocol.Capabilities.RuntimePicker);
            handlers[HostProtocol.Methods.RuntimePickFolder] = parameters => tab.Window.PickFolderAsync(host, JsonFields.Text(parameters, "path"));
        }
        // The CLI shares no screen on Linux, so every consent asked here is for a folder.
        return new BridgeRouter("linux", State.HostId, capabilities, handlers, service, request => request.Root is { } root ? tab.Window.ConfirmConnectAsync(root) : Task.FromResult(false), tab.Deliver);
    }

    private static Task<JsonNode?> Ok() => Task.FromResult<JsonNode?>(true);

    private void Notify(string id, string title, string? body, string action, string target)
    {
        var notification = Gio.Notification.New(title);
        if (!string.IsNullOrWhiteSpace(body)) notification.SetBody(body);
        notification.SetDefaultActionAndTarget(action, GLib.Variant.NewString(target));
        Application.SendNotification(id, notification);
    }

    private void StartService()
    {
        if (Config.Service is not { } launch)
        {
            Log("No Cohub CLI bundled; the page signs in on its own");
            return;
        }
        service = new HostService(
            launch,
            State.ServiceHello,
            (name, payload) => Post(() => ServiceEvent(name, payload)),
            hello => Post(() =>
            {
                State.ServiceHello = hello;
                State.Save();
                foreach (var tab in tabs.Values) tab.ServiceStarted();
            }),
            Log);
        service.Start();
    }

    private void ServiceEvent(string name, JsonNode? payload)
    {
        switch (name)
        {
            case HostProtocol.ShellEvents.Open:
                if (JsonFields.Text(payload, "url") is { } link && Uri.TryCreate(link, UriKind.Absolute, out var url) && (url.Scheme == Uri.UriSchemeHttps || url.Scheme == Uri.UriSchemeHttp))
                    ShellWindow.OpenExternally(url.AbsoluteUri);
                return;
            case HostProtocol.Events.RuntimeChanged:
                if (RuntimeOverview.From(payload) is { } next) UpdateFolders(next);
                break;
            case HostProtocol.Events.AuthChanged:
                AccountChanged(payload);
                break;
        }
        foreach (var tab in tabs.Values.ToList()) tab.Emit(name, payload);
    }

    private void AccountChanged(JsonNode? payload)
    {
        var authenticated = JsonFields.Bool(payload, "authenticated") ?? false;
        var redirect = JsonFields.Text(payload, "redirectPath") is { } path && WebOrigin.IsInAppPath(path) ? path : null;
        var front = Primary;
        if (!authenticated)
        {
            closedTabs.Clear();
            foreach (var window in windows.Where(window => window != front).ToList()) window.Discard();
            if (front?.Selected is { } kept)
            {
                foreach (var tab in front.Tabs.Where(tab => tab != kept)) front.Release(tab);
                kept.Load("/");
            }
            SessionChanged();
            return;
        }
        foreach (var tab in tabs.Values.ToList())
        {
            if (tab == front?.Selected && redirect is not null) tab.Load(redirect);
            else tab.Refresh();
        }
        if (redirect is not null) front?.Present();
    }

    private async void Disconnect(string spaceId, bool force = false)
    {
        if (service is null) return;
        var parameters = new JsonObject { ["spaceId"] = spaceId };
        if (force) parameters["force"] = true;
        var reply = await service.CallAsync(new BridgeRequest("stop", HostProtocol.Methods.RuntimeStop, parameters));
        if (reply.Failure is { } failure)
        {
            Primary?.Inform(Strings.L("Couldn’t disconnect this folder"), failure.Message);
            return;
        }
        if (JsonFields.Text(reply.Result, "refused") is null || Primary is not { } window) return;
        if (await window.ConfirmAsync(Strings.L("A task’s result hasn’t been confirmed yet"), Strings.L("Disconnecting stops the Runtime. Results and files are kept."), Strings.L("Disconnect")))
            Disconnect(spaceId, force: true);
    }

    private async void ShowAbout(string? web)
    {
        if (about is not null)
        {
            about.Present();
            return;
        }
        var (version, commit) = CliAbout.AppVersion(typeof(ShellApp).Assembly);
        var dialog = about = Gtk.AboutDialog.New();
        dialog.ProgramName = Config.Title;
        dialog.LogoIconName = Config.AppId;
        dialog.Version = commit is null ? version : $"{version} ({commit})";
        dialog.Website = CliAbout.Repository;
        dialog.WebsiteLabel = "github.com/netaart/cohub";
        dialog.LicenseType = Gtk.License.Apache20;
        dialog.TransientFor = Primary?.Window;
        dialog.OnCloseRequest += (_, _) =>
        {
            about = null;
            return false;
        };
        var webLine = web is null ? null : Strings.Format("Web {0}", web);
        if (webLine is not null) dialog.SystemInformation = webLine;
        dialog.Present();
        if (await CliAbout.FetchAsync(service) is not { } cli || about != dialog) return;
        var lines = cli.Describe(key => Strings.L(key)).ToList();
        if (lines.Any(line => line.Attention)) dialog.Comments = string.Join("\n", lines.Where(line => line.Attention).Select(line => line.Text));
        dialog.SystemInformation = string.Join("\n", lines.Select(line => line.Text).Prepend(webLine).OfType<string>());
    }

    private async Task InstallCommandLineToolAsync()
    {
        var window = Primary;
        if (window is null) return;
        if (!File.Exists(Config.CommandLineTool))
        {
            window.Inform(Strings.L("This build has no command line tool."), Strings.L("Install it with npm install -g @neta-art/cohub-cli."));
            return;
        }
        string? link;
        try
        {
            link = await DesktopEntry.InstallCommandLineToolAsync(Config.CommandLineTool, existing => window.ConfirmAsync(
                Strings.L("Replace the existing cohub command?"),
                Strings.Format("{0} already exists, for example from npm. Cohub will link it to the version inside this app.", existing),
                Strings.L("Replace")));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            window.Inform(Strings.L("Couldn’t install the cohub command"), error.Message);
            return;
        }
        if (link is null) return;
        var directory = Path.GetDirectoryName(link)!;
        var onPath = (System.Environment.GetEnvironmentVariable("PATH") ?? "").Split(':').Any(entry => entry.TrimEnd('/') == directory);
        window.Inform(Strings.L("The cohub command is installed."), onPath ? Strings.L("Open a new terminal and run cohub.") : Strings.Format("Add {0} to your PATH, then run cohub.", directory));
    }

    private static bool IsColor(string hex) =>
        hex.Length == 7 && hex[0] == '#' && uint.TryParse(hex.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out _);

    public static void Log(string line) => Console.Error.WriteLine($"Cohub: {line}");
}
