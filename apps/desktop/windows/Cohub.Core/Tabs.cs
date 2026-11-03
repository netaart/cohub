namespace Cohub.Core;

public sealed record SessionTab(string Path, string? Title = null, string? Edge = null);

public sealed record SessionWindow(IReadOnlyList<SessionTab> Tabs, int Selected = 0, ShellState.Placement? Placement = null);

public sealed record TabSession(IReadOnlyList<SessionWindow> Windows)
{
    public const int MaxWindows = 16;
    public const int MaxTabs = 64;

    private static readonly string[] ProductSuffixes = [" — Cohub", " - Cohub", " · Cohub", " | Cohub"];

    public static TabSession Of(string path, ShellState.Placement? placement = null) => new([new SessionWindow([new SessionTab(path)], 0, placement)]);

    public TabSession Sanitized() => new([.. Windows.TakeLast(MaxWindows).Select(window =>
    {
        var kept = window.Tabs.Select((tab, index) => (tab, index)).Where(item => WebOrigin.IsInAppPath(item.tab.Path)).TakeLast(MaxTabs).ToList();
        if (kept.Count == 0) return null;
        var selected = kept.FindLastIndex(item => item.index <= window.Selected);
        return new SessionWindow([.. kept.Select(item => item.tab)], Math.Max(selected, 0), window.Placement);
    }).OfType<SessionWindow>()]);

    public static string? Title(string? documentTitle)
    {
        var title = documentTitle?.Trim() ?? "";
        foreach (var suffix in ProductSuffixes)
        {
            if (title.EndsWith(suffix, StringComparison.Ordinal)) title = title[..^suffix.Length].TrimEnd();
        }
        return title.Length == 0 || title == "Cohub" ? null : title;
    }

    public static bool SamePage(string a, string b) => Page(a).SequenceEqual(Page(b));

    private static ReadOnlySpan<char> Page(string path)
    {
        var end = path.AsSpan().IndexOfAny('?', '#');
        return end < 0 ? path : path.AsSpan(0, end);
    }
}

public enum TabMove { Next, Previous }

public static class TabOrder
{
    public static int? Target(TabMove move, int selected, int count) => count == 0 ? null : move switch
    {
        TabMove.Next => (selected + 1) % count,
        _ => (selected - 1 + count) % count,
    };

    public static int? Numbered(int number, int count) => number switch
    {
        9 when count > 0 => count - 1,
        >= 1 and <= 8 when number <= count => number - 1,
        _ => null,
    };

    public static int Insertion<T>(T opener, IReadOnlyList<(T Id, T? Opener)> tabs) where T : class
    {
        var index = IndexOf(opener, tabs);
        if (index < 0) return tabs.Count;
        index++;
        while (index < tabs.Count && ReferenceEquals(tabs[index].Opener, opener)) index++;
        return index;
    }

    public static T? Successor<T>(T closing, T? selected, IReadOnlyList<(T Id, T? Opener)> tabs) where T : class
    {
        var index = IndexOf(closing, tabs);
        if (!ReferenceEquals(closing, selected) || index < 0) return null;
        if (tabs[index].Opener is { } opener && IndexOf(opener, tabs) >= 0) return opener;
        if (index + 1 < tabs.Count) return tabs[index + 1].Id;
        return index > 0 ? tabs[index - 1].Id : null;
    }

    private static int IndexOf<T>(T id, IReadOnlyList<(T Id, T? Opener)> tabs) where T : class
    {
        for (var index = 0; index < tabs.Count; index++)
        {
            if (ReferenceEquals(tabs[index].Id, id)) return index;
        }
        return -1;
    }
}

public sealed class ClosedTabs
{
    public const int Limit = 25;

    private readonly List<(SessionTab Tab, int Index)> entries = [];

    public bool IsEmpty => entries.Count == 0;

    public void Push(SessionTab tab, int index)
    {
        if (!WebOrigin.IsInAppPath(tab.Path)) return;
        entries.Add((tab, index));
        if (entries.Count > Limit) entries.RemoveRange(0, entries.Count - Limit);
    }

    public (SessionTab Tab, int Index)? Pop()
    {
        if (entries.Count == 0) return null;
        var last = entries[^1];
        entries.RemoveAt(entries.Count - 1);
        return last;
    }

    public void Clear() => entries.Clear();
}

public sealed class RepeatFilter(TimeSpan window)
{
    private readonly Dictionary<string, DateTimeOffset> seen = [];

    public RepeatFilter() : this(TimeSpan.FromSeconds(30)) { }

    public bool Admits(string key, DateTimeOffset now)
    {
        foreach (var (entry, at) in seen.ToList())
        {
            if (now - at >= window) seen.Remove(entry);
        }
        return seen.TryAdd(key, now);
    }
}

public enum TabCommand { NewTab, NewWindow, CloseTab, CloseWindow, ReopenClosedTab, NextTab, PreviousTab, SelectTab }

public readonly record struct ShellShortcut(TabCommand Command, string Key, bool Shift = false, int Tab = 0);

public static class ShellShortcuts
{
    public static readonly IReadOnlyList<ShellShortcut> All =
    [
        new(TabCommand.NewTab, "T"),
        new(TabCommand.NewWindow, "N"),
        new(TabCommand.CloseTab, "W"),
        new(TabCommand.CloseTab, "F4"),
        new(TabCommand.CloseWindow, "W", Shift: true),
        new(TabCommand.ReopenClosedTab, "T", Shift: true),
        new(TabCommand.NextTab, "Tab"),
        new(TabCommand.PreviousTab, "Tab", Shift: true),
        new(TabCommand.NextTab, "PageDown"),
        new(TabCommand.PreviousTab, "PageUp"),
        .. Enumerable.Range(1, 9).Select(number => new ShellShortcut(TabCommand.SelectTab, $"{number}", Tab: number)),
    ];

    public static ShellShortcut? Find(string key, bool shift) =>
        All.FirstOrDefault(shortcut => shortcut.Key == key && shortcut.Shift == shift) is { Key: not null } found ? found : null;

    public static bool Repeats(TabCommand command) => command is TabCommand.NextTab or TabCommand.PreviousTab;
}
