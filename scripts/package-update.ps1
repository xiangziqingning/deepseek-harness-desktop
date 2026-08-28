# ============================================================
# package-update.ps1  -  Build a self-update release asset for the DSH desktop app.
#   * zip resources\app into  _release\dsh-desktop-<version>.zip
#   * compute sha512 + size
#   * write  _release\latest.json
# Publish these two files as GitHub Release assets (tag v<version>).
# Usage:
#   pwsh -File scripts\package-update.ps1 [-Version 1.0.0]
# ============================================================
param(
  [string]$Version = "",
  [string]$ReleaseNotes = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $root 'dist\DeepSeekHarness-win32-x64\resources\app'
if (-not (Test-Path (Join-Path $appDir 'main.js'))) {
  Write-Output ("ERROR: cannot find " + $appDir + " . Run the electron-packager build first (update dist).")
  exit 1
}
if (-not $Version) {
  $pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  $Version = $pkg.version
}
$Version = ([string]$Version).TrimStart('v')
$fileName = "dsh-desktop-$Version.zip"
$relDir = Join-Path $root '_release'
New-Item -ItemType Directory -Force -Path $relDir | Out-Null
$zip = Join-Path $relDir $fileName
if (Test-Path $zip) { Remove-Item $zip -Force }
# zip the CONTENTS of resources\app so extract -> resources\app directly (bsdtar is much faster)
Push-Location $appDir
try {
  # -a picks zip format by extension
  & tar.exe -a -cf $zip *
  if ($LASTEXITCODE -ne 0) { throw "tar zip failed with code $LASTEXITCODE" }
} finally { Pop-Location }

$sha = (Get-FileHash $zip -Algorithm SHA512).Hash.ToLower()
$size = (Get-Item $zip).Length
$fileObj = @{ name = $fileName; platform = 'win32-x64'; sha512 = $sha; size = $size }
$man = @{ version = $Version; releasedAt = (Get-Date -Format o); notes = $ReleaseNotes; files = @($fileObj) }
[System.IO.File]::WriteAllText((Join-Path $relDir 'latest.json'), ($man | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

Write-Output ("OK: " + (Join-Path $relDir $fileName) + " (" + $size + " bytes)")
Write-Output ("OK: latest.json -> " + (Join-Path $relDir 'latest.json'))
Write-Output ("sha512 = " + $sha)
