using System.Globalization;
using System.Text.Json.Nodes;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellApp : IDisposable
{
    private readonly List<ShellWindow> windows = [];
    private readonly CancellationTokenSource stopping = new();
    private readonly Gio.Menu folders = Gio.Menu.New();
    private readonly Gio.Menu updateSection = Gio.Menu.New();
    private SynchronizationContext? main;
    private HostService? service;
    private Updates? updates;
    private Gtk.CssProvider? edgeStyle;
    private RuntimeOverview overview = RuntimeOverview.Empty;

    public ShellApp(ShellConfig config)
    {
        Config = config;
        State = ShellState.Load(config.DataDirectory);
        // A second launch hands its URI to this instance over D-Bus and exits.
        Application = Gtk.Application.New(config.AppId, Gio.ApplicationFlags.HandlesOpen);
        Application.OnStartup += (_, _) => Startup();
        Application.OnActivate += (_, _) => Handle(null);
        Application.OnOpen += (_, args) =>
        {
            foreach (var file in args.Files) Handle(file.GetUri());
        };
        Application.OnShutdown += (_, _) => Shutdown();
    }

    public ShellConfig Config { get; }
    public ShellState State { get; }
    public Gtk.Application Application { get; }
    public Gio.Menu Menu { get; } = Gio.Menu.New();
    public WebKit.NetworkSession Session { get; private set; } = null!;
    public bool Quitting { get; private set; }

    public string EdgeColor => State.EdgeColor is { } hex && IsColor(hex) ? hex : "#ffffff";

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
        updates = new Updates(Config.FeedUrl, () => Post(() => { updateSection.RemoveAll(); updateSection.Append(Strings.L("Restart to Update"), "app.restart-to-update"); }), Log);
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

    public ShellWindow OpenWindow(string path)
    {
        var window = new ShellWindow(this, path, windows.LastOrDefault(item => item.Window.GetVisible()));
        windows.Add(window);
        window.Present();
        return window;
    }

    public void Open(string path)
    {
        if (!WebOrigin.IsInAppPath(path)) return;
        if (Primary is { } window)
        {
            window.Load(path);
            window.Present();
        }
        else
        {
            OpenWindow(path);
        }
    }

    public bool IsLastWindow(ShellWindow window) => windows.Count == 1 && windows[0] == window;

    public void Closed(ShellWindow window) => windows.Remove(window);

    public void Visited(string path)
    {
        if (State.LastPath == path) return;
        State.LastPath = path;
        State.Save();
    }

    public void Remember(ShellWindow window)
    {
        if (windows.FirstOrDefault() != window) return;
        State.Window = window.Placement();
        State.Save();
    }

    private ShellWindow? Primary => windows.FirstOrDefault(window => window.Window.IsActive) ?? windows.FirstOrDefault(window => window.Window.GetVisible()) ?? windows.FirstOrDefault();

    private void ShowPrimary()
    {
        if (Primary is { } window) window.Present();
        else OpenWindow(State.LastPath ?? "/");
    }

    private void Handle(string? argument)
    {
        if (argument == $"{Config.UrlScheme}://new-window") OpenWindow("/");
        else if (argument is not null && WebOrigin.PathFromDeepLink(argument, Config.UrlScheme) is { } path) Open(path);
        else if (windows.Count == 0) OpenWindow(State.LastPath ?? "/");
        else ShowPrimary();
    }

    private void Quit()
    {
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
        Add("new-window", () => OpenWindow("/"), "<Control>n");
        Add("quit", Quit, "<Control>q");
        Add("install-command-line-tool", () => _ = InstallCommandLineToolAsync());
        Add("restart-to-update", () => updates?.RestartNow());
        AddWithText("open-path", Open);
        AddWithText("open-space", spaceId => Open($"/spaces/{spaceId}"));
        AddWithText("show-folder", root => ShellWindow.OpenExternally(new Uri(root).AbsoluteUri));
        AddWithText("disconnect", Disconnect);
        foreach (var (name, accels) in ShellWindow.Accelerators) Application.SetAccelsForAction($"win.{name}", accels);
    }

    private void BuildMenu()
    {
        var windowSection = Gio.Menu.New();
        windowSection.Append(Strings.L("New Window"), "app.new-window");
        var toolSection = Gio.Menu.New();
        toolSection.Append(Strings.L("Install Command Line Tool"), "app.install-command-line-tool");
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

    public void ApplyEdge(string hex)
    {
        var value = uint.Parse(hex.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var dark = 0.2126 * (value >> 16 & 0xFF) + 0.7152 * (value >> 8 & 0xFF) + 0.0722 * (value & 0xFF) < 128;
        if (Gtk.Settings.GetDefault() is { } settings) settings.GtkApplicationPreferDarkTheme = dark;
        var foreground = dark ? "#ffffff" : "#1f1f1f";
        edgeStyle?.LoadFromData($$"""
            window.cohub, window.cohub headerbar { background: {{hex}}; color: {{foreground}}; }
            window.cohub headerbar { box-shadow: none; border-bottom: none; }
            menubutton.cohub-ready image { color: #16a34a; }
            menubutton.cohub-connecting image { color: #eab308; }
            menubutton.cohub-error image { color: #dc2626; }
            """, -1);
        foreach (var window in windows) window.ApplyEdge(hex);
    }

    public BridgeRouter Router(ShellWindow window)
    {
        List<string> capabilities = [
            HostProtocol.Capabilities.Launch, HostProtocol.Capabilities.Appearance, HostProtocol.Capabilities.Navigation,
            HostProtocol.Capabilities.Notifications, HostProtocol.Capabilities.Shortcuts, HostProtocol.Capabilities.MediaCapture,
        ];
        var handlers = new Dictionary<string, BridgeRouter.Handler>
        {
            [HostProtocol.Methods.AppReady] = _ =>
            {
                window.ShowPage();
                return Ok();
            },
            [HostProtocol.Methods.AppearanceSet] = parameters =>
            {
                if (JsonFields.Text(parameters, "backgroundColor") is not { } hex || !IsColor(hex)) throw BridgeException.Failed("appearance.set requires a #rrggbb backgroundColor");
                if (State.EdgeColor != hex)
                {
                    State.EdgeColor = hex;
                    State.Save();
                    ApplyEdge(hex);
                }
                return Ok();
            },
            [HostProtocol.Methods.NavigationOpenPath] = parameters =>
            {
                if (JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path)) throw BridgeException.Failed("navigation.openPath requires an in-app path");
                window.Load(path);
                return Ok();
            },
            [HostProtocol.Methods.NotificationsRegister] = _ => Ok(),
            [HostProtocol.Methods.NotificationsShow] = parameters =>
            {
                if (JsonFields.Text(parameters, "id") is not { } id || JsonFields.Text(parameters, "title") is not { } title || JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path))
                    throw BridgeException.Failed("notifications.show requires an id, a title and an in-app path");
                Notify(id, title, JsonFields.Text(parameters, "body"), "app.open-path", path);
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
            handlers[HostProtocol.Methods.RuntimePickFolder] = _ => window.PickFolderAsync(host);
        }
        return new BridgeRouter("linux", State.HostId, capabilities, handlers, service, (root, _) => window.ConfirmConnectAsync(root), window.Deliver);
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
                foreach (var window in windows) window.ServiceStarted();
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
        foreach (var window in windows) window.Emit(name, payload);
    }

    private void AccountChanged(JsonNode? payload)
    {
        var authenticated = JsonFields.Bool(payload, "authenticated") ?? false;
        var redirect = JsonFields.Text(payload, "redirectPath") is { } path && WebOrigin.IsInAppPath(path) ? path : null;
        if (!authenticated)
        {
            State.LastPath = null;
            State.Save();
        }
        var front = Primary;
        foreach (var window in windows)
        {
            if (!authenticated) window.Load("/");
            else if (window == front && redirect is not null) window.Load(redirect);
            else window.Reload();
        }
        if (authenticated && redirect is not null) front?.Present();
    }

    private async void Disconnect(string spaceId)
    {
        if (service is null) return;
        var reply = await service.CallAsync(new BridgeRequest("stop", HostProtocol.Methods.RuntimeStop, new JsonObject { ["spaceId"] = spaceId }));
        if (reply.Failure is { } failure) Primary?.Inform(Strings.L("Couldn’t disconnect this folder"), failure.Message);
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
