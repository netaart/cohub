using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;
using Velopack;

[assembly: SupportedOSPlatform("linux")]

namespace Cohub;

internal static class Program
{
    private static int Main(string[] args)
    {
        AppImage.Remember();
        var config = ShellConfig.Load();
        using var instance = Instance.Claim(config, args, out var handedOff);
        if (instance is null) return handedOff ? 0 : 1;
        // Never start a version another process already replaced or is replacing: Velopack would apply the same
        // package again on start-up. Free the lock for the updater's restart and start the installed AppImage.
        if (AppImage.Superseded())
        {
            ShellApp.Log("The AppImage was replaced while this launch started; starting the installed one");
            instance.Dispose();
            AppImage.Relaunch(args);
            return 0;
        }
        VelopackApp.Build().Run();
        if (!HasToolkit(out var problem))
        {
            var message = Strings.L("Cohub needs GTK 4.10, libadwaita 1.2 and WebKitGTK 6.0.");
            var hint = Strings.L("Install libadwaita-1-0 and libwebkitgtk-6.0-4 (Debian, Ubuntu), libadwaita and webkitgtk6.0 (Fedora) or libadwaita and webkitgtk-6.0 (Arch), then open Cohub again.");
            Console.Error.WriteLine($"{message} {hint} ({problem})");
            try { Process.Start(new ProcessStartInfo("notify-send", ["--app-name=Cohub", message, hint]) { UseShellExecute = false })?.Dispose(); }
            catch (System.ComponentModel.Win32Exception) { }
            return 1;
        }
        return new ShellApp(config).Run(args);
    }

    private static bool HasToolkit(out string problem)
    {
        try
        {
            WebKit.Module.Initialize();
            Adw.Module.Initialize();
            var gtk = new Version((int)Gtk.Functions.GetMajorVersion(), (int)Gtk.Functions.GetMinorVersion());
            var adwaita = new Version((int)Adw.Functions.GetMajorVersion(), (int)Adw.Functions.GetMinorVersion());
            problem = $"GTK {gtk}, libadwaita {adwaita}, WebKitGTK {WebKit.Functions.GetMajorVersion()}.{WebKit.Functions.GetMinorVersion()}";
            return gtk >= new Version(4, 10) && adwaita >= new Version(1, 2);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or TypeInitializationException)
        {
            problem = error.Message;
            return false;
        }
    }
}

/// One process per data directory. The lock is taken before Velopack or GTK start, so a second launch
/// can neither apply an update under the running app nor open the same WebKit data.
internal static class Instance
{
    private static readonly TimeSpan HandoffTimeout = TimeSpan.FromSeconds(2.5);

    public static FileStream? Claim(ShellConfig config, string[] args, out bool handedOff)
    {
        handedOff = false;
        Directory.CreateDirectory(config.DataDirectory);
        var path = Path.Combine(config.DataDirectory, "instance.lock");
        var deadline = DateTime.UtcNow + HandoffTimeout;
        string reason;
        // The owner may still be starting (not yet on D-Bus) or exiting (about to free the lock), so retry both.
        while (true)
        {
            try { return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException error) when (error.HResult == EWOULDBLOCK) { }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                ShellApp.Log($"Could not lock {path}: {error.Message}");
                return null;
            }
            if (Handoff(config.AppId, args, deadline - DateTime.UtcNow, out reason))
            {
                handedOff = true;
                return null;
            }
            if (DateTime.UtcNow >= deadline) break;
            Thread.Sleep(100);
        }
        ShellApp.Log($"Another Cohub process holds {path} but did not take this launch ({string.Join(' ', args)}) within {HandoffTimeout.TotalSeconds}s: {reason}");
        return null;
    }

    private const int EWOULDBLOCK = 11;

    // Registering a launcher succeeds only once the owner answers on D-Bus; Run then forwards the
    // open or activate request to it, the same way a second GApplication instance does.
    private static bool Handoff(string appId, string[] args, TimeSpan timeout, out string reason)
    {
        try
        {
            Gio.Module.Initialize();
            var launcher = Gio.Application.New(appId, Gio.ApplicationFlags.HandlesOpen | Gio.ApplicationFlags.IsLauncher);
            var cancellable = Gio.Cancellable.New();
            using (new Timer(_ => cancellable.Cancel(), null, timeout > TimeSpan.Zero ? timeout : TimeSpan.Zero, Timeout.InfiniteTimeSpan))
            {
                if (!launcher.Register(cancellable))
                {
                    reason = "no running instance on D-Bus";
                    return false;
                }
            }
            var status = launcher.Run([ShellConfig.Executable, .. args]);
            reason = $"handoff exited with {status}";
            return status == 0;
        }
        catch (Exception error) when (error is GLib.GException or DllNotFoundException or EntryPointNotFoundException or TypeInitializationException)
        {
            reason = error.Message;
            return false;
        }
    }
}

/// Velopack replaces the AppImage file in place; this process keeps running the one it was started from.
internal static class AppImage
{
    private static readonly TimeSpan UpdaterTimeout = TimeSpan.FromSeconds(60);
    private static readonly string? Image = Environment.GetEnvironmentVariable("APPIMAGE") is { Length: > 0 } path ? path : null;
    private static (long, DateTime)? launched;

    /// Records the file this launch came from; call first thing, before waiting on another instance.
    public static void Remember() => launched = Identity();

    public static bool Replaced() => Image is not null && Identity() != launched;

    public static bool Superseded() => Replaced() || BeingUpdated();

    public static bool BeingUpdated()
    {
        if (Image is null) return false;
        foreach (var entry in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(entry), out _)) continue;
            string[] argv;
            try { argv = File.ReadAllText(Path.Combine(entry, "cmdline")).Split('\0'); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { continue; }
            if (argv.Length < 2 || Path.GetFileName(argv[0]) != "UpdateNix" || !argv.Contains("apply")) continue;
            var root = Array.IndexOf(argv, "--rootDir");
            if (root >= 0 && root + 1 < argv.Length && argv[root + 1] == Image) return true;
        }
        return false;
    }

    /// Starts the installed AppImage once this process has exited and any updater replacing it has finished.
    public static void Relaunch(string[] args)
    {
        if (Image is null) return;
        var deadline = DateTime.UtcNow + UpdaterTimeout;
        while (BeingUpdated() && DateTime.UtcNow < deadline) Thread.Sleep(200);
        const string script = "pid=$1; shift; i=0; while kill -0 \"$pid\" 2>/dev/null && [ $i -lt 600 ]; do i=$((i+1)); sleep 0.1; done; exec \"$@\"";
        Process.Start(new ProcessStartInfo("/bin/sh", ["-c", script, "cohub-relaunch", Environment.ProcessId.ToString(CultureInfo.InvariantCulture), Image, .. args]) { UseShellExecute = false })?.Dispose();
    }

    private static (long, DateTime)? Identity()
    {
        if (Image is null) return null;
        var file = new FileInfo(Image);
        return file.Exists ? (file.Length, file.LastWriteTimeUtc) : null;
    }
}
