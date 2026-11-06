using System.IO;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Input;
using Cohub.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Cohub;

internal sealed class ShellTab : IDisposable
{
    private static readonly TimeSpan SuspendAfter = TimeSpan.FromMinutes(5);

    private readonly ShellApp app;
    private WebView2? view;
    private BridgeRouter? router;
    private string? pendingPath;
    private bool stale;
    private bool suspended;
    private bool usedMedia;
    private DateTimeOffset? hiddenSince = DateTimeOffset.Now;
    private long? loadStarted;
    private bool disposed;

    public ShellTab(ShellApp app, ShellWindow window, SessionTab tab)
    {
        this.app = app;
        Window = window;
        Path = tab.Path;
        Title = tab.Title;
        Edge = tab.Edge;
    }

    public ShellWindow Window { get; set; }
    public ShellTab? Opener { get; set; }
    public string Path { get; private set; }
    public string? Title { get; private set; }
    public string? Edge { get; private set; }
    public bool Dirty { get; private set; }
    public bool Attention { get; private set; }
    public bool CapturesKeys { get; private set; }
    public bool Loaded => view is not null;
    public FrameworkElement? View => view;
    public CoreWebView2? Core => disposed ? null : view?.CoreWebView2;
    public SessionTab Session => new(Path, Title, Edge);

    private WebView2 Ensure()
    {
        if (view is not null) return view;
        view = new WebView2 { Visibility = Visibility.Collapsed };
        view.DefaultBackgroundColor = ToDrawing(app.EdgeColor(Edge));
        view.Loaded += async (_, _) =>
        {
            if (view.CoreWebView2 is not null) return;
            try { await InitializeAsync(view); }
            catch (WebView2RuntimeNotFoundException) { app.WebViewMissing(); }
        };
        Window.Host(this);
        return view;
    }

    private async Task InitializeAsync(WebView2 view)
    {
        await view.EnsureCoreWebView2Async(await app.WebEnvironment);
        if (disposed) return;
        var core = view.CoreWebView2;
        core.Settings.AreDevToolsEnabled = app.Config.IsDevelopment;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        core.WebMessageReceived += OnWebMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.ContentLoading += (_, _) => ResetPage();
        core.PermissionRequested += OnPermissionRequested;
        if (app.WorkspaceFiles is { } files)
        {
            core.AddWebResourceRequestedFilter($"{app.Config.Origin.Origin}{HostProtocol.WorkspacePath}*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) => ServeWorkspaceFile(core, files, e);
        }
        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind is not (CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)) return;
            ResetPage();
            Refresh();
        };
        core.DocumentTitleChanged += (_, _) =>
        {
            Title = TabSession.Title(core.DocumentTitle);
            Window.TabChanged(this);
        };
        core.SourceChanged += (_, _) =>
        {
            if (!Uri.TryCreate(core.Source, UriKind.Absolute, out var url) || app.Config.Origin.PathOf(url) is not { } path) return;
            Path = path;
            app.SessionChanged();
        };
        router = app.Router(this);
        if (pendingPath is { } initial) Load(initial);
    }

    public void Load(string path)
    {
        if (app.Config.Origin.UrlFor(path) is not { } url) return;
        Path = path;
        loadStarted = Environment.TickCount64;
        Ensure();
        if (Core is not { } core)
        {
            pendingPath = path;
            return;
        }
        pendingPath = null;
        Wake();
        core.Navigate(url.ToString());
    }

    public void Reload()
    {
        Wake();
        Core?.Reload();
    }

    public void Refresh()
    {
        if (!Loaded) return;
        if (hiddenSince is null) Reload();
        else stale = true;
    }

    public void Show()
    {
        if (view is null) Load(Path);
        if (view is null) return;
        view.Visibility = Visibility.Visible;
        hiddenSince = null;
        Attention = false;
        if (Core is { } core) core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal;
        Wake();
        if (stale)
        {
            stale = false;
            Reload();
        }
        view.Focus();
    }

    public void Hide()
    {
        hiddenSince ??= DateTimeOffset.Now;
        if (view is null) return;
        view.Visibility = Visibility.Collapsed;
        if (Core is { } core) core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low;
    }

    public async void SuspendIfIdle(DateTimeOffset now)
    {
        if (Core is not { } core || suspended || hiddenSince is not { } since || now - since < SuspendAfter) return;
        if (Dirty || CapturesKeys || usedMedia || core.IsDocumentPlayingAudio) return;
        try { suspended = await core.TrySuspendAsync(); }
        catch (Exception error) when (error is InvalidOperationException or System.Runtime.InteropServices.COMException) { }
        // Shown again while it was freezing: wake now, or it would miss events until hidden and shown again.
        if (hiddenSince is null) Wake();
    }

    private void Wake()
    {
        if (!suspended || Core is not { } core) return;
        suspended = false;
        core.Resume();
        foreach (var (name, payload) in app.LatestEvents) router?.Emit(name, payload);
    }

    public void Update(JsonNode? state)
    {
        if (JsonFields.Bool(state, "dirty") is { } dirty) Dirty = dirty;
        if (JsonFields.Bool(state, "captureKeys") is { } captures) CapturesKeys = captures;
        if (JsonFields.Bool(state, "attention") == true && (hiddenSince is not null || !Window.IsActive)) Attention = true;
        Window.TabChanged(this);
    }

    public void ApplyEdge(string hex)
    {
        Edge = hex;
        if (view is not null) view.DefaultBackgroundColor = ToDrawing(app.EdgeColor(hex));
        Window.TabChanged(this);
    }

    public void ReportReady()
    {
        if (loadStarted is not { } started) return;
        loadStarted = null;
        ShellApp.Log($"First screen in {Environment.TickCount64 - started} ms");
    }

    public void Emit(string name, JsonNode? payload)
    {
        if (!disposed && !suspended) router?.Emit(name, payload);
    }

    public void ServiceStarted()
    {
        if (router?.DescribedWithoutService == true) Refresh();
    }

    public void Deliver(string text) => Core?.PostWebMessageAsString(text);

    private void ResetPage()
    {
        Dirty = false;
        CapturesKeys = false;
        usedMedia = false;
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only the top-level Cohub page may drive native behaviour.
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) || !app.Config.Origin.Contains(source)) return;
        string text;
        try { text = e.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }
        router?.Receive(text);
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var url)) { e.Cancel = true; return; }
        switch (app.Config.Origin.NavigationTo(url))
        {
            case WebOrigin.Navigation.Allow: return;
            case WebOrigin.Navigation.External: e.Cancel = true; ShellWindow.OpenExternally(url); return;
            default: e.Cancel = url.Scheme != "about"; return;
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var url)) return;
        var modifiers = Keyboard.Modifiers;
        if (app.Config.Origin.PathOf(url) is { } path)
            Window.OpenBeside(new SessionTab(path), this, background: modifiers.HasFlag(ModifierKeys.Control) && !modifiers.HasFlag(ModifierKeys.Shift));
        else if (app.Config.Origin.NavigationTo(url) == WebOrigin.Navigation.External) ShellWindow.OpenExternally(url);
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        var ours = Uri.TryCreate(e.Uri, UriKind.Absolute, out var url) && app.Config.Origin.Contains(url);
        if (ours && e.PermissionKind is CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera) usedMedia = true;
        e.State = e.PermissionKind switch
        {
            CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.ClipboardRead when ours => CoreWebView2PermissionState.Allow,
            CoreWebView2PermissionKind.Notifications => CoreWebView2PermissionState.Deny,
            _ => e.State,
        };
    }

    private async void ServeWorkspaceFile(CoreWebView2 core, WorkspaceFiles files, CoreWebView2WebResourceRequestedEventArgs e)
    {
        if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var url) || WorkspaceFiles.Target(url, app.Config.Origin) is not { } target) return;
        var deferral = e.GetDeferral();
        try
        {
            var headers = e.Request.Headers.ToList();
            // Never as a document: workspace files are untrusted and this path is on the app's origin.
            var servable = e.Request.Method == "GET" && e.ResourceContext != CoreWebView2WebResourceContext.Document;
            var response = servable ? await files.SendAsync(target.SpaceId, target.Path, headers, CancellationToken.None) : null;
            if (response is null)
            {
                e.Response = core.Environment.CreateWebResourceResponse(null, 503, "Service Unavailable", "Cache-Control: no-store");
                return;
            }
            var passed = response.Headers.Concat(response.Content.Headers)
                .Where(header => WorkspaceFiles.PassedHeaders.Contains(header.Key, StringComparer.OrdinalIgnoreCase))
                .Select(header => $"{header.Key}: {string.Join(", ", header.Value)}");
            e.Response = core.Environment.CreateWebResourceResponse(
                await response.Content.ReadAsStreamAsync(), (int)response.StatusCode, response.ReasonPhrase ?? "OK", string.Join("\r\n", passed));
        }
        catch (Exception error) when (error is HttpRequestException or IOException or TaskCanceledException)
        {
            e.Response = core.Environment.CreateWebResourceResponse(null, 502, "Bad Gateway", "Cache-Control: no-store");
        }
        finally
        {
            deferral.Complete();
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        view?.Dispose();
    }

    private static System.Drawing.Color ToDrawing(Rgb color) => System.Drawing.Color.FromArgb(color.R, color.G, color.B);

    private const string BridgeScript = """
        (() => {
          const view = window.chrome?.webview;
          if (!view || window.top !== window || window.cohubHost) return;
          Object.defineProperty(window, "cohubHost", {
            value: Object.freeze({
              postMessage: (message) => view.postMessage(String(message)),
              addEventListener: (type, listener) => view.addEventListener(type, listener),
              removeEventListener: (type, listener) => view.removeEventListener(type, listener),
            }),
          });
        })();
        """;
}
