<#
.SYNOPSIS
    Builds the Pocherk ("Почерк") Chromium extension package: dist\pocherk-<version>.zip

.DESCRIPTION
    - reads version from manifest.json;
    - verifies every file referenced by manifest.json really exists;
    - copies runtime files into a clean staging folder (no tools, no sources, no dist);
    - creates a zip that can be uploaded to Chrome Web Store / Edge Add-ons
      or unpacked locally with "Load unpacked".

.PARAMETER OutputDirectory
    Target folder for the zip. Default: <extension>\dist

.PARAMETER IncludeReadme
    Also put README.md into the archive.

.EXAMPLE
    pwsh -File package.ps1
    pwsh -File package.ps1 -OutputDirectory C:\build

.NOTES
    Requires PowerShell 5.1+ and .NET (Compress-Archive). No npm/node needed.
#>

[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$IncludeReadme
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $root 'dist'
}
$manifestPath = Join-Path $root 'manifest.json'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found in $root"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest.json: "version" is empty or missing'
}

Write-Host ("Pocherk extension v{0}" -f $version) -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1. Files referenced by the manifest must exist.
# ---------------------------------------------------------------------------
$referenced = New-Object System.Collections.Generic.List[string]
$referenced.Add([string]$manifest.background.service_worker)
$referenced.Add([string]$manifest.side_panel.default_path)
$referenced.Add([string]$manifest.options_page)

if ($manifest.icons) {
    foreach ($prop in $manifest.icons.PSObject.Properties) { $referenced.Add([string]$prop.Value) }
}
if ($manifest.action -and $manifest.action.default_icon) {
    foreach ($prop in $manifest.action.default_icon.PSObject.Properties) { $referenced.Add([string]$prop.Value) }
}
if ($manifest.content_scripts) {
    foreach ($script in $manifest.content_scripts) {
        foreach ($js in $script.js) { $referenced.Add([string]$js) }
        foreach ($css in $script.css) { $referenced.Add([string]$css) }
    }
}
if ($manifest.web_accessible_resources) {
    foreach ($entry in $manifest.web_accessible_resources) {
        foreach ($resource in $entry.resources) { $referenced.Add([string]$resource) }
    }
}

$missing = New-Object System.Collections.Generic.List[string]
foreach ($relative in $referenced | Select-Object -Unique) {
    if ([string]::IsNullOrWhiteSpace($relative)) { continue }
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative))) {
        $missing.Add($relative)
    }
}
if ($missing.Count -gt 0) {
    throw ("manifest.json references missing files: {0}" -f ($missing -join ', '))
}
Write-Host ("Manifest references OK ({0} files)" -f ($referenced | Select-Object -Unique).Count) -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1b. Local src/href references in HTML must exist (options.js was once missed).
# ---------------------------------------------------------------------------
$htmlMissing = New-Object System.Collections.Generic.List[string]
foreach ($html in Get-ChildItem -LiteralPath $root -Filter '*.html' -File) {
    $text = Get-Content -LiteralPath $html.FullName -Raw -Encoding UTF8
    foreach ($match in [regex]::Matches($text, '(?:src|href)="([^"#]+)"')) {
        $ref = $match.Groups[1].Value.Trim()
        if ([string]::IsNullOrWhiteSpace($ref)) { continue }
        if ($ref -match '^(?:https?:|data:|mailto:|#)') { continue }
        $refPath = $ref.Split('?')[0]
        if ([string]::IsNullOrWhiteSpace($refPath)) { continue }
        if (-not (Test-Path -LiteralPath (Join-Path $root $refPath))) {
            $htmlMissing.Add(("{0} -> {1}" -f $html.Name, $refPath))
        }
    }
}
if ($htmlMissing.Count -gt 0) {
    throw ("HTML references missing files: {0}" -f ($htmlMissing -join ', '))
}
Write-Host ("HTML local references OK ({0} HTML files)" -f (Get-ChildItem -LiteralPath $root -Filter '*.html' -File).Count) -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 2. Runtime payload (exact list: what actually ships).
# ---------------------------------------------------------------------------
$payload = @(
    'manifest.json',
    'background.js',
    'content.js',
    'sidepanel.html',
    'sidepanel.css',
    'sidepanel.js',
    'options.html',
    'options.css',
    'options.js',
    'lib',
    'styles',
    'icons'
)
if ($IncludeReadme) { $payload += 'README.md' }

$staging = Join-Path $env:TEMP ("pocherk-build-{0}" -f [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

function New-ExtensionZip {
    <#
        Creates a zip with forward-slash entry names (ZIP spec, store upload friendly).
        Compress-Archive on Windows writes backslashes, which some unzip tools reject.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$SourceDirectory,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )
    Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

    # Resolve to a full path: $env:TEMP may be an 8.3 short path, while FileInfo.FullName is long.
    $baseFull = (Get-Item -LiteralPath $SourceDirectory).FullName.TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File | Sort-Object FullName
    $stream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
        $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($file in $files) {
                $relative = $file.FullName.Substring($baseFull.Length + 1).Replace('\', '/')
                $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $file.LastWriteTime
                $entryStream = $entry.Open()
                try {
                    $fileStream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read)
                    try { $fileStream.CopyTo($entryStream) }
                    finally { $fileStream.Dispose() }
                }
                finally { $entryStream.Dispose() }
            }
        }
        finally { $archive.Dispose() }
    }
    finally { $stream.Dispose() }
}

try {
    foreach ($item in $payload) {
        $source = Join-Path $root $item
        if (-not (Test-Path -LiteralPath $source)) {
            if ($item -eq 'README.md') { continue }
            throw "Missing payload item: $item"
        }
        $info = Get-Item -LiteralPath $source
        if ($info.PSIsContainer) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $staging $item) -Recurse -Force
        }
        else {
            Copy-Item -LiteralPath $source -Destination (Join-Path $staging $item) -Force
        }
    }

    # Remove accidental build artifacts from copied folders.
    $junk = Get-ChildItem -LiteralPath $staging -Recurse -File |
        Where-Object { $_.Extension -in @('.map', '.log', '.py', '.pyc', '.ps1', '.pem', '.crx', '.zip') -or $_.Name -in @('.DS_Store', 'Thumbs.db') }
    foreach ($file in $junk) { Remove-Item -LiteralPath $file.FullName -Force }

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $zipPath = Join-Path $OutputDirectory ("pocherk-{0}.zip" -f $version)
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

    try {
        New-ExtensionZip -SourceDirectory $staging -DestinationPath $zipPath
    }
    catch {
        Write-Warning ("Custom zip writer failed, falling back to Compress-Archive: {0}" -f $_.Exception.Message)
        Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal
    }

    # -----------------------------------------------------------------------
    # 3. Report.
    # -----------------------------------------------------------------------
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $entries = @()
    try {
        $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try { $entries = @($archive.Entries | ForEach-Object { $_.FullName }) }
        finally { $archive.Dispose() }
    }
    catch {
        Write-Warning ("Could not enumerate zip entries: {0}" -f $_.Exception.Message)
    }

    $zipInfo = Get-Item -LiteralPath $zipPath
    Write-Host ''
    Write-Host ("Built: {0}" -f $zipPath) -ForegroundColor Green
    Write-Host ("Size:  {0:N1} KB" -f ($zipInfo.Length / 1KB)) -ForegroundColor DarkGray
    if ($entries.Count -gt 0) {
        $badSeparators = @($entries | Where-Object { $_.Contains('\') })
        if ($badSeparators.Count -gt 0) {
            throw ("Zip entry names contain backslashes: {0}" -f ($badSeparators -join ', '))
        }
        Write-Host ("Entries: {0}" -f $entries.Count) -ForegroundColor DarkGray
        $entries | Sort-Object | ForEach-Object { Write-Host ("  " + $_) }
        if ($entries -notcontains 'manifest.json') {
            throw 'Built archive has no manifest.json at its root'
        }
    }

    Write-Host ''
    Write-Host 'Next steps:' -ForegroundColor Cyan
    Write-Host '  Chrome: chrome://extensions -> Developer mode -> Load unpacked -> select the extension folder'
    Write-Host '  Edge:   edge://extensions  -> Developer mode -> Load unpacked -> select the extension folder'
    Write-Host '  Stores: upload the zip to Chrome Web Store / Microsoft Edge Add-ons'
}
finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
}
