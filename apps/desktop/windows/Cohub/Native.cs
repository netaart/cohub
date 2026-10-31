using System.Runtime.InteropServices;
using System.Windows.Media;
using Microsoft.Win32;
using Windows.ApplicationModel.DataTransfer;
using WinRT;

namespace Cohub;

internal static partial class Native
{
    private const int DwmUseImmersiveDarkMode = 20;
    private const int DwmCaptionColor = 35;
    private const int DwmTextColor = 36;

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [LibraryImport("user32.dll", EntryPoint = "SendMessageTimeoutW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool DestroyIcon(IntPtr handle);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool UnregisterHotKey(IntPtr hwnd, int id);

    public static void TintTitleBar(IntPtr hwnd, Color color)
    {
        var dark = 0.2126 * color.R + 0.7152 * color.G + 0.0722 * color.B < 128 ? 1 : 0;
        var caption = color.R | color.G << 8 | color.B << 16;
        var text = dark == 1 ? 0xFFFFFF : 0x000000;
        DwmSetWindowAttribute(hwnd, DwmUseImmersiveDarkMode, ref dark, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmCaptionColor, ref caption, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmTextColor, ref text, sizeof(int));
    }

    public static void BroadcastEnvironmentChange() =>
        SendMessageTimeout(0xFFFF, 0x001A, UIntPtr.Zero, "Environment", 0x0002, 5_000, out _);

    public static void Share(IntPtr hwnd, string text, string? title)
    {
        var interop = DataTransferManager.As<IDataTransferManagerInterop>();
        var iid = new Guid("a5caee9b-8708-49d1-8d36-67d25a8da00c");
        var manager = MarshalInterface<DataTransferManager>.FromAbi(interop.GetForWindow(hwnd, ref iid));
        void Provide(DataTransferManager sender, DataRequestedEventArgs args)
        {
            sender.DataRequested -= Provide;
            args.Request.Data.Properties.Title = string.IsNullOrWhiteSpace(title) ? "Cohub" : title;
            args.Request.Data.SetText(text);
        }
        manager.DataRequested += Provide;
        interop.ShowShareUIForWindow(hwnd);
    }

    [ComImport]
    [Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
        void ShowShareUIForWindow(IntPtr appWindow);
    }
}

internal static class Registration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private static string Executable => Environment.ProcessPath ?? throw new InvalidOperationException("No process path");

    public static void Register(ShellConfig config)
    {
        using var scheme = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{config.UrlScheme}");
        scheme.SetValue("", "URL:Cohub");
        scheme.SetValue("URL Protocol", "");
        using (var icon = scheme.CreateSubKey("DefaultIcon")) icon.SetValue("", $"\"{Executable}\",0");
        using var command = scheme.CreateSubKey(@"shell\open\command");
        command.SetValue("", $"\"{Executable}\" \"%1\"");
        RegisterFolderCommand(config, @"Directory\shell", "%1");
        RegisterFolderCommand(config, @"Directory\Background\shell", "%V");
    }

    private static string FolderCommandKey(ShellConfig config, string parent) => $@"Software\Classes\{parent}\{(config.Environment == "dev" ? "CohubDev" : "Cohub")}";

    private static void RegisterFolderCommand(ShellConfig config, string parent, string argument)
    {
        using var verb = Registry.CurrentUser.CreateSubKey(FolderCommandKey(config, parent));
        verb.SetValue("", Strings.L("Open in Cohub"));
        verb.SetValue("Icon", $"\"{Executable}\",0");
        using var command = verb.CreateSubKey("command");
        command.SetValue("", $"\"{Executable}\" --folder \"{argument}\"");
    }

    public static bool LaunchesAtLogin(ShellConfig config)
    {
        using var run = Registry.CurrentUser.OpenSubKey(RunKey);
        return run?.GetValue(config.InstanceName) is string;
    }

    public static void SetLaunchAtLogin(ShellConfig config, bool enabled)
    {
        using var run = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) run.SetValue(config.InstanceName, $"\"{Executable}\"");
        else run.DeleteValue(config.InstanceName, throwOnMissingValue: false);
    }

    public static void Unregister(ShellConfig config)
    {
        Registry.CurrentUser.DeleteSubKeyTree($@"Software\Classes\{config.UrlScheme}", throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(FolderCommandKey(config, @"Directory\shell"), throwOnMissingSubKey: false);
        Registry.CurrentUser.DeleteSubKeyTree(FolderCommandKey(config, @"Directory\Background\shell"), throwOnMissingSubKey: false);
        SetLaunchAtLogin(config, false);
        if (IsOnPath(config.CommandLineTool)) SetOnPath(config.CommandLineTool, false);
    }

    public static bool IsOnPath(string directory) => PathEntries().Contains(directory, StringComparer.OrdinalIgnoreCase);

    public static void SetOnPath(string directory, bool present)
    {
        using var environment = Registry.CurrentUser.CreateSubKey("Environment");
        var entries = PathEntries(environment).Where(entry => !entry.Equals(directory, StringComparison.OrdinalIgnoreCase)).ToList();
        if (present) entries.Add(directory);
        environment.SetValue("Path", string.Join(';', entries), RegistryValueKind.ExpandString);
        Native.BroadcastEnvironmentChange();
    }

    private static List<string> PathEntries(RegistryKey? environment = null)
    {
        using var opened = environment is null ? Registry.CurrentUser.OpenSubKey("Environment") : null;
        var raw = (environment ?? opened)?.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
        return [.. raw.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)];
    }
}
