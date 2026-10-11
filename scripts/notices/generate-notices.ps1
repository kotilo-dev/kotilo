<#
.SYNOPSIS
  Regenerates THIRD_PARTY_NOTICES (plain text, full license texts) for what the product ships.

.DESCRIPTION
  Ecosystems:
    - Rust:  cargo-about over the workspace (apps/desktop/src-tauri + crates/hook + crates/proto),
             release targets x86_64/aarch64-pc-windows-msvc, no dev-dependencies (about.toml).
    - npm:   runtime `dependencies` tree of apps/desktop (npm-notices.mjs), read from node_modules.
    - NuGet: hub/Hub.Service incl. transitive packages (dotnet list package), license data from the
             .nuspec files and license files in the NuGet global packages folder, plus the .NET and
             ASP.NET Core runtime packs (the hub is published self-contained).
    - Assets: notes for fonts and runtime downloads.
  Works offline once cargo-about is installed, node_modules exist and the hub has been restored.

  Requirements: cargo-about (`cargo install cargo-about --locked --features cli`), node, dotnet.

.PARAMETER Output
  Output file. Defaults to THIRD_PARTY_NOTICES at the repository root.
#>
[CmdletBinding()]
param(
    [string]$Output
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
if (-not $Output) { $Output = Join-Path $repo 'THIRD_PARTY_NOTICES' }
$licensesDir = Join-Path $here 'licenses'
$work = Join-Path $repo 'target\notices'
New-Item -ItemType Directory -Force $work | Out-Null

foreach ($p in @("$env:USERPROFILE\.cargo\bin", 'C:\Program Files\nodejs', 'C:\Program Files\dotnet')) {
    if ((Test-Path $p) -and -not (($env:Path -split ';') -contains $p)) { $env:Path = "$p;$env:Path" }
}
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $repo 'target\check-notices' }

# Preference order when a package offers a choice (OR expression). Copyleft options come last
# so that a permissive alternative is always elected.
$preference = @('MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'Zlib', '0BSD', 'MIT-0',
    'CC0-1.0', 'Unlicense', 'BSL-1.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'OFL-1.1', 'MPL-2.0')

function Select-License([string]$expr) {
    # Elects one license from a simple SPDX expression; AND expressions are kept as they are.
    $e = $expr.Trim()
    if ($e -match '\bAND\b' -or $e -notmatch '\bOR\b') { return $e.Trim('(', ')', ' ') }
    $options = ($e -replace '[()]', '') -split '\s+OR\s+' | ForEach-Object { $_.Trim() }
    foreach ($p in $preference) { if ($options -contains $p) { return $p } }
    return $options[0]
}

function Test-Copyleft([string]$id) { return $id -match '(^|[^A-Z])(A|L)?GPL' }

$sb = [System.Text.StringBuilder]::new()
function Add([string]$s = '') { [void]$sb.Append($s).Append("`n") }
function Add-Rule([string]$title) { Add; Add ('=' * 100); Add $title; Add ('=' * 100); Add }
function Normalize([string]$t) { return ($t -replace "`r`n", "`n" -replace "`r", "`n").Trim() }

$flags = [System.Collections.Generic.List[string]]::new()   # copyleft
$mpl = [System.Collections.Generic.List[string]]::new()     # MPL-2.0 with source location
$unknown = [System.Collections.Generic.List[string]]::new()

# ---------------------------------------------------------------- Rust
Write-Host 'Rust: cargo about ...'
$cargoJson = Join-Path $work 'cargo.json'
& cargo about generate --format json --workspace --frozen -c (Join-Path $here 'about.toml') `
    -m (Join-Path $repo 'Cargo.toml') -o $cargoJson 2>&1 |
    Where-Object { "$_" -notmatch "agenthub(-hook|-proto)? 0\.|\[WARN\].*agenthub" } | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { throw 'cargo about failed (install: cargo install cargo-about --locked --features cli)' }
$cargo = Get-Content $cargoJson -Raw | ConvertFrom-Json
$ownCrates = @('agenthub', 'agenthub-hook', 'agenthub-proto')
$crates = @($cargo.crates | Where-Object { $ownCrates -notcontains $_.package.name } |
        Sort-Object { $_.package.name }, { $_.package.version })
# The license(s) cargo-about elected per crate = the license entries whose text it attached to it.
$elected = @{}
foreach ($l in $cargo.licenses) {
    foreach ($u in $l.used_by) {
        $k = "$($u.crate.name) $($u.crate.version)"
        if (-not $elected.ContainsKey($k)) { $elected[$k] = [System.Collections.Generic.List[string]]::new() }
        if (-not $elected[$k].Contains($l.id)) { $elected[$k].Add($l.id) }
    }
}
foreach ($c in $crates) {
    $k = "$($c.package.name) $($c.package.version)"
    $chosen = if ($elected.ContainsKey($k)) { ($elected[$k] | Sort-Object) -join ' AND ' } else { '' }
    $c | Add-Member -NotePropertyName chosen -NotePropertyValue $chosen
    if (-not $chosen -or $chosen -eq 'NOASSERTION') { $unknown.Add("Rust $($c.package.name) $($c.package.version)") }
    if (Test-Copyleft $chosen) { $flags.Add("Rust $($c.package.name) $($c.package.version): $chosen") }
    if ($chosen -match 'MPL-2\.0') {
        $src = if ($c.package.repository) { $c.package.repository } else { "https://crates.io/crates/$($c.package.name)" }
        $mpl.Add("Rust $($c.package.name) $($c.package.version) – source available at $src")
    }
}

# ---------------------------------------------------------------- npm
Write-Host 'npm: walking production dependencies ...'
$appDir = Join-Path $repo 'apps\desktop'
if (-not (Test-Path (Join-Path $appDir 'node_modules'))) { throw 'apps/desktop/node_modules missing – run npm ci first' }
$npmJson = & node (Join-Path $here 'npm-notices.mjs') $appDir $licensesDir
if ($LASTEXITCODE -ne 0) { throw 'npm-notices.mjs failed' }
$npm = @($npmJson | ConvertFrom-Json)
foreach ($n in $npm) {
    $chosen = Select-License $n.license
    $n | Add-Member -NotePropertyName chosen -NotePropertyValue $chosen
    if ($n.license -eq 'UNKNOWN' -or ($n.texts.Count -eq 0 -and -not $n.fallback)) { $unknown.Add("npm $($n.name) $($n.version) ($($n.license))") }
    if (Test-Copyleft $chosen) { $flags.Add("npm $($n.name) $($n.version): $chosen") }
    if ($chosen -match 'MPL-2\.0') { $mpl.Add("npm $($n.name) $($n.version) – source available at $($n.repository)") }
}

# ---------------------------------------------------------------- NuGet
Write-Host 'NuGet: dotnet list package ...'
$proj = Join-Path $repo 'hub\Hub.Service\Hub.Service.csproj'
$listJson = & dotnet list $proj package --include-transitive --format json
if ($LASTEXITCODE -ne 0) { throw "dotnet list failed – restore the hub first (dotnet restore $proj)" }
$list = ($listJson -join "`n") | ConvertFrom-Json
$nugetRoot = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $env:USERPROFILE '.nuget\packages' }
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-NupkgLicenseTexts([string]$dir, [string]$licenseFile) {
    # Prefer extracted files; fall back to reading the .nupkg (zip) without extracting it.
    $pattern = '^(licen[sc]e|copying|third-party-notices|thirdpartynotices)(\.(txt|md))?$'
    $texts = @()
    $files = @(Get-ChildItem $dir -File | Where-Object { ($licenseFile -and $_.Name -ieq $licenseFile) -or $_.Name -match $pattern })
    foreach ($f in $files) { $texts += [pscustomobject]@{ file = $f.Name; text = Normalize (Get-Content $f.FullName -Raw) } }
    if ($texts.Count -gt 0) { return , $texts }
    $nupkg = Get-ChildItem $dir -Filter '*.nupkg' | Select-Object -First 1
    if (-not $nupkg) { return , $texts }
    $zip = [System.IO.Compression.ZipFile]::OpenRead($nupkg.FullName)
    try {
        foreach ($e in $zip.Entries) {
            $leaf = Split-Path $e.FullName -Leaf
            if (($licenseFile -and $e.FullName -ieq $licenseFile) -or ($e.FullName -notmatch '/' -and $leaf -match $pattern)) {
                $r = [System.IO.StreamReader]::new($e.Open())
                try { $texts += [pscustomobject]@{ file = $e.FullName; text = Normalize $r.ReadToEnd() } } finally { $r.Dispose() }
            }
        }
    } finally { $zip.Dispose() }
    return , $texts
}

function Read-NugetPackage([string]$id, [string]$version) {
    $dir = Join-Path $nugetRoot "$($id.ToLowerInvariant())\$($version.ToLowerInvariant())"
    $o = [ordered]@{ id = $id; version = $version; license = 'UNKNOWN'; chosen = 'UNKNOWN'; copyright = ''; project = ''; texts = @(); fallback = $null }
    if (-not (Test-Path $dir)) { return [pscustomobject]$o }
    $nuspecFile = Get-ChildItem $dir -Filter '*.nuspec' | Select-Object -First 1
    [xml]$nuspec = Get-Content $nuspecFile.FullName -Raw
    $meta = $nuspec.package.metadata
    $licenseFile = $null
    $licNode = $meta.SelectSingleNode("*[local-name()='license']")
    if ($licNode) {
        if ($licNode.GetAttribute('type') -eq 'file') { $licenseFile = $licNode.InnerText; $o.license = "file:$licenseFile" }
        else { $o.license = $licNode.InnerText }
    } else {
        $url = $meta.SelectSingleNode("*[local-name()='licenseUrl']")
        if ($url) { $o.license = "url:$($url.InnerText)" }
    }
    $cp = $meta.SelectSingleNode("*[local-name()='copyright']"); if ($cp) { $o.copyright = $cp.InnerText }
    $pu = $meta.SelectSingleNode("*[local-name()='projectUrl']"); if ($pu) { $o.project = $pu.InnerText }
    $repoNode = $meta.SelectSingleNode("*[local-name()='repository']")
    if (-not $o.project -and $repoNode) { $o.project = $repoNode.GetAttribute('url') }
    $o.texts = Get-NupkgLicenseTexts $dir $licenseFile
    if ($o.license -like 'file:*') {
        # Identify the license in the file for the summary (Whisper.net ships its MIT LICENSE as a file).
        $t = ($o.texts | Select-Object -First 1).text
        $o.chosen = if ($t -match 'Permission is hereby granted, free of charge') { 'MIT' }
        elseif ($t -match 'Apache License') { 'Apache-2.0' } else { $o.license }
    } elseif ($o.license -like 'url:*') {
        $o.chosen = $o.license
    } else {
        $o.chosen = Select-License $o.license
    }
    if ($o.texts.Count -eq 0) {
        $f = Join-Path $licensesDir "$($o.chosen).txt"
        if (Test-Path $f) { $o.fallback = $o.chosen }
    }
    return [pscustomobject]$o
}

$nuget = @()
foreach ($fw in $list.projects[0].frameworks) {
    foreach ($p in @($fw.topLevelPackages) + @($fw.transitivePackages)) {
        if ($p -and -not ($nuget | Where-Object { $_.id -eq $p.id })) { $nuget += Read-NugetPackage $p.id $p.resolvedVersion }
    }
}
$nuget = @($nuget | Sort-Object id)
foreach ($n in $nuget) {
    if ($n.chosen -eq 'UNKNOWN' -or $n.chosen -like 'url:*' -or ($n.texts.Count -eq 0 -and -not $n.fallback)) { $unknown.Add("NuGet $($n.id) $($n.version) ($($n.license))") }
    if (Test-Copyleft $n.chosen) { $flags.Add("NuGet $($n.id) $($n.version): $($n.chosen)") }
    if ($n.chosen -match 'MPL-2\.0') { $mpl.Add("NuGet $($n.id) $($n.version) – source available at $($n.project)") }
}

# .NET + ASP.NET Core runtime packs (self-contained publish). Pick the newest pack of the TFM major.
$tfmMajor = '10'
$runtimePacks = @()
foreach ($rp in 'microsoft.netcore.app.runtime.win-x64', 'microsoft.aspnetcore.app.runtime.win-x64') {
    $base = Join-Path $nugetRoot $rp
    $ver = if (Test-Path $base) {
        Get-ChildItem $base -Directory | Where-Object { $_.Name -like "$tfmMajor.*" } |
            Sort-Object { [version]($_.Name -replace '-.*$', '') } | Select-Object -Last 1
    }
    if ($ver) { $runtimePacks += [pscustomobject]@{ id = $rp; version = $ver.Name; texts = Get-NupkgLicenseTexts $ver.FullName $null } }
    else { $unknown.Add("runtime pack $rp $tfmMajor.x not in the NuGet cache (run a self-contained publish once)") }
}

# ---------------------------------------------------------------- render
$rustLicenses = @($cargo.licenses | ForEach-Object {
        $users = @($_.used_by | Where-Object { $ownCrates -notcontains $_.crate.name })
        if ($users.Count) { [pscustomobject]@{ id = $_.id; name = $_.name; text = $_.text; users = $users } }
    })

Add 'THIRD-PARTY SOFTWARE NOTICES AND INFORMATION'
Add
Add 'This product includes third-party software. The components, their licenses and the full'
Add 'license texts are listed below, grouped by ecosystem. Where a component is offered under a'
Add 'choice of licenses, the license we elect is shown first and the offered choice follows in'
Add 'parentheses; the license text printed for it is the elected one.'
Add
Add 'Generated by scripts/notices/generate-notices.ps1 – do not edit by hand.'
Add
Add 'SUMMARY'
Add "  Rust crates (desktop app + hook):         $($crates.Count)"
Add "  npm packages (desktop UI bundle):         $($npm.Count)"
Add "  NuGet packages (hub service):             $($nuget.Count) + .NET runtime packs: $($runtimePacks.Count)"
Add
Add '  Copyleft (GPL/LGPL/AGPL) components:'
if ($flags.Count) { $flags | ForEach-Object { Add "    $_" } } else { Add '    none' }
Add
Add '  MPL-2.0 components (file-level copyleft; unmodified, source available as noted):'
if ($mpl.Count) { $mpl | ForEach-Object { Add "    $_" } } else { Add '    none' }
Add
if ($unknown.Count) {
    Add '  Components whose license could not be determined automatically:'
    $unknown | ForEach-Object { Add "    $_" }
    Add
}

# Rust
Add-Rule "RUST CRATES ($($crates.Count))"
foreach ($c in $crates) {
    $offered = if ("$($c.license)" -and "$($c.license)" -ne $c.chosen) { " (offered: $($c.license))" } else { '' }
    Add ('  {0,-40} {1,-14} {2}{3}' -f $c.package.name, $c.package.version, $c.chosen, $offered)
}
foreach ($l in ($rustLicenses | Sort-Object id)) {
    Add
    Add ('-' * 100)
    Add "$($l.name) ($($l.id))"
    Add ('Used by: ' + (($l.users | ForEach-Object { "$($_.crate.name) $($_.crate.version)" } | Sort-Object -Unique) -join ', '))
    Add ('-' * 100)
    Add
    Add (Normalize $l.text)
}

# npm – identical license texts are printed once for all packages that share them.
Add-Rule "NPM PACKAGES ($($npm.Count))"
Add '  Runtime dependency tree of apps/desktop (package.json "dependencies"). Not included: build and'
Add '  test tools (devDependencies); "next" and "sharp", peer dependencies of "geist" that are not part'
Add '  of the bundle (only the Geist font files are used); optional native Node add-ons.'
Add
foreach ($n in $npm) {
    $elected = if ($n.chosen -ne $n.license) { " (offered: $($n.license))" } else { '' }
    Add ('  {0,-40} {1,-14} {2}{3}' -f $n.name, $n.version, $n.chosen, $elected)
}
$groups = [ordered]@{}
foreach ($n in $npm) {
    $body = if ($n.texts.Count) { ($n.texts | ForEach-Object { $_.text }) -join "`n`n" }
    elseif ($n.fallback) { "Declared license: $($n.fallback) (the package ships no license file; standard text follows)`n`n" + (Normalize (Get-Content (Join-Path $licensesDir "$($n.fallback).txt") -Raw)) }
    else { "Declared license: $($n.license) (no license text found)" }
    if (-not $groups.Contains($body)) { $groups[$body] = [System.Collections.Generic.List[string]]::new() }
    $groups[$body].Add("$($n.name) $($n.version)")
}
foreach ($k in $groups.Keys) {
    Add
    Add ('-' * 100)
    Add ('Used by: ' + ($groups[$k] -join ', '))
    Add ('-' * 100)
    Add
    Add $k
}

# NuGet
Add-Rule "NUGET PACKAGES ($($nuget.Count)) AND .NET RUNTIME"
Add '  hub/Hub.Service incl. transitive packages (test projects are not shipped).'
Add
foreach ($n in $nuget) {
    $offered = if ($n.license -like 'file:*') { ' (license file in the package)' } elseif ($n.license -ne $n.chosen) { " (offered: $($n.license))" } else { '' }
    Add ('  {0,-40} {1,-14} {2}{3}' -f $n.id, $n.version, $n.chosen, $offered)
}
foreach ($r in $runtimePacks) { Add ('  {0,-40} {1,-14} {2}' -f $r.id, $r.version, 'MIT (+ third-party notices)') }
$groups = [ordered]@{}
foreach ($n in $nuget) {
    $body = if ($n.texts.Count) { ($n.texts | ForEach-Object { $_.text }) -join "`n`n" }
    elseif ($n.fallback) { Normalize (Get-Content (Join-Path $licensesDir "$($n.fallback).txt") -Raw) }
    else { "Declared license: $($n.license) (no license text found)" }
    $key = if ($n.texts.Count) { $body } else { "$($n.chosen)`n$body" }
    if (-not $groups.Contains($key)) { $groups[$key] = [pscustomobject]@{ body = $body; users = [System.Collections.Generic.List[string]]::new(); copyrights = [System.Collections.Generic.List[string]]::new(); fromFile = [bool]$n.texts.Count } }
    $groups[$key].users.Add("$($n.id) $($n.version)")
    if ($n.copyright) { $groups[$key].copyrights.Add("$($n.id): $($n.copyright)") }
}
foreach ($g in $groups.Values) {
    Add
    Add ('-' * 100)
    Add ('Used by: ' + ($g.users -join ', '))
    if (-not $g.fromFile) { $g.copyrights | ForEach-Object { Add "  $_" } }
    Add ('-' * 100)
    Add
    Add $g.body
}
foreach ($r in $runtimePacks) {
    Add
    Add ('-' * 100)
    Add "$($r.id) $($r.version) (self-contained .NET runtime shipped with the hub)"
    Add ('-' * 100)
    foreach ($t in $r.texts) { Add; Add "[$($t.file)]"; Add; Add $t.text }
}

# Assets
Add-Rule 'ASSETS AND RUNTIME DOWNLOADS'
Add '  Geist and Geist Mono fonts (woff2, bundled): SIL Open Font License 1.1,'
Add '    Copyright (c) 2023 Vercel, in collaboration with basement.studio. Shipped via the npm package'
Add '    "geist"; its license text is included in the npm section above.'
Add '  xterm.js and Monaco Editor: shipped via npm (@xterm/*, monaco-editor); see the npm section.'
Add '  SQLite (native e_sqlite3 library via SQLitePCLRaw.lib.e_sqlite3): public domain'
Add '    (https://sqlite.org/copyright.html).'
Add '  Whisper speech models (ggml format): NOT bundled. Downloaded at runtime, on the user''s request,'
Add '    from https://huggingface.co/ggerganov/whisper.cpp (MIT License, Copyright (c) 2023-2024'
Add '    The ggml authors; model weights by OpenAI, MIT License).'

# ConPTY (D-055): binaries from the NuGet package Microsoft.Windows.Console.ConPTY, fetched at
# release time by scripts/fetch-conpty.ps1 (not a hub dependency, so listed here by hand).
$conptyVersion = ((Get-Content (Join-Path $repo 'scripts\fetch-conpty.ps1') -Raw) -replace "(?s)^.*?\`$Version = '([^']+)'.*$", '$1')
Add '  ConPTY (conpty.dll, OpenConsole.exe; bundled, Microsoft-signed, unmodified): NuGet package'
Add "    Microsoft.Windows.Console.ConPTY $conptyVersion from https://github.com/microsoft/terminal, MIT License:"
Add
Add ((Normalize (Get-Content (Join-Path $licensesDir 'MIT.txt') -Raw)) -replace "Copyright \(c\) the package authors \(see the package's copyright notice\)", 'Copyright (c) Microsoft Corporation. All rights reserved.')


# Colour themes (D-057): colour values copied into apps/desktop/src/app/theme/catalogue.ts (listed by hand).
Add-Rule 'COLOUR THEMES (D-057)'
Add 'Colour values (no code) of these themes are copied into apps/desktop/src/app/theme/catalogue.ts.'
Add 'MIT License and Apache License 2.0 texts: see above (the copyright lines below apply).'
Add
Add '  Catppuccin (Mocha, Macchiato, Frappé, Latte) – https://github.com/catppuccin/palette,'
Add '    https://github.com/catppuccin/windows-terminal – MIT License, Copyright (c) 2021 Catppuccin'
Add '  Tokyo Night (Night, Storm, Moon, Day) – https://github.com/folke/tokyonight.nvim (extras/windows_terminal)'
Add '    – Apache License 2.0, Copyright (c) Folke Lemaitre'
Add '  Rosé Pine (Main, Moon, Dawn) – https://github.com/rose-pine/palette, https://github.com/rose-pine/windows-terminal'
Add '    – MIT License, Copyright (c) mvllow; Copyright (c) Rosé Pine'
Add '  Dracula – https://github.com/dracula/windows-terminal – MIT License, Copyright (c) 2019 thismat'
Add '  Nord – https://github.com/nordtheme/nord, https://github.com/nordtheme/xfce-terminal – MIT License,'
Add '    Copyright (c) 2016-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)'
Add '  One Dark – https://github.com/joshdick/onedark.vim (term/) – MIT License, Copyright (c) 2015 Joshua Dick'
Add '  One Light – https://github.com/atom/atom (packages/one-light-syntax) – MIT License, Copyright (c) 2011-2022 GitHub Inc.;'
Add '    terminal colours: One Half Light, https://github.com/sonph/onehalf – MIT License, Copyright (c) 2019 Son A. Pham <sp@sonpham.me>'
Add '  Gruvbox (Dark, Light) – https://github.com/morhetz/gruvbox, https://github.com/morhetz/gruvbox-contrib'
Add '    (xfce4-terminal) – MIT/X11 License, Copyright (c) Pavel Pertsev (morhetz)'
Add '  Solarized (Dark, Light) – https://github.com/altercation/solarized – MIT License, Copyright (c) 2011 Ethan Schoonover;'
Add '    terminal mapping as in Windows Terminal''s built-in schemes (below)'
Add '  GitHub (Dark, Light) – https://github.com/primer/github-vscode-theme – MIT License, Copyright (c) 2020 Primer;'
Add '    https://github.com/primer/primitives 7.10.0 – MIT License, Copyright (c) 2018 GitHub Inc.'
Add '  Kanagawa (Wave, Dragon, Lotus) – https://github.com/rebelot/kanagawa.nvim – MIT License, Copyright (c) 2021 Tommaso Laurenzi'
Add '  Everforest (Dark, Light; medium) – https://github.com/sainnhe/everforest – MIT License, Copyright (c) 2019 sainnhe'
Add '  Campbell, Solarized and One Half terminal schemes – https://github.com/microsoft/terminal'
Add '    (src/cascadia/TerminalSettingsModel/defaults.json) – MIT License, Copyright (c) Microsoft Corporation. All rights reserved.'

$text = $sb.ToString() -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($Output, $text, [System.Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host "Wrote $Output"
Write-Host "  Rust crates: $($crates.Count)   npm packages: $($npm.Count)   NuGet packages: $($nuget.Count) (+ $($runtimePacks.Count) runtime packs)"
Write-Host "  Copyleft: $($flags.Count)   MPL-2.0: $($mpl.Count)   Undetermined: $($unknown.Count)"
$unknown | ForEach-Object { Write-Warning "license undetermined: $_" }
