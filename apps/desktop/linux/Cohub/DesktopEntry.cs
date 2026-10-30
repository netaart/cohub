using System.Diagnostics;
using System.Text;
using Cohub.Core;

namespace Cohub;

/// The freedesktop launcher entry: name and icon in the app grid, the URL scheme, and recent Spaces as launcher actions.
internal static class DesktopEntry
{
    private static string DataHome => System.Environment.GetEnvironmentVariable("XDG_DATA_HOME") is { Length: > 0 } value && Path.IsPathRooted(value)
        ? value
        : Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile), ".local", "share");

    public static void Write(ShellConfig config, IReadOnlyList<ShellState.Shortcut> shortcuts)
    {
        var applications = Path.Combine(DataHome, "applications");
        var file = Path.Combine(applications, $"{config.AppId}.desktop");
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "cohub.png");
        if (File.Exists(icon))
        {
            var themed = Path.Combine(DataHome, "icons", "hicolor", "512x512", "apps", $"{config.AppId}.png");
            Directory.CreateDirectory(Path.GetDirectoryName(themed)!);
            File.Copy(icon, themed, overwrite: true);
        }

        var exec = Quote(ShellConfig.Executable);
        var actions = shortcuts.Select((shortcut, index) => (Id: $"recent{index}", shortcut.Label, Argument: $"{config.UrlScheme}://open{shortcut.Path}")).ToList();
        List<string> lines =
        [
            "[Desktop Entry]",
            "Type=Application",
            $"Name={config.Title}",
            $"Exec={exec} %u",
            $"Icon={config.AppId}",
            "Terminal=false",
            "Categories=Network;Office;",
            $"MimeType=x-scheme-handler/{config.UrlScheme};",
            $"StartupWMClass={config.AppId}",
            $"Actions={string.Concat(actions.Select(action => action.Id + ";"))}new-window;",
        ];
        foreach (var action in actions)
        {
            lines.AddRange(["", $"[Desktop Action {action.Id}]", $"Name={Escape(action.Label)}", $"Exec={exec} {Quote(action.Argument)}"]);
        }
        lines.AddRange([
            "",
            "[Desktop Action new-window]",
            $"Name={Strings.L("New Window", Strings.English)}",
            $"Name[zh_CN]={Strings.L("New Window", Strings.Chinese)}",
            $"Exec={exec} {Quote($"{config.UrlScheme}://new-window")}",
        ]);

        var content = string.Join('\n', lines) + "\n";
        if (File.Exists(file) && File.ReadAllText(file) == content) return;
        Directory.CreateDirectory(applications);
        var temporary = $"{file}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, content);
        File.Move(temporary, file, overwrite: true);
        Run("update-desktop-database", applications);
        Run("xdg-mime", "default", $"{config.AppId}.desktop", $"x-scheme-handler/{config.UrlScheme}");
    }

    /// Links `~/.local/bin/cohub` to the shim; most distributions put that directory on PATH.
    public static async Task<string?> InstallCommandLineToolAsync(string shim, Func<string, Task<bool>> replace)
    {
        var link = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile), ".local", "bin", "cohub");
        var existing = new FileInfo(link);
        if (existing.LinkTarget == shim) return link;
        if ((existing.Exists || existing.LinkTarget is not null) && !await replace(link)) return null;
        Directory.CreateDirectory(Path.GetDirectoryName(link)!);
        var temporary = Path.Combine(Path.GetDirectoryName(link)!, $".cohub.{Guid.NewGuid():N}");
        File.CreateSymbolicLink(temporary, shim);
        File.Move(temporary, link, overwrite: true);
        return link;
    }

    // Desktop entry Exec quoting: https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
    private static string Quote(string argument)
    {
        var escaped = new StringBuilder("\"");
        foreach (var character in argument)
        {
            if (character is '"' or '`' or '$' or '\\') escaped.Append('\\');
            if (character == '%') escaped.Append('%');
            escaped.Append(character);
        }
        return Escape(escaped.Append('"').ToString());
    }

    private static string Escape(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\n", " ", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal);

    private static void Run(string command, params string[] arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(command, arguments) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true });
            process?.WaitForExit(5_000);
        }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
