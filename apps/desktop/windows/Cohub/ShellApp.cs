using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using System.Windows.Threading;
using Cohub.Core;
using Microsoft.Web.WebView2.Core;

namespace Cohub;

internal sealed class ShellApp : Application, IDisposable
{
    public const string FolderArgument = "folder:";

    private readonly SingleInstance instance;
    private readonly string? startArgument;
    private readonly List<ShellWindow> windows = [];
    private readonly ClosedTabs closedTabs = new();
    private readonly RepeatFilter repeats = new();
    private readonly Dictionary<string, JsonNode?> latestEvents = [];
    private readonly DispatcherTimer saving = new() { Interval = TimeSpan.FromMilliseconds(500) };
    private readonly CancellationTokenSource stopping = new();
    private HostService? service;
    private TrayIcon? tray;
    private Updates? updates;
    private Task<CoreWebView2Environment>? environment;
    private GlobalShortcut? shortcut;
    private ImageSource? badge;

    public ShellApp(ShellConfig config, SingleInstance instance, string? startArgument)
    {
        Config = config;
        State = ShellState.Load(config.DataDirectory);
        this.instance = instance;
        this.startArgument = startArgument;
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        saving.Tick += (_, _) => SaveSession();
        using var stream = typeof(ShellApp).Assembly.GetManifestResourceStream("Cohub.ico");
        if (stream is not null) WindowIcon = BitmapFrame.Create(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
    }

    public ShellConfig Config { get; }
    public ShellState State { get; }
    public WorkspaceFiles? WorkspaceFiles { get; private set; }
    public ImageSource? WindowIcon { get; }
    public bool Quitting { get; private set; }

    public bool CanReopenClosedTab => !closedTabs.IsEmpty;

    public IEnumerable<(string Name, JsonNode? Payload)> LatestEvents => latestEvents.Select(entry => (entry.Key, entry.Value));

    public Color EdgeColor(string? hex) =>
        hex is not null && TryParseColor(hex, out var color) ? color
        : State.EdgeColor is { } fallback && TryParseColor(fallback, out var last) ? last
        : SystemColors.WindowColor;

    public Task<CoreWebView2Environment> WebEnvironment => environment ??= CoreWebView2Environment.CreateAsync(null, Path.Combine(Config.DataDirectory, "WebView2"));

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        try { Registration.Register(Config); }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException) { Log($"Could not register {Config.UrlScheme}://: {error.Message}"); }
        StartService();
        _ = new Toasts(path => Dispatcher.BeginInvoke(() => Open(path)));
        tray = new TrayIcon(TrayIconImage(), new TrayIcon.Actions(
            ShowCohub: ShowPrimary,
            NewWindow: () => OpenWindow("/"),
            OpenSpace: spaceId => Open($"/spaces/{spaceId}"),
            Disconnect: spaceId => Disconnect(spaceId),
            NewSpace: () => Open("/spaces/new"),
            StopSharing: StopSharing,
            InstallCommandLineTool: InstallCommandLineTool,
            RestartToUpdate: () => updates?.RestartNow(),
            Quit: Quit));
        instance.Listen(Config.InstanceName, argument => Dispatcher.BeginInvoke(() => Handle(argument)));
        shortcut = new GlobalShortcut(ShowPrimary);
        shortcut.Set(State.GlobalShortcut);
        Restore();
        if (PathOf(startArgument) is { } path) Open(path);
        UpdateJumpList();
        updates = new Updates(Config.FeedUrl, () => Dispatcher.BeginInvoke(() => tray?.UpdateReady()), Log);
        _ = updates.RunAsync(stopping.Token);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        updates?.ApplyOnExit();
        Dispose();
        base.OnExit(e);
    }

    public void Dispose()
    {
        stopping.Cancel();
        stopping.Dispose();
        service?.Dispose();
        tray?.Dispose();
        shortcut?.Dispose();
    }

    private void Restore()
    {
        if (State.Session is not { Windows.Count: > 0 } session)
        {
            OpenWindow("/");
            return;
        }
        foreach (var saved in session.Windows)
        {
            var window = NewWindow(saved.Placement);
            for (var index = 0; index < saved.Tabs.Count; index++) window.Add(saved.Tabs[index], select: false, loads: false);
            window.Select(window.Tabs[saved.Selected]);
            window.Show();
        }
        windows[^1].Activate();
    }

    private ShellWindow NewWindow(ShellState.Placement? placement = null)
    {
        var window = new ShellWindow(this, Primary is { IsVisible: true } front ? front : null, placement);
        windows.Add(window);
        if (badge is not null) window.ShowBadge(badge);
        return window;
    }

    public ShellWindow OpenWindow(string path)
    {
        var window = NewWindow();
        window.Add(new SessionTab(path));
        window.Show();
        window.Activate();
        return window;
    }

    public void MoveToNewWindow(ShellTab tab)
    {
        var window = NewWindow();
        window.Show();
        window.Adopt(tab, 0);
        window.Activate();
    }

    public void ReopenClosedTab(ShellWindow window)
    {
        if (closedTabs.Pop() is not { } closed) return;
        window.Add(closed.Tab, closed.Index);
        window.Reveal();
    }

    public void Open(string path)
    {
        if (!WebOrigin.IsInAppPath(path)) return;
        var shown = windows.SelectMany(window => window.Tabs).LastOrDefault(tab => TabSession.SamePage(tab.Path, path) && (tab.Path == path || !tab.Dirty));
        if (shown is not null)
        {
            if (shown.Path != path) shown.Load(path);
            shown.Window.Select(shown);
            shown.Window.Reveal();
        }
        else if (Primary is { } front)
        {
            if (front.Selected is { Path: "/" } home) home.Load(path);
            else front.Add(new SessionTab(path));
            front.Reveal();
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
        SessionChanged();
    }

    public void Closed(ShellTab tab, int index)
    {
        if (!Quitting) closedTabs.Push(tab.Session, index);
    }

    public void Closed(ShellWindow window)
    {
        windows.Remove(window);
        SessionChanged();
    }

    public void SessionChanged()
    {
        if (Quitting) return;
        saving.Stop();
        saving.Start();
    }

    private void SaveSession()
    {
        saving.Stop();
        var saved = windows.Where(window => window.Tabs.Count > 0).Select(window =>
            new SessionWindow([.. window.Tabs.Select(tab => tab.Session)], window.SelectedIndex, window.Placement()));
        State.Session = new TabSession([.. saved]).Sanitized();
        State.Save();
    }

    private ShellWindow? Primary => windows.LastOrDefault(window => window.IsActive) ?? windows.LastOrDefault(window => window.IsVisible) ?? windows.LastOrDefault();

    private void ShowPrimary()
    {
        if (Primary is { } window) window.Reveal();
        else OpenWindow("/");
    }

    private void Handle(string argument)
    {
        if (argument == "--new-window") OpenWindow("/");
        else if (PathOf(argument) is { } path) Open(path);
        else ShowPrimary();
    }

    private string? PathOf(string? argument)
    {
        if (argument is null) return null;
        return argument.StartsWith(FolderArgument, StringComparison.Ordinal)
            ? WebOrigin.NewSpacePath(argument[FolderArgument.Length..])
            : WebOrigin.PathFromDeepLink(argument, Config.UrlScheme);
    }

    private void Quit()
    {
        if (windows.SelectMany(window => window.Tabs).FirstOrDefault(tab => tab.Dirty) is { } dirty && !dirty.Window.ConfirmDiscard(Strings.L("Some tabs have unsaved changes"))) return;
        SaveSession();
        Quitting = true;
        foreach (var window in windows.ToList()) window.Close();
        Shutdown();
    }

    public BridgeRouter Router(ShellTab tab)
    {
        List<string> capabilities = [
            HostProtocol.Capabilities.Appearance, HostProtocol.Capabilities.Navigation, HostProtocol.Capabilities.Share,
            HostProtocol.Capabilities.Cache, HostProtocol.Capabilities.Notifications, HostProtocol.Capabilities.Shortcuts,
            HostProtocol.Capabilities.MediaCapture, HostProtocol.Capabilities.Permissions, HostProtocol.Capabilities.Badge,
            HostProtocol.Capabilities.LaunchAtLogin, HostProtocol.Capabilities.GlobalShortcut, HostProtocol.Capabilities.Launch,
            HostProtocol.Capabilities.Tabs,
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
                if (JsonFields.Text(parameters, "backgroundColor") is not { } hex || !TryParseColor(hex, out _)) throw BridgeException.Failed("appearance.set requires a #rrggbb backgroundColor");
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
            [HostProtocol.Methods.ShareText] = parameters =>
            {
                if (JsonFields.Text(parameters, "text") is not { } text) throw BridgeException.Failed("share.text requires text");
                Native.Share(tab.Window.Handle, text, JsonFields.Text(parameters, "title"));
                return Ok();
            },
            [HostProtocol.Methods.CacheClear] = async _ =>
            {
                if (tab.Core is { } core) await core.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
                return true;
            },
            [HostProtocol.Methods.NotificationsRegister] = _ => Task.FromResult<JsonNode?>(Toasts.Enabled),
            [HostProtocol.Methods.NotificationsShow] = parameters =>
            {
                if (JsonFields.Text(parameters, "id") is not { } id || JsonFields.Text(parameters, "title") is not { } title || JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path))
                    throw BridgeException.Failed("notifications.show requires an id, a title and an in-app path");
                var body = JsonFields.Text(parameters, "body");
                if (!repeats.Admits($"{id}\n{title}\n{body}", DateTimeOffset.Now)) return Ok();
                return Task.FromResult<JsonNode?>(Toasts.Show(id, title, body, path));
            },
            [HostProtocol.Methods.PermissionsStatus] = _ => Task.FromResult<JsonNode?>(new JsonObject { ["notifications"] = NotificationState }),
            [HostProtocol.Methods.PermissionsRequest] = parameters =>
                JsonFields.Text(parameters, "kind") == "notifications" ? Task.FromResult<JsonNode?>(NotificationState) : throw BridgeException.Failed("This permission cannot be requested"),
            [HostProtocol.Methods.PermissionsOpenSettings] = parameters =>
            {
                if (JsonFields.Text(parameters, "kind") is not { } kind || PermissionSettings.UriFor(kind) is not { } uri) return Task.FromResult<JsonNode?>(false);
                Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true })?.Dispose();
                return Ok();
            },
            [HostProtocol.Methods.BadgeSet] = parameters =>
            {
                var count = parameters?["count"]?.GetValue<int>() ?? 0;
                badge = count > 0 ? TaskbarBadge.Render(count) : null;
                foreach (var open in windows) open.ShowBadge(badge);
                return Ok();
            },
            [HostProtocol.Methods.LaunchAtLogin] = parameters =>
            {
                if (JsonFields.Bool(parameters, "enabled") is { } enabled) Registration.SetLaunchAtLogin(Config, enabled);
                return Task.FromResult<JsonNode?>(Registration.LaunchesAtLogin(Config));
            },
            [HostProtocol.Methods.GlobalShortcut] = parameters =>
            {
                if (JsonFields.Bool(parameters, "enabled") is { } enabled)
                {
                    State.GlobalShortcut = enabled;
                    State.Save();
                    shortcut?.Set(enabled);
                }
                return Task.FromResult<JsonNode?>(State.GlobalShortcut);
            },
            [HostProtocol.Methods.ShortcutsPush] = parameters =>
            {
                if (JsonFields.Text(parameters, "id") is not { } id || JsonFields.Text(parameters, "label") is not { } label || JsonFields.Text(parameters, "path") is not { } path || !WebOrigin.IsInAppPath(path))
                    throw BridgeException.Failed("shortcuts.push requires an id, a label and an in-app path");
                State.PushShortcut(new(id, label, path));
                UpdateJumpList();
                return Ok();
            },
        };
        if (service is { } host)
        {
            capabilities.Add(HostProtocol.Capabilities.RuntimePicker);
            capabilities.Add(HostProtocol.Capabilities.WorkspaceFiles);
            handlers[HostProtocol.Methods.RuntimePickFolder] = parameters => tab.Window.PickFolderAsync(host, JsonFields.Text(parameters, "path"));
        }
        return new BridgeRouter("windows", State.HostId, capabilities, handlers, service, request => request.Root is { } root ? tab.Window.ConfirmConnectAsync(root) : tab.Window.ConfirmShareAsync(), tab.Deliver);
    }

    private static Task<JsonNode?> Ok() => Task.FromResult<JsonNode?>(true);

    private static string NotificationState => Toasts.Enabled ? "granted" : "denied";

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
            (name, payload) => Dispatcher.BeginInvoke(() => ServiceEvent(name, payload)),
            hello => Dispatcher.BeginInvoke(() =>
            {
                State.ServiceHello = hello;
                State.Save();
                foreach (var tab in AllTabs) tab.ServiceStarted();
            }),
            Log);
        WorkspaceFiles = new WorkspaceFiles(service);
        service.Start();
    }

    private void ServiceEvent(string name, JsonNode? payload)
    {
        switch (name)
        {
            case HostProtocol.ShellEvents.Open:
                if (JsonFields.Text(payload, "url") is { } link && Uri.TryCreate(link, UriKind.Absolute, out var url) && (url.Scheme == Uri.UriSchemeHttps || url.Scheme == Uri.UriSchemeHttp))
                    ShellWindow.OpenExternally(url);
                return;
            case HostProtocol.Events.RuntimeChanged:
                if (RuntimeOverview.From(payload) is { } overview) tray?.Update(overview);
                latestEvents[name] = payload;
                break;
            case HostProtocol.Events.DisplayChanged:
                tray?.UpdateSharing(JsonFields.Text(payload, "sharedWith") is not null);
                latestEvents[name] = payload;
                break;
            case HostProtocol.Events.AuthChanged:
                AccountChanged(payload);
                break;
        }
        foreach (var tab in AllTabs) tab.Emit(name, payload);
    }

    private IEnumerable<ShellTab> AllTabs => windows.SelectMany(window => window.Tabs).ToList();

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
                foreach (var tab in front.Tabs.Where(tab => tab != kept).ToList()) front.Release(tab);
                kept.Load("/");
            }
            SessionChanged();
            return;
        }
        foreach (var tab in AllTabs)
        {
            if (tab == front?.Selected && redirect is not null) tab.Load(redirect);
            else tab.Refresh();
        }
        if (redirect is not null) front?.Reveal();
    }

    private async void Disconnect(string spaceId, bool force = false)
    {
        if (service is null) return;
        var parameters = new JsonObject { ["spaceId"] = spaceId };
        if (force) parameters["force"] = true;
        var reply = await service.CallAsync(new BridgeRequest("stop", HostProtocol.Methods.RuntimeStop, parameters));
        if (reply.Failure is { } failure)
        {
            Inform(Strings.L("Couldn’t disconnect this folder"), failure.Message);
            return;
        }
        if (JsonFields.Text(reply.Result, "refused") is null) return;
        var disconnect = new System.Windows.Forms.TaskDialogButton(Strings.L("Disconnect"));
        var answer = System.Windows.Forms.TaskDialog.ShowDialog(Primary?.Handle ?? IntPtr.Zero, new System.Windows.Forms.TaskDialogPage
        {
            Caption = "Cohub",
            Heading = Strings.L("A task’s result hasn’t been confirmed yet"),
            Text = Strings.L("Disconnecting stops the Runtime. Results and files are kept."),
            Icon = System.Windows.Forms.TaskDialogIcon.Warning,
            Buttons = { disconnect, System.Windows.Forms.TaskDialogButton.Cancel },
        });
        if (answer == disconnect) Disconnect(spaceId, force: true);
    }

    private async void StopSharing()
    {
        if (service is not null) await service.CallAsync(new BridgeRequest("stop", HostProtocol.Methods.DisplayStop));
    }

    private void UpdateJumpList()
    {
        var executable = Environment.ProcessPath;
        if (executable is null) return;
        var list = new JumpList { ShowFrequentCategory = false, ShowRecentCategory = false };
        foreach (var shortcut in State.Shortcuts)
        {
            list.JumpItems.Add(new JumpTask
            {
                Title = shortcut.Label,
                Arguments = $"{Config.UrlScheme}://open{shortcut.Path}",
                ApplicationPath = executable,
                IconResourcePath = executable,
                CustomCategory = Strings.L("Recent"),
            });
        }
        list.JumpItems.Add(new JumpTask { Title = Strings.L("New Window"), Arguments = "--new-window", ApplicationPath = executable, IconResourcePath = executable });
        JumpList.SetJumpList(this, list);
        list.Apply();
    }

    private void InstallCommandLineTool()
    {
        var tool = Config.CommandLineTool;
        if (!File.Exists(Path.Combine(tool, "cohub.cmd")))
        {
            Inform(Strings.L("This build has no command line tool."), Strings.L("Install it with npm install -g @neta-art/cohub-cli."));
            return;
        }
        if (!Registration.IsOnPath(tool)) Registration.SetOnPath(tool, true);
        Inform(Strings.L("The cohub command is installed."), Strings.L("Open a new terminal and run cohub."));
    }

    private bool webViewMissingShown;

    public void WebViewMissing()
    {
        if (webViewMissingShown) return;
        webViewMissingShown = true;
        Inform(Strings.L("Cohub needs the Microsoft Edge WebView2 Runtime."), Strings.L("Install it, then open Cohub again."));
        ShellWindow.OpenExternally(new Uri("https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
        Quit();
    }

    private void Inform(string heading, string text) => System.Windows.Forms.TaskDialog.ShowDialog(
        Primary?.Handle ?? IntPtr.Zero,
        new System.Windows.Forms.TaskDialogPage { Caption = "Cohub", Heading = heading, Text = text, Icon = System.Windows.Forms.TaskDialogIcon.Information });

    private static System.Drawing.Icon TrayIconImage()
    {
        using var stream = typeof(ShellApp).Assembly.GetManifestResourceStream("Cohub.ico");
        return stream is null ? (System.Drawing.Icon)System.Drawing.SystemIcons.Application.Clone() : new System.Drawing.Icon(stream, System.Windows.Forms.SystemInformation.SmallIconSize);
    }

    private static bool TryParseColor(string hex, out Color color)
    {
        color = default;
        if (hex.Length != 7 || hex[0] != '#' || !uint.TryParse(hex.AsSpan(1), System.Globalization.NumberStyles.HexNumber, null, out var value)) return false;
        color = Color.FromRgb((byte)(value >> 16), (byte)(value >> 8), (byte)value);
        return true;
    }

    public static void Log(string line) => Trace.WriteLine(line, "Cohub");
}
