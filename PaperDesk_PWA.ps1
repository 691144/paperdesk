# Starts the PWA server hidden, opens PaperDesk in its own window, and stops the server when that window closes.
$root = $PSScriptRoot
$url = 'http://localhost:8080'

function Test-Server { try { (Invoke-WebRequest "$url/sw.js" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch { $false } }

$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Start-Process $url; exit }   # no Edge/Chrome found: fall back to the default browser

# Only stop a server this launcher started itself.
$server = $null
if (-not (Test-Server)) {
  $server = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$root\serve_pwa.ps1`"",'-Quiet'
  for ($i = 0; $i -lt 50 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 100 }
}

# A private profile makes this its own browser process, so -Wait lasts until the window is closed.
$profile = Join-Path $env:LOCALAPPDATA 'PaperDesk\browser-profile'
Start-Process $browser -Wait -ArgumentList "--app=$url", "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check'

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
