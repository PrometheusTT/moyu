# Run from PowerShell on Windows. Re-running after a WSL-required reboot is safe.
param(
    [string]$Distribution = 'Ubuntu',
    [string]$PackageSpec = 'github:PrometheusTT/moyu#feat/live-on-enter'
)

$ErrorActionPreference = 'Stop'
$wezTerm = Get-Command wezterm.exe -ErrorAction SilentlyContinue
if ($null -eq $wezTerm) {
    $locations = @(
        (Join-Path $env:ProgramFiles 'WezTerm\wezterm.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\WezTerm\wezterm.exe')
    )
    foreach ($installed in $locations) {
        if (Test-Path $installed) { $wezTerm = $installed; break }
    }
}
if ($null -eq $wezTerm) {
    if ($null -eq (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'winget is required to install WezTerm. Install App Installer from Microsoft Store, then rerun this script.'
    }
    Write-Host 'Installing WezTerm for full-resolution graphics...'
    & winget.exe install --id wez.wezterm --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw 'WezTerm installation failed.' }
}

if ($null -eq (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is unavailable. Windows 10/11 with WSL support is required.'
}
function Test-WslReady {
    try {
        $result = & wsl.exe -d $Distribution -- sh -lc 'printf MOYU_WSL_READY' 2>$null
        return ($LASTEXITCODE -eq 0 -and $result -eq 'MOYU_WSL_READY')
    } catch {
        return $false
    }
}
if (-not (Test-WslReady)) {
    $distributions = ''
    try {
        $distributions = ((& wsl.exe --list --quiet 2>$null) -join "`n") -replace "`0", ''
    } catch {
        # WSL may be present but not enabled yet; the install command below handles that case.
    }
    $alreadyInstalled = @($distributions -split "`n" | Where-Object { $_.Trim() -eq $Distribution }).Count -gt 0
    if (-not $alreadyInstalled) {
        Write-Host "Installing WSL distribution $Distribution. Windows may request a restart or Linux username setup."
        & wsl.exe --install -d $Distribution
        if ($LASTEXITCODE -ne 0) { throw 'WSL installation failed. Run PowerShell as Administrator and try again.' }
    }
    if (-not (Test-WslReady)) {
        Write-Host "Restart Windows if requested, open $Distribution to finish Linux username setup, then run this same installer again."
        exit 0
    }
}

$bootstrap = Join-Path $env:TEMP 'moyu-wsl-install.sh'
try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/PrometheusTT/moyu/feat/live-on-enter/install/wsl.sh' -OutFile $bootstrap
    $linuxPath = (& wsl.exe -d $Distribution -- wslpath -u $bootstrap).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($linuxPath)) { throw 'Cannot access the installer from WSL.' }
    & wsl.exe -d $Distribution -- bash $linuxPath $PackageSpec
    if ($LASTEXITCODE -ne 0) { throw 'Moyu installation in WSL failed.' }
} finally {
    Remove-Item $bootstrap -ErrorAction SilentlyContinue
}

Write-Host "Open WezTerm, select WSL:$Distribution, then run: moyu play"
Write-Host "For Codex or Claude Code, run: moyu -- codex    or    moyu -- claude"
