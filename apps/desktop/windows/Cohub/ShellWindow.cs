using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using Cohub.Core;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Cohub;

internal sealed class ShellWindow : Window, IDisposable
{
    private readonly ShellApp app;
    private readonly WebView2 webView = new();
    private BridgeRouter? router;
    private string? pendingPath;
    private bool closed;

    public ShellWindow(ShellApp app, string path, Window? cascadeFrom)
    {
        this.app = app;
        pendingPath = path;
        Title = "Cohub";
        Width = 1280;
        Height = 820;
        MinWidth = 480;
        MinHeight = 360;
        Icon = app.WindowIcon;
        Content = webView;
        Place(cascadeFrom);
        ApplyEdge(app.EdgeColor);
        InputBindings.Add(new KeyBinding(new Command(() => app.OpenWindow("/")), Key.N, ModifierKeys.Control));
        InputBindings.Add(new KeyBinding(new Command(Close), Key.W, ModifierKeys.Control));
        SourceInitialized += (_, _) => Native.TintTitleBar(Handle, app.EdgeColor);
        Loaded += async (_, _) =>
        {
            try { await InitializeAsync(); }
            catch (WebView2RuntimeNotFoundException) { app.WebViewMissing(); }
        };
    }

    public IntPtr Handle => new WindowInteropHelper(this).Handle;
    public CoreWebView2? Core => closed ? null : webView.CoreWebView2;

    private async Task InitializeAsync()
    {
        await webView.EnsureCoreWebView2Async(await app.WebEnvironment);
        var core = webView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = app.Config.IsDevelopment;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        await core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        core.WebMessageReceived += OnWebMessage;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.PermissionRequested += OnPermissionRequested;
        core.ProcessFailed += (_, e) => { if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive) core.Reload(); };
        core.DocumentTitleChanged += (_, _) => Title = string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Cohub" : core.DocumentTitle;
        core.SourceChanged += (_, _) =>
        {
            if (Uri.TryCreate(core.Source, UriKind.Absolute, out var url) && app.Config.Origin.PathOf(url) is { } path) app.Visited(path);
        };
        router = app.Router(this);
        if (pendingPath is { } initial) Load(initial);
    }

    public void Load(string path)
    {
        if (app.Config.Origin.UrlFor(path) is not { } url) return;
        if (Core is null) { pendingPath = path; return; }
        pendingPath = null;
        Core.Navigate(url.ToString());
    }

    public void Reload() => Core?.Reload();

    public void ApplyEdge(Color color)
    {
        Background = new SolidColorBrush(color);
        webView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(color.R, color.G, color.B);
        if (Handle != IntPtr.Zero) Native.TintTitleBar(Handle, color);
    }

    public void Emit(string name, System.Text.Json.Nodes.JsonNode? payload)
    {
        if (!closed) router?.Emit(name, payload);
    }

    public void ServiceStarted()
    {
        if (router?.DescribedWithoutService == true) Reload();
    }

    public void Deliver(string text) => Core?.PostWebMessageAsString(text);

    public void Reveal()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
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
            case WebOrigin.Navigation.External: e.Cancel = true; OpenExternally(url); return;
            default: e.Cancel = url.Scheme != "about"; return;
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var url)) return;
        if (app.Config.Origin.PathOf(url) is { } path) app.OpenWindow(path);
        else if (app.Config.Origin.NavigationTo(url) == WebOrigin.Navigation.External) OpenExternally(url);
    }

    private void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        var ours = Uri.TryCreate(e.Uri, UriKind.Absolute, out var url) && app.Config.Origin.Contains(url);
        e.State = e.PermissionKind switch
        {
            CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.ClipboardRead when ours => CoreWebView2PermissionState.Allow,
            CoreWebView2PermissionKind.Notifications => CoreWebView2PermissionState.Deny,
            _ => e.State,
        };
    }

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
        var connect = new System.Windows.Forms.TaskDialogButton(Strings.L("Connect"));
        var page = new System.Windows.Forms.TaskDialogPage
        {
            Caption = "Cohub",
            Heading = Strings.Format("Connect “{0}” to a Space?", string.IsNullOrEmpty(name) ? root : name),
            Text = Strings.L("People and agents in the Space can change files in this folder and run commands as you on this PC. Your local Pi, Codex, Claude Code and Cursor chats in this folder, including earlier ones, sync to the Space."),
            Icon = System.Windows.Forms.TaskDialogIcon.ShieldWarningYellowBar,
            Buttons = { connect, System.Windows.Forms.TaskDialogButton.Cancel },
            DefaultButton = connect,
        };
        return Task.FromResult(System.Windows.Forms.TaskDialog.ShowDialog(Handle, page) == connect);
    }

    public Task<bool> ConfirmShareAsync()
    {
        var share = new System.Windows.Forms.TaskDialogButton(Strings.L("Share"));
        var page = new System.Windows.Forms.TaskDialogPage
        {
            Caption = "Cohub",
            Heading = Strings.L("Share this screen with the Space?"),
            Text = Strings.L("People and agents in the Space can see this screen and control this PC until you stop sharing or quit Cohub."),
            Icon = System.Windows.Forms.TaskDialogIcon.ShieldWarningYellowBar,
            Buttons = { share, System.Windows.Forms.TaskDialogButton.Cancel },
            DefaultButton = share,
        };
        return Task.FromResult(System.Windows.Forms.TaskDialog.ShowDialog(Handle, page) == share);
    }

    public void ShowBadge(ImageSource? overlay)
    {
        TaskbarItemInfo ??= new System.Windows.Shell.TaskbarItemInfo();
        TaskbarItemInfo.Overlay = overlay;
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        app.Remember(this);
        if (!app.Quitting && app.IsLastWindow(this))
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        closed = true;
        app.Closed(this);
        Dispose();
        base.OnClosed(e);
    }

    public void Dispose() => webView.Dispose();

    private void Place(Window? cascadeFrom)
    {
        if (cascadeFrom is not null)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Width = cascadeFrom.ActualWidth;
            Height = cascadeFrom.ActualHeight;
            Left = cascadeFrom.Left + 28;
            Top = cascadeFrom.Top + 28;
            return;
        }
        if (app.State.Window is { } saved && IsOnScreen(saved))
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            (Left, Top, Width, Height) = (saved.Left, saved.Top, saved.Width, saved.Height);
            if (saved.Maximized) WindowState = WindowState.Maximized;
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

    private sealed class Command(Action run) : ICommand
    {
        public event EventHandler? CanExecuteChanged { add { } remove { } }
        public bool CanExecute(object? parameter) => true;
        public void Execute(object? parameter) => run();
    }
}
