using System.Text.Json;
using System.Text.Json.Nodes;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellWindow
{
    public static readonly (string Name, string[] Accels)[] Accelerators =
    [
        ("close", ["<Control>w"]),
        ("reload", ["<Control>r", "F5"]),
        ("back", ["<Alt>Left"]),
        ("forward", ["<Alt>Right"]),
        ("zoom-in", ["<Control>plus", "<Control>equal"]),
        ("zoom-out", ["<Control>minus"]),
        ("zoom-reset", ["<Control>0"]),
    ];

    private const string MessageHandler = HostProtocol.Global;
    private const string BridgeWorld = "cohub-host";
    private static readonly TimeSpan RevealTimeout = TimeSpan.FromMilliseconds(2_500);

    private readonly ShellApp app;
    private readonly WebKit.WebView webView;
    private readonly Gtk.MenuButton menuButton;
    private readonly BridgeRouter router;
    private bool closed;

    public ShellWindow(ShellApp app, string path, ShellWindow? sizeFrom)
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
        else if (app.State.Window is { Width: >= 480, Height: >= 360 } saved)
        {
            Window.SetDefaultSize((int)saved.Width, (int)saved.Height);
            if (saved.Maximized) Window.Maximize();
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

        var contents = WebKit.UserContentManager.New();
        var origin = JsonSerializer.Serialize(config.Origin.Origin);
        contents.AddScript(WebKit.UserScript.New(PageScript.Replace("ORIGIN", origin, StringComparison.Ordinal), WebKit.UserContentInjectedFrames.TopFrame, WebKit.UserScriptInjectionTime.Start, null, null));
        contents.AddScript(WebKit.UserScript.NewForWorld(RelayScript.Replace("ORIGIN", origin, StringComparison.Ordinal), WebKit.UserContentInjectedFrames.TopFrame, WebKit.UserScriptInjectionTime.Start, BridgeWorld, null, null));
        WebKit.UserContentManager.ScriptMessageReceivedSignal.Connect(contents, (_, args) => Receive(args.Value), false, MessageHandler);
        contents.RegisterScriptMessageHandler(MessageHandler, BridgeWorld);

        webView = WebKit.WebView.NewWithProperties([
            new GObject.ConstructArgument("network-session", new GObject.Value(app.Session)),
            new GObject.ConstructArgument("user-content-manager", new GObject.Value(contents)),
        ]);
        var settings = webView.GetSettings();
        settings.EnableDeveloperExtras = config.IsDevelopment;
        settings.EnableMediaStream = true;
        settings.EnableWebrtc = true;
        settings.EnableBackForwardNavigationGestures = true;
        webView.Opacity = 0;
        ApplyEdge(app.EdgeColor);
        webView.OnDecidePolicy += (_, args) => DecidePolicy(args.Decision, args.DecisionType);
        webView.OnPermissionRequest += (_, args) => DecidePermission(args.Request);
        webView.OnWebProcessTerminated += (_, _) => webView.Reload();
        webView.OnNotify += (_, args) =>
        {
            switch (args.Pspec.GetName())
            {
                case "title":
                    Window.Title = string.IsNullOrWhiteSpace(webView.GetTitle()) ? config.Title : webView.GetTitle();
                    break;
                case "uri":
                    if (Uri.TryCreate(webView.GetUri(), UriKind.Absolute, out var url) && config.Origin.PathOf(url) is { } visited) app.Visited(visited);
                    break;
            }
        };
        Window.SetChild(webView);
        AddWindowActions();
        Window.OnCloseRequest += (_, _) => CloseRequested();
        ShowState(app.Summary);

        router = app.Router(this);
        Load(path);
        GLib.Functions.TimeoutAdd(0, (uint)RevealTimeout.TotalMilliseconds, () =>
        {
            ShowPage();
            return false;
        });
    }

    public Gtk.ApplicationWindow Window { get; }

    public void Load(string path)
    {
        if (app.Config.Origin.UrlFor(path) is { } url) webView.LoadUri(url.AbsoluteUri);
    }

    public void Reload() => webView.Reload();

    public void Present()
    {
        if (!closed) Window.Present();
    }

    /// The page stays transparent over the edge color until it reports its first screen, so a cold start never flashes.
    public void ShowPage() => webView.Opacity = 1;

    public void ApplyEdge(string hex)
    {
        var color = new Gdk.RGBA();
        if (color.Parse(hex)) webView.SetBackgroundColor(color);
    }

    public void ShowState(RuntimeOverview.State? summary)
    {
        foreach (var name in new[] { "cohub-ready", "cohub-connecting", "cohub-error" }) menuButton.RemoveCssClass(name);
        if (summary is { } state && state != RuntimeOverview.State.Stopped) menuButton.AddCssClass($"cohub-{state.ToString().ToLowerInvariant()}");
        menuButton.TooltipText = summary is { } current ? $"{app.Config.Title} · {ShellApp.Describe(current)}" : app.Config.Title;
    }

    public void Emit(string name, JsonNode? payload)
    {
        if (!closed) router.Emit(name, payload);
    }

    public void ServiceStarted()
    {
        if (router.DescribedWithoutService) Reload();
    }

    public void Deliver(string text)
    {
        if (closed) return;
        _ = DeliverAsync($"window.__cohubHostReceive?.({JsonSerializer.Serialize(text)})");
    }

    private async Task DeliverAsync(string script)
    {
        try { (await webView.EvaluateJavascriptAsync(script)).Dispose(); }
        catch (GLib.GException) { }
    }

    private void Receive(JavaScriptCore.Value value)
    {
        // The relay runs only in the top frame of the web origin, in a world pages and frames cannot reach.
        if (closed || !value.IsString() || !Uri.TryCreate(webView.GetUri(), UriKind.Absolute, out var url) || !app.Config.Origin.Contains(url)) return;
        router.Receive(value.ToString());
    }

    private bool DecidePolicy(WebKit.PolicyDecision decision, WebKit.PolicyDecisionType type)
    {
        switch (decision)
        {
            case WebKit.NavigationPolicyDecision navigation when type == WebKit.PolicyDecisionType.NewWindowAction:
            {
                decision.Ignore();
                if (!Uri.TryCreate(navigation.GetNavigationAction().GetRequest().GetUri(), UriKind.Absolute, out var url)) return true;
                if (app.Config.Origin.PathOf(url) is { } path) app.OpenWindow(path);
                else if (app.Config.Origin.NavigationTo(url) == WebOrigin.Navigation.External) OpenExternally(url.AbsoluteUri);
                return true;
            }
            case WebKit.NavigationPolicyDecision navigation:
            {
                // Frames load freely; which page the window shows is settled on the main frame's response below.
                if (!Uri.TryCreate(navigation.GetNavigationAction().GetRequest().GetUri(), UriKind.Absolute, out var url)) { decision.Ignore(); return true; }
                switch (url.Scheme)
                {
                    case "https" or "http" or "about" or "data" or "blob":
                        return false;
                    case "mailto" or "tel":
                        decision.Ignore();
                        OpenExternally(url.AbsoluteUri);
                        return true;
                    default:
                        decision.Ignore();
                        return true;
                }
            }
            case WebKit.ResponsePolicyDecision response:
            {
                if (response.IsMainFrameMainResource() && Uri.TryCreate(response.GetRequest().GetUri(), UriKind.Absolute, out var url))
                {
                    switch (app.Config.Origin.NavigationTo(url))
                    {
                        case WebOrigin.Navigation.External:
                            decision.Ignore();
                            OpenExternally(url.AbsoluteUri);
                            return true;
                        case WebOrigin.Navigation.Deny:
                            decision.Ignore();
                            return true;
                    }
                }
                if (response.IsMimeTypeSupported()) return false;
                decision.Download();
                return true;
            }
            default:
                return false;
        }
    }

    private bool DecidePermission(WebKit.PermissionRequest request)
    {
        var ours = Uri.TryCreate(webView.GetUri(), UriKind.Absolute, out var url) && app.Config.Origin.Contains(url);
        switch (request)
        {
            case WebKit.UserMediaPermissionRequest when ours:
                request.Allow();
                return true;
            case WebKit.NotificationPermissionRequest:
                request.Deny();
                return true;
            default:
                return false;
        }
    }

    public static void OpenExternally(string uri)
    {
        try { Gio.Functions.AppInfoLaunchDefaultForUri(uri, null); }
        catch (GLib.GException error) { ShellApp.Log($"Could not open {uri}: {error.Message}"); }
    }

    public async Task<JsonNode?> PickFolderAsync(HostService service)
    {
        var dialog = Gtk.FileDialog.New();
        dialog.Title = Strings.L("Choose a folder for agents to work in.");
        dialog.AcceptLabel = Strings.L("Choose");
        dialog.Modal = true;
        Gio.File? folder;
        try { folder = await dialog.SelectFolderAsync(Window); }
        catch (GLib.GException) { throw BridgeException.Canceled(); }
        if (folder?.GetPath() is not { } path) throw BridgeException.Canceled();
        var reply = await service.CallAsync(new BridgeRequest("browse", HostProtocol.Methods.RuntimeBrowse, new JsonObject { ["path"] = path }));
        return reply.Failure is { } failure ? throw failure : reply.Result;
    }

    public Task<bool> ConfirmConnectAsync(string root)
    {
        var name = Path.GetFileName(root.TrimEnd('/'));
        return ConfirmAsync(
            Strings.Format("Connect “{0}” to this Space?", string.IsNullOrEmpty(name) ? root : name),
            Strings.L("People and agents in this Space can change files in this folder and run commands as you on this computer. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space."),
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
        app.Remember(this);
        if (!app.Quitting && app.IsLastWindow(this))
        {
            Window.SetVisible(false);
            return true;
        }
        closed = true;
        app.Closed(this);
        return false;
    }

    private void AddWindowActions()
    {
        void Add(string name, Action run)
        {
            var action = Gio.SimpleAction.New(name, null);
            action.OnActivate += (_, _) => run();
            Window.AddAction(action);
        }
        Add("close", Window.Close);
        Add("reload", webView.Reload);
        Add("back", () => { if (webView.CanGoBack()) webView.GoBack(); });
        Add("forward", () => { if (webView.CanGoForward()) webView.GoForward(); });
        Add("zoom-in", () => webView.ZoomLevel = Math.Min(webView.ZoomLevel + 0.1, 3));
        Add("zoom-out", () => webView.ZoomLevel = Math.Max(webView.ZoomLevel - 0.1, 0.5));
        Add("zoom-reset", () => webView.ZoomLevel = 1);
    }

    // The page's `cohubHost` hands messages to a relay in an isolated world; only that world can reach the native handler.
    private const string PageScript = """
        (() => {
          if (window.top !== window || location.origin !== ORIGIN || window.cohubHost) return;
          const listeners = new Set();
          Object.defineProperty(window, "__cohubHostReceive", {
            value: (data) => {
              for (const listener of listeners) {
                try { listener({ data }); } catch (error) { console.error(error); }
              }
            },
          });
          Object.defineProperty(window, "cohubHost", {
            value: Object.freeze({
              postMessage: (message) => document.dispatchEvent(new CustomEvent("cohubhost:send", { detail: String(message) })),
              addEventListener: (type, listener) => { if (type === "message") listeners.add(listener); },
              removeEventListener: (type, listener) => { if (type === "message") listeners.delete(listener); },
            }),
          });
        })();
        """;

    private const string RelayScript = """
        (() => {
          const handler = window.webkit?.messageHandlers?.cohubHost;
          if (window.top !== window || location.origin !== ORIGIN || !handler) return;
          document.addEventListener("cohubhost:send", (event) => {
            if (typeof event.detail === "string") handler.postMessage(event.detail);
          });
        })();
        """;
}
