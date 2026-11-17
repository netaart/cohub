#!/usr/bin/env bash
set -euo pipefail
version="${1:?Usage: archive.sh VERSION BUILD}"
build="${2:?Build number is required}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export_dir="$RUNNER_TEMP/cohub-ios-export"
export APPLE_TEAM_ID COHUB_APP_PROFILE COHUB_SHARE_PROFILE
python3 - "$root/ExportOptions.plist" "$RUNNER_TEMP/ExportOptions.plist" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], 'rb') as f:
    data = plistlib.load(f)
data.update(teamID=os.environ['APPLE_TEAM_ID'], signingCertificate='Apple Distribution', provisioningProfiles={
    'live.cohub.ios': os.environ['COHUB_APP_PROFILE'],
    'live.cohub.ios.share': os.environ['COHUB_SHARE_PROFILE'],
})
with open(sys.argv[2], 'wb') as f:
    plistlib.dump(data, f)
PY
xcodebuild -project "$root/Cohub.xcodeproj" -scheme Cohub -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$RUNNER_TEMP/Cohub.xcarchive" -quiet archive \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY='Apple Distribution' DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  COHUB_APP_PROFILE="$COHUB_APP_PROFILE" COHUB_SHARE_PROFILE="$COHUB_SHARE_PROFILE" \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build" COHUB_COMMIT="$(git rev-parse --short=7 HEAD)"
xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/Cohub.xcarchive" \
  -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" -exportPath "$export_dir"
