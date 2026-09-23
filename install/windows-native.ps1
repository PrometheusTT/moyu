# Native Windows setup: Node.js + WezTerm + Moyu, no WSL required.
param(
    [string]$PackageSpec = 'https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/feat/live-on-enter'
)

$ErrorActionPreference = 'Stop'
function Require-Winget {
    if ($null -eq (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'winget is required to install Node.js or WezTerm. Install Windows App Installer, then rerun this script.'
    }
}

function Get-NodeMajor {
    if ($null -eq (Get-Command node.exe -ErrorAction SilentlyContinue)) { return 0 }
    try { return [int](& node.exe -p 'process.versions.node.split(".")[0]') }
    catch { return 0 }
}

if ((Get-NodeMajor) -lt 20 -or $null -eq (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Require-Winget
    Write-Host 'Installing Node.js LTS for Windows...'
    & winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'Node.js installation failed. Check the winget output above.' }
    $env:Path = "$(Join-Path $env:ProgramFiles 'nodejs');$([Environment]::GetEnvironmentVariable('Path', 'Machine'));$([Environment]::GetEnvironmentVariable('Path', 'User'))"
}
if ((Get-NodeMajor) -lt 20 -or $null -eq (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Node.js 20+ is still unavailable. Open a new PowerShell window and rerun this script.'
}

$wezTerm = Get-Command wezterm.exe -ErrorAction SilentlyContinue
if ($null -eq $wezTerm) {
    foreach ($location in @(
        (Join-Path $env:ProgramFiles 'WezTerm\wezterm.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\WezTerm\wezterm.exe')
    )) {
        if (Test-Path $location) { $wezTerm = $location; break }
    }
}
if ($null -eq $wezTerm) {
    Require-Winget
    Write-Host 'Installing WezTerm for full-resolution graphics...'
    & winget.exe install --id wez.wezterm --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'WezTerm installation failed. Check the winget output above.' }
}

Write-Host 'Installing Moyu natively on Windows...'
& npm.cmd install --global $PackageSpec
if ($LASTEXITCODE -ne 0) { throw 'Moyu installation failed. Check the npm output above.' }
$prefix = (& npm.cmd prefix --global).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($prefix)) { throw 'Cannot locate the npm global command directory.' }
$command = Join-Path $prefix 'moyu.cmd'
if (-not (Test-Path $command)) { throw "npm did not create the Moyu Windows command: $command" }
& $command --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Moyu was installed but did not start.' }

$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (@($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $prefix.TrimEnd('\') }).Count -eq 0) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $prefix).TrimStart(';')), 'User')
}
if (@($env:Path -split ';' | Where-Object { $_.TrimEnd('\') -ieq $prefix.TrimEnd('\') }).Count -eq 0) {
    $env:Path += ";$prefix"
}

Write-Host 'Moyu is ready. Open a new WezTerm PowerShell tab and run: moyu play'
Write-Host 'To wrap an installed CLI, run: moyu -- codex    or    moyu -- claude'
