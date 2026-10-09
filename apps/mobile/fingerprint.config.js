/**
 * OTA runtimes must survive release version bumps. `version` and the derived
 * `android.versionCode` / `ios.buildNumber` are not native changes, so keeping
 * them in the fingerprint would strand every installed binary on the next
 * release. Keep the default package.json script skip so prebuild does not
 * change the fingerprint either.
 */
module.exports = {
  sourceSkips: ["ExpoConfigVersions", "PackageJsonAndroidAndIosScriptsIfNotContainRun"],
};
