#!/usr/bin/env bash
# Usage: apps/desktop/macos/scripts/bundle.sh --arch arm64 --version 1.2.3 [--env dev] [--build 42]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
arch="$(uname -m)" version="0.0.0" build="" env="prod"
while (($#)); do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --build) build="$2"; shift 2 ;;
    --env) env="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$arch" in arm64) node_arch=arm64 ;; x86_64 | x64) arch=x86_64 node_arch=x64 ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac
build="${build:-$(date +%s)}"

if [[ "$env" == dev ]]; then
  name="Cohub Dev" bundle_id="live.cohub.desktop.dev" scheme="cohub-dev" origin="https://dev.cohub.live"
else
  name="Cohub" bundle_id="live.cohub.desktop" scheme="cohub" origin="https://cohub.live"
fi
feed="https://public.cohub.live/desktop/macos/$env/$node_arch/appcast.xml"
dist="$here/dist"
app="$dist/$name.app"
contents="$app/Contents"

echo "==> Building $name $version ($arch)"
swift build --package-path "$here" -c release --arch "$arch" --product Cohub
binaries="$(swift build --package-path "$here" -c release --arch "$arch" --show-bin-path)"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources" "$contents/Frameworks"
cp "$binaries/Cohub" "$contents/MacOS/Cohub"
ditto "$binaries/Sparkle.framework" "$contents/Frameworks/Sparkle.framework"
cp -R "$here/Bundle/Resources/"*.lproj "$contents/Resources/"
sed -e "s|__NAME__|$name|g" -e "s|__BUNDLE_ID__|$bundle_id|g" -e "s|__VERSION__|$version|g" -e "s|__BUILD__|$build|g" \
  -e "s|__URL_SCHEME__|$scheme|g" -e "s|__ENV__|$env|g" -e "s|__WEB_ORIGIN__|$origin|g" -e "s|__FEED_URL__|$feed|g" \
  -e "s|__SPARKLE_PUBLIC_KEY__|${SPARKLE_PUBLIC_KEY:-}|g" "$here/Bundle/Info.plist" > "$contents/Info.plist"
plutil -lint "$contents/Info.plist" >/dev/null

echo "==> Icon"
iconset="$(mktemp -d)/AppIcon.iconset"
node "$repo/apps/desktop/scripts/icons.mjs" --macos "$iconset"
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"

echo "==> Runtime"
node "$repo/apps/desktop/scripts/stage-runtime.mjs" --platform darwin --arch "$node_arch" --out "$contents/Resources/runtime"

echo "==> Signing"
identity="${CODESIGN_IDENTITY:--}"
sign() { codesign --force --timestamp --options runtime --sign "$identity" "$@"; }
[[ "$identity" == "-" ]] && sign() { codesign --force --sign - "$@"; }
find "$contents/Resources/runtime" -type f \( -name "*.node" -o -name "*.dylib" \) -print0 | while IFS= read -r -d '' file; do sign "$file"; done
sign --entitlements "$here/Bundle/Node.entitlements" "$contents/Resources/runtime/node"
# Its own identifier keeps Screen Recording and Accessibility grants across updates.
sign --identifier "$bundle_id.sandboxd" "$contents/Resources/runtime/sandboxd/cohub-sandboxd"
sparkle="$contents/Frameworks/Sparkle.framework/Versions/B"
sign "$sparkle/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$sparkle/XPCServices/Downloader.xpc"
sign "$sparkle/Autoupdate" "$sparkle/Updater.app"
sign "$contents/Frameworks/Sparkle.framework"
sign --entitlements "$here/Bundle/Cohub.entitlements" "$app"
codesign --verify --deep --strict "$app"

echo "==> Packaging"
base="Cohub-$version-$env-$node_arch"
zip="$dist/$base.zip" dmg="$dist/$base.dmg"
rm -f "$zip" "$dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
staging="$(mktemp -d)"
ditto "$app" "$staging/$name.app"
ln -s /Applications "$staging/Applications"
hdiutil create -volname "$name" -srcfolder "$staging" -fs HFS+ -format ULMO -ov "$dmg" >/dev/null
[[ "$identity" != "-" ]] && codesign --force --timestamp --sign "$identity" "$dmg"

if [[ -n "${NOTARY_KEY:-}" ]]; then
  echo "==> Notarizing"
  for file in "$dmg" "$zip"; do
    xcrun notarytool submit "$file" --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait
  done
  xcrun stapler staple "$app"
  xcrun stapler staple "$dmg"
  rm -f "$zip" && ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
fi

(cd "$dist" && shasum -a 256 "$base.dmg" > "$base.dmg.sha256")
echo "==> $dmg"
echo "==> $zip"
