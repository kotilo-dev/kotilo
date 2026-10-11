<#
.SYNOPSIS
  Authenticode-signs files with a certificate from the current user's or machine's store.

.DESCRIPTION
  Optional local signing (M5). Used by scripts/release.ps1 -Sign for the hub sidecar, its native
  DLLs and the hook sidecar before bundling, and as Tauri's bundle.windows.signCommand for the
  app exe, the installer and the uninstaller.

  Environment:
    AGENTHUB_SIGN_THUMBPRINT     SHA-1 thumbprint of the code-signing certificate. Unset: a
                                 warning is printed and nothing is signed (exit code 0), so an
                                 unsigned build still completes.
    AGENTHUB_SIGN_TIMESTAMP_URL  RFC 3161 timestamp server (default http://timestamp.digicert.com).
    AGENTHUB_SIGNTOOL            Full path to signtool.exe (default: PATH, then the newest
                                 Windows 10/11 SDK).

  CI: SignPath (planned, D-047) signs in its own step instead; see .github/workflows/release.yml.

.EXAMPLE
  $env:AGENTHUB_SIGN_THUMBPRINT = "0123..."; ./scripts/sign.ps1 path\to\file.exe other.dll
#>
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]] $Path
)

$ErrorActionPreference = 'Stop'

$thumbprint = $env:AGENTHUB_SIGN_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
    Write-Warning "sign: AGENTHUB_SIGN_THUMBPRINT is not set; leaving unsigned: $($Path -join ', ')"
    exit 0
}

$timestampUrl = if ($env:AGENTHUB_SIGN_TIMESTAMP_URL) { $env:AGENTHUB_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

function Find-SignTool {
    if ($env:AGENTHUB_SIGNTOOL) {
        if (-not (Test-Path $env:AGENTHUB_SIGNTOOL)) { throw "sign: AGENTHUB_SIGNTOOL not found: $env:AGENTHUB_SIGNTOOL" }
        return $env:AGENTHUB_SIGNTOOL
    }
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    $hostArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $found = Get-ChildItem -Path $kits -Directory -Filter '10.*' -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName "$hostArch\signtool.exe" } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1
    if (-not $found) { throw 'sign: signtool.exe not found (install the Windows SDK or set AGENTHUB_SIGNTOOL)' }
    return $found
}

$signtool = Find-SignTool
foreach ($file in $Path) {
    if (-not (Test-Path -LiteralPath $file)) { throw "sign: file not found: $file" }
    & $signtool sign /sha1 $thumbprint /fd SHA256 /tr $timestampUrl /td SHA256 /q $file
    if ($LASTEXITCODE -ne 0) { throw "sign: signtool failed ($LASTEXITCODE) for $file" }
    Write-Host "sign: signed $file"
}
