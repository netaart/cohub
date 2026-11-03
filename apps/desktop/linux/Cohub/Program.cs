using System.Diagnostics;
using System.Runtime.Versioning;
using Velopack;

[assembly: SupportedOSPlatform("linux")]

namespace Cohub;

internal static class Program
{
    private static int Main(string[] args)
    {
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
        return new ShellApp(ShellConfig.Load()).Run(args);
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
