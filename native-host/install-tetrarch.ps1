<#
    Enable four-player chess (Tetrarch) in Mephisto on Windows.

    Chrome finds native-messaging hosts through the REGISTRY on Windows, not through a directory of
    manifests the way macOS and Linux do -- which is the whole reason this exists alongside the shell
    installer rather than being a flag on it.

        powershell -ExecutionPolicy Bypass -File install-tetrarch.ps1 -ExtId <EXTENSION_ID> [-Tetrarch C:\path\to\Tetrarch]

    -ExtId    : your Mephisto extension id from chrome://extensions (Developer mode on). It is derived
                from the extension FOLDER PATH, so reloading does not change it (measured: the same
                folder loaded into two fresh profiles gets the same id). Re-run this only if you move
                or re-extract the extension somewhere else.
    -Tetrarch : the Tetrarch checkout. Looked for beside the Mephisto folder (in the same parent
                folder) if omitted.

    Build the engine core first (MSYS2 / mingw-w64):  cd Tetrarch; ./setup.sh
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ExtId,
    [string]$Tetrarch = ''
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- locate the engine ---------------------------------------------------------------------------
if (-not $Tetrarch) { $Tetrarch = Join-Path (Split-Path -Parent (Split-Path -Parent $src)) 'Tetrarch' }
$Tetrarch = [System.IO.Path]::GetFullPath($Tetrarch)

if (-not (Test-Path (Join-Path $Tetrarch 'uci.py'))) {
    Write-Error "No uci.py in $Tetrarch -- pass -Tetrarch C:\path\to\Tetrarch"
}
# The DLL is the part people miss: without it core.py raises on import and the panel just says the
# engine is unavailable, with nothing to indicate the build step was skipped.
$dll = Join-Path $Tetrarch 'build\tetrarch.dll'
if (-not (Test-Path $dll)) {
    Write-Error @"
No build\tetrarch.dll in $Tetrarch.

The C core has to be built for Windows before any of this works. Under MSYS2 (mingw-w64 shell):
    cd '$Tetrarch'
    ./setup.sh
"@
}

# --- a python that can run the host --------------------------------------------------------------
# (audit 3.1.331 INSTALLPS1-2) RUN, not just looked up, and picked the way tetrarch-host.bat picks it:
# `py -3` whenever py exists, `python` only when it does not. Get-Command alone passed the Microsoft
# Store's python.exe alias, on PATH by default with no Python behind it, and a Python without numpy,
# which the engine needs and which Tetrarch's setup.sh installs into MSYS2's python3, not this one.
# Neither run redirects stderr: Windows PowerShell 5.1 under Stop makes redirected stderr terminating.
$py = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) { $py = 'py'; $pyArgs = @('-3') }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = 'python' }
if ($py) {
    $null = & $py @pyArgs -c 'import sys'
    if ($LASTEXITCODE -ne 0) { $py = $null }
}
if (-not $py) {
    Write-Error 'No working Python 3 found -- install Python 3 from python.org (tick "Add to PATH"). The "python" that opens the Microsoft Store is only an alias.'
}
$pyCmd = (@($py) + $pyArgs) -join ' '
$null = & $py @pyArgs -c 'import sys; sys.stderr = sys.stdout; import numpy'
if ($LASTEXITCODE -ne 0) {
    Write-Error "numpy is missing from the Python the host runs ($pyCmd). Install it with:  $pyCmd -m pip install numpy"
}

# --- the DLL has to LOAD, not just exist ---------------------------------------------------------
# (audit 3.1.331 INSTALLPS1-1) A mingw-w64 build without -static imports libwinpthread-1.dll, which
# lives only in MSYS2's mingw64\bin. Python 3.8+ resolves a ctypes DLL's imports from the DLL's own
# folder and System32, never from PATH, so core.load() failed under the host's interpreter while the
# existence check above passed and this printed Done. stderr is folded into stdout INSIDE Python:
# Windows PowerShell 5.1 under ErrorActionPreference Stop turns redirected native stderr into a
# terminating error.
$load = & $py @pyArgs -c 'import sys; sys.stderr = sys.stdout; import ctypes; ctypes.CDLL(sys.argv[1])' $dll
if ($LASTEXITCODE -ne 0) {
    $why = $load | Select-Object -Last 1
    Write-Error @"
build\tetrarch.dll is there but Python cannot load it:
    $why

Usually a DLL it imports is missing. A mingw-w64 build imports libwinpthread-1.dll, which lives only in
MSYS2's mingw64\bin, and Python looks for a DLL's imports beside the DLL, not on PATH. Copy it there:
    copy C:\msys64\mingw64\bin\libwinpthread-1.dll '$Tetrarch\build\'
A 32-bit Python cannot load the 64-bit DLL either: install the 64-bit Python 3 from python.org.
"@
}

# --- deploy --------------------------------------------------------------------------------------
# Out of the repo and into the user profile, for the same reason as the Unix installer: a
# browser-spawned host should not depend on wherever the source tree happens to live.
$runtime = Join-Path $env:LOCALAPPDATA 'Mephisto'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

Copy-Item (Join-Path $src 'tetrarch-host.py')  (Join-Path $runtime 'tetrarch-host.py')  -Force
Copy-Item (Join-Path $src 'tetrarch-host.bat') (Join-Path $runtime 'tetrarch-host.bat') -Force
# WriteAllText, not Set-Content -Encoding UTF8: Windows PowerShell 5.1 (`powershell`) writes a BOM
# with that, and the path then never exists. The host also reads utf-8-sig, for files from before.
[IO.File]::WriteAllText((Join-Path $runtime 'tetrarch-path'), $Tetrarch)

$bat = Join-Path $runtime 'tetrarch-host.bat'
$manifestPath = Join-Path $runtime 'com.tetrarch.host.json'
# Built with ConvertTo-Json so the backslashes in the path are escaped correctly -- hand-written JSON
# with a Windows path in it is invalid far more often than it looks.
@{
    name           = 'com.tetrarch.host'
    description    = 'Tetrarch four-player chess engine bridge for the Mephisto extension (native messaging)'
    path           = $bat
    type           = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

# --- register ------------------------------------------------------------------------------------
# HKCU, so no administrator rights are needed. The key is created whether or not the browser is
# installed; a key for a browser you do not have is inert.
$roots = @(
    'HKCU:\Software\Google\Chrome',
    'HKCU:\Software\Chromium',
    'HKCU:\Software\Microsoft\Edge',
    'HKCU:\Software\BraveSoftware\Brave-Browser',
    'HKCU:\Software\Vivaldi'
)
foreach ($root in $roots) {
    $key = "$root\NativeMessagingHosts\com.tetrarch.host"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name '(default)' -Value $manifestPath -PropertyType String -Force | Out-Null
    Write-Host "-> registered: $key"
}

Write-Host ''
Write-Host "-> engine:   $Tetrarch"
Write-Host "-> host:     $bat"
Write-Host "-> manifest: $manifestPath"
Write-Host ''
Write-Host 'Done. Reload the extension and the page, then pick "Tetrarch (4-player, Teams)".'
Write-Host 'If you move the extension to a different folder its id changes -- re-run this with the new -ExtId.'
