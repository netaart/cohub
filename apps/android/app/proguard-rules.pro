# Keep the bridge entry points reachable: the WebView resolves them by name
# through reflection-free platform APIs.
-keep class live.cohub.android.host.** { *; }
-keep class live.cohub.android.auth.** { *; }

# kotlinx.serialization generates serializers; keep them for the JSON bridge.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
