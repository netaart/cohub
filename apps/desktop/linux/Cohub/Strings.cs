using System.Globalization;
using System.Resources;
using Cohub.Core;

namespace Cohub;

internal static class Strings
{
    private static readonly ResourceManager Resources = new("Cohub.Strings", typeof(Strings).Assembly);
    private static readonly CultureInfo SystemCulture = CultureInfo.CurrentUICulture;

    public static readonly CultureInfo English = CultureInfo.InvariantCulture;
    public static readonly CultureInfo Chinese = CultureInfo.GetCultureInfo("zh-Hans");

    public static void Use(string? locale) => CultureInfo.CurrentUICulture = CultureInfo.DefaultThreadCurrentUICulture = ShellState.CultureOf(locale) ?? SystemCulture;

    public static string L(string key, CultureInfo? culture = null) => Resources.GetString(key, culture ?? CultureInfo.CurrentUICulture) ?? key;

    public static string Format(string key, params object[] values) => string.Format(CultureInfo.CurrentCulture, L(key), values);
}
