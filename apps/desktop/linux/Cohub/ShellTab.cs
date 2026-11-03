using System.Text.Json;
using System.Text.Json.Nodes;
using Cohub.Core;

namespace Cohub;

internal sealed class ShellTab
{
    private const string MessageHandler = HostProtocol.Global;
    private const string BridgeWorld = "cohub-host";
    private static readonly TimeSpan RevealTimeout = TimeSpan.FromMilliseconds(2_500);

    private readonly ShellApp app;
    private WebKit.WebView? webView;
    private BridgeRouter? router;
    private bool shown;
    private bool stale;
    private long? loadStarted;

    public ShellTab(ShellApp app, ShellWindow window, SessionTab tab)
    {
        this.app = app;
        Window = window;
        Path = tab.Path;
        Title = tab.Title;
        Edge = tab.Edge;
        Container.Hexpand = true;
        Container.Vexpand = true;
    }

    public Gtk.Box Container { get; } = Gtk.Box.New(Gtk.Orientation.Vertical, 0);
    public Adw.TabPage? Page { get; set; }
    public ShellWindow Window { get; set; }
    public string Path { get; private set; }
    public string? Title { get; private set; }
    public string? Edge { get; private set; }
    public bool Dirty { get; private set; }
    public bool CapturesKeys { get; private set; }
    public bool Closing { get; set; }
    public bool Closed { get; private set; }
    public SessionTab Session => new(Path, Title, Edge);

    private WebKit.WebView Ensure()
    {
        if (webView is not null) return webView;
        var config = app.Config;
        var contents = WebKit.UserContentManager.New();
        var origin = JsonSerializer.Serialize(config.Origin.Origin);
        contents.AddScript(WebKit.UserScript.New(PageScript.Replace("ORIGIN", origin, StringComparison.Ordinal), WebKit.UserContentInjectedFrames.TopFrame, WebKit.UserScriptInjectionTime.Start, null, null));
        contents.AddScript(WebKit.UserScript.NewForWorld(RelayScript.Replace("ORIGIN", origin, StringComparison.Ordinal), WebKit.UserContentInjectedFrames.TopFrame, WebKit.UserScriptInjectionTime.Start, BridgeWorld, null, null));
        WebKit.UserContentManager.ScriptMessageReceivedSignal.Connect(contents, (_, args) => Receive(args.Value), false, MessageHandler);
        contents.RegisterScriptMessageHandler(MessageHandler, BridgeWorld);

        var view = WebKit.WebView.NewWithProperties([
            new GObject.ConstructArgument("network-session", new GObject.Value(app.Session)),
            new GObject.ConstructArgument("user-content-manager", new GObject.Value(contents)),
        ]);
        var settings = view.GetSettings();
        settings.EnableDeveloperExtras = config.IsDevelopment;
        settings.EnableMediaStream = true;
        settings.EnableWebrtc = true;
        settings.EnableBackForwardNavigationGestures = true;
        view.Hexpand = true;
        view.Vexpand = true;
        view.Opacity = 0;
        webView = view;
        ApplyEdge(Edge ?? app.EdgeColor, notify: false);
        view.OnDecidePolicy += (_, args) => DecidePolicy(args.Decision, args.DecisionType);
        view.OnPermissionRequest += (_, args) => DecidePermission(args.Request);
        view.OnWebProcessTerminated += (_, _) =>
        {
            ResetPage();
            Refresh();
        };
        view.OnLoadChanged += (_, args) => { if (args.LoadEvent == WebKit.LoadEvent.Committed) ResetPage(); };
        view.OnNotify += (_, args) =>
        {
            switch (args.Pspec.GetName())
            {
                case "title":
                    Title = TabSession.Title(view.GetTitle());
                    Window.TabChanged(this);
                    break;
                case "uri":
                    if (!Uri.TryCreate(view.GetUri(), UriKind.Absolute, out var url) || config.Origin.PathOf(url) is not { } visited) break;
                    Path = visited;
                    app.SessionChanged();
                    break;
                case "is-loading":
                    if (Page is { } page) page.Loading = view.IsLoading;
                    break;
            }
        };
        Container.Append(view);
        router = app.Router(this);
        GLib.Functions.TimeoutAdd(0, (uint)RevealTimeout.TotalMilliseconds, () =>
        {
            view.Opacity = 1;
            return false;
        });
        return view;
    }

    public void Load(string path)
    {
        if (Closed || app.Config.Origin.UrlFor(path) is not { } url) return;
        Path = path;
        loadStarted = Environment.TickCount64;
        Ensure().LoadUri(url.AbsoluteUri);
    }

    public void Reload() => webView?.Reload();

    public void Refresh()
    {
        if (webView is null) return;
        if (shown) Reload();
        else stale = true;
    }

    public void Show()
    {
        shown = true;
        if (webView is null) Load(Path);
        else if (stale) Reload();
        stale = false;
        if (Page is { } page) page.NeedsAttention = false;
        webView?.GrabFocus();
    }

    public void Hide() => shown = false;

    public void Update(JsonNode? state)
    {
        if (JsonFields.Bool(state, "dirty") is { } dirty) Dirty = dirty;
        if (JsonFields.Bool(state, "captureKeys") is { } captures) CapturesKeys = captures;
        if (JsonFields.Bool(state, "attention") == true && Page is { } page && (!shown || !Window.Window.IsActive)) page.NeedsAttention = true;
        Window.TabChanged(this);
    }

    public void ApplyEdge(string hex, bool notify = true)
    {
        Edge = hex;
        var color = new Gdk.RGBA();
        if (color.Parse(hex)) webView?.SetBackgroundColor(color);
        if (notify) Window.TabChanged(this);
    }

    public void ReportReady()
    {
        if (webView is not null) webView.Opacity = 1;
        if (loadStarted is not { } started) return;
        loadStarted = null;
        ShellApp.Log($"First screen in {Environment.TickCount64 - started} ms");
    }

    public void Emit(string name, JsonNode? payload)
    {
        if (!Closed) router?.Emit(name, payload);
    }

    public void ServiceStarted()
    {
        if (router?.DescribedWithoutService == true) Refresh();
    }

    public void Deliver(string text)
    {
        if (Closed || webView is null) return;
        _ = DeliverAsync(webView, $"window.__cohubHostReceive?.({JsonSerializer.Serialize(text)})");
    }

    public void Close()
    {
        Closed = true;
        webView?.TryClose();
    }

    private static async Task DeliverAsync(WebKit.WebView view, string script)
    {
        try { (await view.EvaluateJavascriptAsync(script)).Dispose(); }
        catch (GLib.GException) { }
    }

    private void ResetPage()
    {
        Dirty = false;
        CapturesKeys = false;
        Window.TabChanged(this);
    }

    private void Receive(JavaScriptCore.Value value)
    {
        // The relay runs only in the top frame of the web origin, in a world pages and frames cannot reach.
        if (Closed || webView is null || !value.IsString() || !Uri.TryCreate(webView.GetUri(), UriKind.Absolute, out var url) || !app.Config.Origin.Contains(url)) return;
        router?.Receive(value.ToString());
    }

    private bool DecidePolicy(WebKit.PolicyDecision decision, WebKit.PolicyDecisionType type)
    {
        switch (decision)
        {
            case WebKit.NavigationPolicyDecision navigation when type == WebKit.PolicyDecisionType.NewWindowAction:
            {
                decision.Ignore();
                var action = navigation.GetNavigationAction();
                if (!Uri.TryCreate(action.GetRequest().GetUri(), UriKind.Absolute, out var url)) return true;
                if (app.Config.Origin.PathOf(url) is { } path) Window.OpenBeside(new SessionTab(path), this, background: InBackground(action) ?? false);
                else if (app.Config.Origin.NavigationTo(url) == WebOrigin.Navigation.External) ShellWindow.OpenExternally(url.AbsoluteUri);
                return true;
            }
            case WebKit.NavigationPolicyDecision navigation:
            {
                var action = navigation.GetNavigationAction();
                if (!Uri.TryCreate(action.GetRequest().GetUri(), UriKind.Absolute, out var url)) { decision.Ignore(); return true; }
                if (action.GetNavigationType() == WebKit.NavigationType.LinkClicked && InBackground(action) is { } background && app.Config.Origin.PathOf(url) is { } path)
                {
                    decision.Ignore();
                    Window.OpenBeside(new SessionTab(path), this, background);
                    return true;
                }
                switch (url.Scheme)
                {
                    case "https" or "http" or "about" or "data" or "blob":
                        return false;
                    case "mailto" or "tel":
                        decision.Ignore();
                        ShellWindow.OpenExternally(url.AbsoluteUri);
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
                            ShellWindow.OpenExternally(url.AbsoluteUri);
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

    private static bool? InBackground(WebKit.NavigationAction action)
    {
        var modifiers = (Gdk.ModifierType)action.GetModifiers();
        if (!modifiers.HasFlag(Gdk.ModifierType.ControlMask) && action.GetMouseButton() != 2) return null;
        return !modifiers.HasFlag(Gdk.ModifierType.ShiftMask);
    }

    private bool DecidePermission(WebKit.PermissionRequest request)
    {
        var ours = webView is not null && Uri.TryCreate(webView.GetUri(), UriKind.Absolute, out var url) && app.Config.Origin.Contains(url);
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

    public void Act(string action)
    {
        if (webView is not { } view) return;
        switch (action)
        {
            case "reload": view.Reload(); break;
            case "back": if (view.CanGoBack()) view.GoBack(); break;
            case "forward": if (view.CanGoForward()) view.GoForward(); break;
            case "zoom-in": view.ZoomLevel = Math.Min(view.ZoomLevel + 0.1, 3); break;
            case "zoom-out": view.ZoomLevel = Math.Max(view.ZoomLevel - 0.1, 0.5); break;
            case "zoom-reset": view.ZoomLevel = 1; break;
        }
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
