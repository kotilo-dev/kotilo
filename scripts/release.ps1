<#
.SYNOPSIS
  Builds a per-user NSIS installer for one Windows architecture.

.DESCRIPTION
  Steps (M5, ARCHITECTURE §9, D-012, D-021, D-044):
    1. Hub: `dotnet publish` self-contained single file for win-x64 / win-arm64. No trimming or
       AOT (Dapper, ClosedXML and Whisper.net use reflection / native loading). Native DLLs stay
       separate files (IncludeNativeLibrariesForSelfExtract=false), never self-extracted to %TEMP%.
       The exe becomes the Tauri sidecar `binaries/<exePrefix>-hub-<triple>.exe` (installed next
       to the app exe, where `hub::locate_hub_exe` looks); every other published file keeps its
       relative path and is installed into the same folder as a bundle resource (Windows resource
       dir = install dir), e.g. `e_sqlite3.dll`, `runtimes/<rid>/...`.
    2. Built-in adapter definitions staged without `fixtures/` (D-021).
    3. Optional (-Sign): the hub exe and its native files are signed before bundling; Tauri's
       signCommand (scripts/sign.ps1) signs the app exe, the sidecars it bundles and the installer.
    4. `tauri build --target <triple> --bundles nsis` with a generated `--config` overlay
       (sidecars, staged resources, updater artifacts, signing). Tauri runs the UI build first
       (`beforeBuildCommand`), and src-tauri/build.rs builds the hook sidecar for the target.
    5. Installer (+ `.sig` updater signature) copied to target/release-artifacts/<arch>/.

  Updater artifacts: produced only when TAURI_SIGNING_PRIVATE_KEY (and, if the key has one,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD) is set; the private key never lives in the repo. The app
  verifies them with plugins.updater.pubkey in tauri.conf.json.

  Prerequisites: .NET 10 SDK, Rust stable with the target (`rustup target add <triple>`; ARM64
  cross-builds need clang for `ring`), Node LTS with `npm --prefix apps/desktop ci` done.

.EXAMPLE
  ./scripts/release.ps1 -Arch x64
  ./scripts/release.ps1 -Arch arm64 -Sign
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('x64', 'arm64')]
    [string] $Arch,
    [switch] $Sign
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriDir = Join-Path $root 'apps\desktop\src-tauri'
$brand = Get-Content (Join-Path $root 'brand.json') -Raw | ConvertFrom-Json
$tauriConf = Get-Content (Join-Path $tauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$prefix = $brand.exePrefix

# Every exe of a release carries the app version (code signing enforces it, D-051); the hook
# reads it from tauri.conf.json, the hub has its own <Version>.
$hubVersion = ([xml](Get-Content (Join-Path $root 'hub\Directory.Build.props') -Raw)).Project.PropertyGroup.Version |
    Where-Object { $_ } | Select-Object -First 1
if ($hubVersion -ne $tauriConf.version) {
    throw "version mismatch: tauri.conf.json $($tauriConf.version), hub/Directory.Build.props $hubVersion"
}

switch ($Arch) {
    'x64' { $triple = 'x86_64-pc-windows-msvc'; $rid = 'win-x64' }
    'arm64' { $triple = 'aarch64-pc-windows-msvc'; $rid = 'win-arm64' }
}

# Fixed location: the generated overlay refers to it relative to src-tauri (Tauri resource keys).
$staging = Join-Path $root 'target\release-staging'
$stagingRel = '../../../target/release-staging'
$cargoTarget = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'target' }
$artifacts = Join-Path $root "target\release-artifacts\$Arch"

function Invoke-Native([string] $Step, [scriptblock] $Command) {
    Write-Host "==> $Step" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit code $LASTEXITCODE)" }
}

function Format-Size([long] $Bytes) { '{0:N1} MB' -f ($Bytes / 1MB) }

# --- 0. Clean staging -------------------------------------------------------------------------
foreach ($dir in @($staging, $artifacts)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Force $dir | Out-Null
}

if (Get-Command rustup -ErrorAction SilentlyContinue) {
    Invoke-Native "rustup target add $triple" { rustup target add $triple }
}

# --- 1. Hub ----------------------------------------------------------------------------------
$hubPublish = Join-Path $staging 'hub-publish'
Invoke-Native "hub: dotnet publish ($rid)" {
    dotnet publish (Join-Path $root 'hub\Hub.Service\Hub.Service.csproj') `
        -c Release -r $rid --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=false `
        -p:PublishTrimmed=false -p:PublishAot=false -p:PublishReadyToRun=false `
        -p:DebugType=none -p:DebugSymbols=false `
        -o $hubPublish
}

$hubExeName = "$prefix-hub.exe"
$hubExe = Join-Path $hubPublish $hubExeName
if (-not (Test-Path $hubExe)) { throw "hub: $hubExeName not found in $hubPublish" }

# Everything except the exe is installed next to it as resources, minus what only IIS hosting
# or static web assets use (the hub is a loopback Kestrel API), the macOS-only Metal shader
# that Whisper.net ships, and stray symbols.
$hubSkip = @('web.config', 'aspnetcorev2_inprocess.dll', "$prefix-hub.staticwebassets.endpoints.json", 'ggml-metal.metal')
$hubFiles = Join-Path $staging 'hub-files'
New-Item -ItemType Directory -Force $hubFiles | Out-Null
Get-ChildItem $hubPublish -Recurse -File |
    Where-Object { $_.FullName -ne $hubExe -and $_.Extension -ne '.pdb' -and $hubSkip -notcontains $_.Name } |
    ForEach-Object {
        $rel = $_.FullName.Substring($hubPublish.Length + 1)
        # Native packages (Whisper.net runtimes) publish every platform under runtimes/<rid>/ or
        # runtimes/<variant>/<rid>/; keep only this one.
        if ($rel -like 'runtimes\*' -and ($rel -split '\\') -notcontains $rid) { return }
        $dest = Join-Path $hubFiles $rel
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        Copy-Item $_.FullName $dest
    }

$sidecarHub = Join-Path $tauriDir "binaries\$prefix-hub-$triple.exe"
New-Item -ItemType Directory -Force (Split-Path $sidecarHub) | Out-Null
Copy-Item $hubExe $sidecarHub -Force

# --- 2. Adapters without fixtures (D-021) -----------------------------------------------------
$adaptersSrc = Join-Path $root 'adapters'
$adaptersDst = Join-Path $staging 'adapters'
Get-ChildItem $adaptersSrc -Recurse -File |
    Where-Object { $_.FullName.Substring($adaptersSrc.Length) -notmatch '(^|\\)fixtures(\\|$)' } |
    ForEach-Object {
        $rel = $_.FullName.Substring($adaptersSrc.Length + 1)
        $dest = Join-Path $adaptersDst $rel
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        Copy-Item $_.FullName $dest
    }

# --- 2b. Microsoft's ConPTY (conpty.dll + OpenConsole.exe, D-055) -----------------------------
# Installed in `conpty\` next to the app exe; Microsoft-signed already, never re-signed by us.
& (Join-Path $root 'scripts\fetch-conpty.ps1') -Arch $Arch -Into (Join-Path $staging 'conpty')

# --- 3. Pre-bundle signing --------------------------------------------------------------------
$signScript = Join-Path $root 'scripts\sign.ps1'
if ($Sign) {
    $toSign = @($sidecarHub) + @(Get-ChildItem $hubFiles -Recurse -File -Include *.dll, *.exe | ForEach-Object FullName)
    Invoke-Native 'sign: hub sidecar + native files' { & $signScript @toSign }
}

# --- 4. Tauri build ---------------------------------------------------------------------------
$bundle = [ordered]@{
    externalBin = @("binaries/$prefix-hook", "binaries/$prefix-hub")
    # JSON merge patch: null drops the dev mapping (adapters incl. fixtures).
    resources   = [ordered]@{
        '../../../adapters/'          = $null
        "$stagingRel/adapters/"       = 'adapters/'
        "$stagingRel/hub-files/"      = './'
        "$stagingRel/conpty/"         = 'conpty/'
    }
}

$hasUpdaterKey = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)
if ($hasUpdaterKey) {
    $bundle.createUpdaterArtifacts = $true
    if ([string]::IsNullOrWhiteSpace($tauriConf.plugins.updater.pubkey)) {
        Write-Warning 'updater: plugins.updater.pubkey in tauri.conf.json is empty; the app will not offer these updates'
    }
} else {
    Write-Warning 'updater: TAURI_SIGNING_PRIVATE_KEY is not set; building without updater artifacts (.sig)'
}

if ($Sign) {
    $bundle.windows = [ordered]@{
        signCommand = [ordered]@{
            cmd  = 'powershell'
            args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $signScript, '%1')
        }
    }
}

$overlay = Join-Path $staging 'tauri.release.conf.json'
# UTF-8 without BOM (Windows PowerShell's -Encoding utf8 writes one, which JSON parsers reject).
[IO.File]::WriteAllText($overlay, (@{ bundle = $bundle } | ConvertTo-Json -Depth 10))

Invoke-Native "tauri build ($triple)" {
    npm --prefix (Join-Path $root 'apps\desktop') run tauri -- build --target $triple --bundles nsis --config $overlay
}

# --- 5. Collect -------------------------------------------------------------------------------
$nsisDir = Join-Path $cargoTarget "$triple\release\bundle\nsis"
$installers = @(Get-ChildItem $nsisDir -File -Filter '*-setup.exe*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*_$($tauriConf.version)_*" })
if ($installers.Count -eq 0) { throw "no installer found in $nsisDir" }
$installers | ForEach-Object { Copy-Item $_.FullName $artifacts -Force }

Write-Host "==> artifacts ($Arch)" -ForegroundColor Green
Get-ChildItem $artifacts -File | ForEach-Object { Write-Host ("  {0}  {1}" -f $_.FullName, (Format-Size $_.Length)) }
Write-Host ("  hub sidecar {0}, hub resources {1} in {2} files" -f `
    (Format-Size (Get-Item $sidecarHub).Length),
    (Format-Size ((Get-ChildItem $hubFiles -Recurse -File | Measure-Object Length -Sum).Sum)),
    (Get-ChildItem $hubFiles -Recurse -File).Count)
