const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withPredictiveBack(config) {
  return withAndroidManifest(config, (configWithManifest) => {
    const application = configWithManifest.modResults.manifest.application?.[0];
    if (!application) throw new Error("Android application manifest entry is missing.");
    application.$ = application.$ ?? {};
    application.$["android:enableOnBackInvokedCallback"] = "true";
    return configWithManifest;
  });
};
