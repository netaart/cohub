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
            var message = Strings.L("Cohub needs GTK 4.10 and WebKitGTK 6.0.");
            var hint = Strings.L("Install libwebkitgtk-6.0-4 (Debian, Ubuntu), webkitgtk6.0 (Fedora) or webkitgtk-6.0 (Arch), then open Cohub again.");
            Console.Error.WriteLine($"{message} {hint} ({problem})");
            try { Process.Start(new ProcessStartInfo("notify-send", ["--app-name=Cohub", message, hint]) { UseShellExecute = false })?.Dispose(); }
            catch (System.ComponentModel.Win32Exception) { }
            return 1;
        }
        return new ShellApp(ShellConfig.Load()).Run(args);
    }

    // GTK and WebKitGTK come from the system; GTK 4.10 brings the file and alert dialogs the shell uses.
    private static bool HasToolkit(out string problem)
    {
        try
        {
            WebKit.Module.Initialize();
            var gtk = new Version((int)Gtk.Functions.GetMajorVersion(), (int)Gtk.Functions.GetMinorVersion());
            problem = $"GTK {gtk}, WebKitGTK {WebKit.Functions.GetMajorVersion()}.{WebKit.Functions.GetMinorVersion()}";
            return gtk >= new Version(4, 10);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or TypeInitializationException)
        {
            problem = error.Message;
            return false;
        }
    }
}
