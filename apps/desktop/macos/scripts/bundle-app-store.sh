#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
version="${1:?Usage: bundle-app-store.sh VERSION BUILD}"
build="${2:?Build number is required}"
export COHUB_DISTRIBUTION=app-store
dist="$here/dist/app-store"
app="$dist/Cohub.app"
contents="$app/Contents"
scratch="$here/.build/app-store"
args=(--package-path "$here" --scratch-path "$scratch" -c release --arch arm64 --arch x86_64)
swift build "${args[@]}" --product Cohub
binaries="$(swift build "${args[@]}" --show-bin-path)"
mkdir -p "$contents/MacOS" "$contents/Resources"
cp "$binaries/Cohub" "$contents/MacOS/Cohub"
cp -R "$here/Bundle/Resources/"*.lproj "$contents/Resources/"
python3 - "$here/Bundle/Info.plist" "$contents/Info.plist" "$version" "$build" "$(git -C "$repo" rev-parse --short=7 HEAD)" <<'PY'
import plistlib, sys
source, target, version, build, commit = sys.argv[1:]
with open(source, 'rb') as f:
    info = plistlib.load(f)
for key in list(info):
    if key.startswith('SU') or key in ['CFBundleDocumentTypes', 'NSDocumentsFolderUsageDescription', 'NSDesktopFolderUsageDescription', 'NSDownloadsFolderUsageDescription', 'NSRemovableVolumesUsageDescription', 'NSNetworkVolumesUsageDescription']:
        del info[key]
info.update(CFBundleDisplayName='Cohub', CFBundleName='Cohub', CFBundleIdentifier='live.cohub.desktop',
    CFBundleShortVersionString=version, CFBundleVersion=build, LSMinimumSystemVersion='14.4',
    CFBundleInfoDictionaryVersion='6.0', ITSAppUsesNonExemptEncryption=False,
    CohubCommit=commit, CohubEnvironment='prod', CohubWebOrigin='https://cohub.live', CohubURLScheme='cohub')
info['CFBundleURLTypes'] = [{'CFBundleURLName': 'live.cohub.desktop', 'CFBundleURLSchemes': ['cohub']}]
with open(target, 'wb') as f:
    plistlib.dump(info, f)
PY
iconset="$scratch/AppIcon.iconset"
mkdir -p "$iconset"
node "$repo/apps/desktop/scripts/icons.mjs" --macos "$iconset"
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"
plutil -lint "$contents/Info.plist"

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --sign - --entitlements "$here/Bundle/AppStore.entitlements" "$app"
  echo "Built unsigned Mac App Store app: $app"
  exit 0
fi
test -n "${INSTALLER_IDENTITY:-}" && test -f "${APP_PROFILE_PATH:-}"
cp "$APP_PROFILE_PATH" "$contents/embedded.provisionprofile"
entitlements="$scratch/AppStore.entitlements"
python3 - "$here/Bundle/AppStore.entitlements" "$entitlements" "${APPLE_TEAM_ID:?}" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    data = plistlib.load(f)
data['com.apple.application-identifier'] = sys.argv[3] + '.live.cohub.desktop'
data['com.apple.developer.team-identifier'] = sys.argv[3]
with open(sys.argv[2], 'wb') as f:
    plistlib.dump(data, f)
PY
codesign --force --timestamp --sign "$CODESIGN_IDENTITY" --entitlements "$entitlements" "$app"
codesign --verify --deep --strict "$app"
productbuild --component "$app" /Applications --sign "$INSTALLER_IDENTITY" "$dist/Cohub-$version.pkg"
pkgutil --check-signature "$dist/Cohub-$version.pkg"
