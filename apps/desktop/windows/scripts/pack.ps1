# Usage: apps/desktop/windows/scripts/pack.ps1 -Version 1.2.3 [-Environment dev] [-Arch x64] [-Feed <url>]
param(
  [Parameter(Mandatory)] [string] $Version,
  [ValidateSet('prod', 'dev')] [string] $Environment = 'prod',
  [ValidateSet('x64', 'arm64')] [string] $Arch = 'x64',
  [string] $Feed
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot
$repo = Resolve-Path "$here/../../.."
$publish = "$here/dist/publish-$Environment-$Arch"
$output = "$here/dist/$Environment/$Arch"
$packId = if ($Environment -eq 'dev') { 'CohubDesktopDev' } else { 'CohubDesktop' }
$title = if ($Environment -eq 'dev') { 'Cohub Dev' } else { 'Cohub' }

Write-Host "==> Icon"
node "$repo/apps/desktop/scripts/icons.mjs" --windows "$here/Cohub/Assets/Cohub.ico"

Write-Host "==> Publishing $title $Version ($Arch)"
Remove-Item -Recurse -Force $publish -ErrorAction SilentlyContinue
dotnet publish "$here/Cohub/Cohub.csproj" -c Release -r "win-$Arch" --self-contained `
  -p:PublishReadyToRun=true -p:Version=$Version -p:CohubEnvironment=$Environment -o $publish
if ($LASTEXITCODE) { throw "dotnet publish failed" }

Write-Host "==> Runtime"
node "$repo/scripts/stage-runtime.mjs" --platform win32 --arch $Arch --out "$publish/runtime"
if ($LASTEXITCODE) { throw "Staging the runtime failed" }

Write-Host "==> Packaging"
Remove-Item -Recurse -Force $output -ErrorAction SilentlyContinue
if ($Feed) {
  # The previous release lets vpk build a delta package; the first release has none.
  vpk download http --url $Feed --outputDir $output
  if ($LASTEXITCODE) { Write-Warning "No previous release at $Feed; packing without a delta" }
}
$sign = @()
if ($env:AZURE_TRUSTED_SIGNING_METADATA) { $sign = @('--azureTrustedSignFile', $env:AZURE_TRUSTED_SIGNING_METADATA) }
vpk pack --packId $packId --packVersion $Version --packTitle $title --packAuthors 'Viscept Limited' `
  --packDir $publish --mainExe Cohub.exe --icon "$here/Cohub/Assets/Cohub.ico" --outputDir $output @sign
if ($LASTEXITCODE) { throw "vpk pack failed" }
$setup = "$output/Cohub-$Version-$Environment-$Arch-Setup.exe"
Move-Item -Force "$output/$packId-win-Setup.exe" $setup
$hash = (Get-FileHash -Algorithm SHA256 $setup).Hash.ToLowerInvariant()
"$hash  $(Split-Path -Leaf $setup)" | Set-Content -NoNewline -Encoding ascii "$setup.sha256"
Write-Host "==> $setup"
