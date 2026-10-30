using System.Globalization;
using System.Resources;

namespace Cohub;

internal static class Strings
{
    private static readonly ResourceManager Resources = new("Cohub.Strings", typeof(Strings).Assembly);

    public static readonly CultureInfo English = CultureInfo.InvariantCulture;
    public static readonly CultureInfo Chinese = CultureInfo.GetCultureInfo("zh-Hans");

    public static string L(string key, CultureInfo? culture = null) => Resources.GetString(key, culture ?? CultureInfo.CurrentUICulture) ?? key;

    public static string Format(string key, params object[] values) => string.Format(CultureInfo.CurrentCulture, L(key), values);
}
