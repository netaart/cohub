#!/usr/bin/env bash
# Usage: apps/desktop/linux/scripts/pack.sh --version 1.2.3 [--env dev] [--arch x64] [--feed <url>]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
version="" env="prod" arch="x64" feed=""
while (($#)); do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --env) env="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --feed) feed="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ -n "$version" ]] || { echo "Usage: pack.sh --version 1.2.3 [--env dev] [--arch x64] [--feed <url>]" >&2; exit 1; }
case "$env" in prod | dev) ;; *) echo "Unsupported env: $env" >&2; exit 1 ;; esac
case "$arch" in x64 | arm64) ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac

if [[ "$env" == dev ]]; then pack_id="CohubDesktopDev" title="Cohub Dev"; else pack_id="CohubDesktop" title="Cohub"; fi
publish="$here/dist/publish-$env-$arch"
output="$here/dist/$env/$arch"

echo "==> Icon"
node "$repo/apps/desktop/scripts/icons.mjs" --linux "$here/Cohub/Assets/cohub.png"

echo "==> Publishing $title $version ($arch)"
rm -rf "$publish"
dotnet publish "$here/Cohub/Cohub.csproj" -c Release -r "linux-$arch" --self-contained \
  -p:PublishReadyToRun=true -p:Version="$version" -p:CohubEnvironment="$env" -o "$publish"

echo "==> Runtime"
node "$repo/apps/desktop/scripts/stage-runtime.mjs" --platform linux --arch "$arch" --out "$publish/runtime"

echo "==> Packaging"
rm -rf "$output"
if [[ -n "$feed" ]]; then
  # The previous release lets vpk build a delta package; the first release has none.
  vpk download http --url "$feed" --outputDir "$output" || echo "No previous release at $feed; packing without a delta" >&2
fi
vpk pack --packId "$pack_id" --packVersion "$version" --packTitle "$title" --packAuthors "Viscept Limited" \
  --packDir "$publish" --mainExe Cohub --icon "$here/Cohub/Assets/cohub.png" --categories "Network;Office" \
  --runtime "linux-$arch" --outputDir "$output"
image="$output/Cohub-$version-$env-$arch.AppImage"
mv -f "$output/$pack_id.AppImage" "$image"
(cd "$output" && sha256sum "$(basename "$image")" > "$(basename "$image").sha256")
echo "==> $image"
