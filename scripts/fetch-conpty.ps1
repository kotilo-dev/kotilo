<#
.SYNOPSIS
  Downloads Microsoft's ConPTY package (conpty.dll + OpenConsole.exe) for the terminals.

.DESCRIPTION
  The ConPTY built into Windows drops sixel image sequences; the one Microsoft ships for
  Windows Terminal (NuGet Microsoft.Windows.Console.ConPTY, MIT) passes them through
  (D-055). Kotilo installs it in a `conpty\` folder next to the app exe and loads it from
  there when "Use the bundled console host" is on.

  The package version and its SHA-256 are pinned; the files must carry a valid Microsoft
  Authenticode signature. Downloads are cached in target\conpty\<version>\.

.PARAMETER Arch
  x64 or arm64.

.PARAMETER Into
  Folder to copy conpty.dll and OpenConsole.exe into (created if missing). For a dev build:
  `./scripts/fetch-conpty.ps1 -Arch x64 -Into target/debug/conpty`.

.EXAMPLE
  ./scripts/fetch-conpty.ps1 -Arch x64 -Into target/debug/conpty
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('x64', 'arm64')]
    [string] $Arch,
    [Parameter(Mandatory = $true)]
    [string] $Into
)

$ErrorActionPreference = 'Stop'

$Version = '1.25.260930003'
$Sha256 = '02B07B349AF66D801159BDF9E440D4A1CE78BB951F37FC8609731665AFDAE7EE'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cache = Join-Path $root "target\conpty\$Version"
$package = Join-Path $cache 'conpty.nupkg'
$extracted = Join-Path $cache 'pkg'

if (-not (Test-Path $extracted)) {
    New-Item -ItemType Directory -Force $cache | Out-Null
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$Version/microsoft.windows.console.conpty.$Version.nupkg"
    Write-Host "==> conpty: downloading $Version" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $package -UseBasicParsing
    $hash = (Get-FileHash $package -Algorithm SHA256).Hash
    if ($hash -ne $Sha256) {
        Remove-Item $package -Force
        throw "conpty: SHA-256 mismatch ($hash), expected $Sha256"
    }
    Expand-Archive -Path $package -DestinationPath $extracted -Force
}

$files = @(
    (Join-Path $extracted "runtimes\win-$Arch\native\conpty.dll"),
    (Join-Path $extracted "build\native\runtimes\$Arch\OpenConsole.exe")
)
New-Item -ItemType Directory -Force $Into | Out-Null
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "conpty: $file is not signed by Microsoft ($($signature.Status))"
    }
    Copy-Item $file $Into -Force
}
Write-Host "==> conpty: $Version ($Arch) -> $Into" -ForegroundColor Cyan
