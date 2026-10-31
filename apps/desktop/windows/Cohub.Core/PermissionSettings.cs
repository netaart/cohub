namespace Cohub.Core;

public static class PermissionSettings
{
    public static string? UriFor(string kind) => kind switch
    {
        "microphone" => "ms-settings:privacy-microphone",
        "camera" => "ms-settings:privacy-webcam",
        "notifications" => "ms-settings:notifications",
        _ => null,
    };
}
