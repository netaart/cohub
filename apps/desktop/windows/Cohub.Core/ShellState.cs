using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cohub.Core;

public sealed class ShellState
{
    public sealed record Shortcut(string Id, string Label, string Path);

    public sealed record Placement(double Left, double Top, double Width, double Height, bool Maximized);

    public string HostId { get; set; } = Guid.NewGuid().ToString();
    public string? LastPath { get; set; }
    public string? EdgeColor { get; set; }
    public ServiceHello? ServiceHello { get; set; }
    public List<Shortcut> Shortcuts { get; set; } = [];
    public Placement? Window { get; set; }

    private string path = "";

    public static ShellState Load(string directory)
    {
        var path = System.IO.Path.Combine(directory, "shell.json");
        ShellState? state = null;
        try { state = JsonSerializer.Deserialize(File.ReadAllText(path), ShellStateJson.Default.ShellState); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
        state ??= new ShellState();
        state.path = path;
        if (!WebOrigin.IsInAppPath(state.LastPath)) state.LastPath = null;
        return state;
    }

    public void Save()
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, ShellStateJson.Default.ShellState));
        File.Move(temporary, path, overwrite: true);
    }

    public void PushShortcut(Shortcut shortcut)
    {
        Shortcuts = [shortcut, .. Shortcuts.Where(item => item.Id != shortcut.Id).Take(4)];
        Save();
    }

    /// The CLI child sees the user's environment minus Cohub settings, so a terminal's overrides never leak into the app.
    public static Dictionary<string, string> ChildEnvironment(IReadOnlyDictionary<string, string> env, string environment, StringComparer comparer)
    {
        var child = env.Where(entry => !entry.Key.StartsWith("COHUB_", StringComparison.OrdinalIgnoreCase) && !entry.Key.Equals("ENV", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(entry => entry.Key, entry => entry.Value, comparer);
        child["COHUB_CLI_AUTO_UPDATE"] = "0";
        if (environment == "dev") child["ENV"] = "dev";
        return child;
    }
}

[JsonSourceGenerationOptions(WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ShellState))]
internal sealed partial class ShellStateJson : JsonSerializerContext;
