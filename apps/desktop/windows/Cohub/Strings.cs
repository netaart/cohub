using System.Globalization;
using System.Resources;
using Cohub.Core;

namespace Cohub;

internal static class Strings
{
    private static readonly ResourceManager Resources = new("Cohub.Strings", typeof(Strings).Assembly);
    private static readonly CultureInfo SystemCulture = CultureInfo.CurrentUICulture;

    public static void Use(string? locale) => CultureInfo.CurrentUICulture = CultureInfo.DefaultThreadCurrentUICulture = ShellState.CultureOf(locale) ?? SystemCulture;

    public static string L(string key) => Resources.GetString(key, CultureInfo.CurrentUICulture) ?? key;

    public static string Format(string key, params object[] values) => string.Format(CultureInfo.CurrentCulture, L(key), values);
}
