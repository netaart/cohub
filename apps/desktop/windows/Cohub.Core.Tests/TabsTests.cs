using Cohub.Core;
using Xunit;

namespace Cohub.Core.Tests;

public sealed class TabsTests
{
    [Fact]
    public void A_shell_from_before_tabs_reopens_its_last_page()
    {
        var directory = Directory.CreateTempSubdirectory().FullName;
        File.WriteAllText(Path.Combine(directory, "shell.json"), """{ "LastPath": "/spaces/a", "Window": { "Left": 1, "Top": 2, "Width": 800, "Height": 600, "Maximized": true } }""");
        var state = ShellState.Load(directory);
        var window = Assert.Single(state.Session!.Windows);
        Assert.Equal("/spaces/a", Assert.Single(window.Tabs).Path);
        Assert.True(window.Placement!.Maximized);
        state.Save();
        Assert.DoesNotContain("LastPath", File.ReadAllText(Path.Combine(directory, "shell.json")), StringComparison.Ordinal);
    }
}
