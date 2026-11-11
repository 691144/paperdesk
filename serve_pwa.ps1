param([switch]$Quiet)
$ErrorActionPreference = 'SilentlyContinue'
$webRoot = Join-Path $PSScriptRoot 'web'
$port = 8080

# Find local Wi-Fi / LAN IPv4 address for mobile testing
# Fast path (.NET, ~instant): an active adapter that has a default gateway (skips WSL/Hyper-V virtual NICs)
$lanIp = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
  Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
  ForEach-Object { $p = $_.GetIPProperties(); if ($p.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' }) { $p.UnicastAddresses } } |
  Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
  Select-Object -First 1 | ForEach-Object { $_.Address.ToString() }
# Fallback (original, slower CIM query)
if (-not $lanIp) { $lanIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
  $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown'
} | Select-Object -First 1 -ExpandProperty IPAddress) }
if (-not $lanIp) { $lanIp = '127.0.0.1' }

# -Quiet (used at sign-in): loopback only, no browser, and exit if a server is already running.
$bindAddr = if ($Quiet) { [System.Net.IPAddress]::Loopback } else { [System.Net.IPAddress]::Any }
$listener = New-Object System.Net.Sockets.TcpListener($bindAddr, $port)
try {
  $listener.Start()
} catch {
  if ($Quiet) { exit 0 }
  $port = 8088
  $listener = New-Object System.Net.Sockets.TcpListener($bindAddr, $port)
  $listener.Start()
}

Write-Host ""
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   PaperDesk Freeboard - Desktop & Mobile PWA Server Running" -ForegroundColor Green
Write-Host "  ============================================================" -ForegroundColor Cyan
Write-Host "   Desktop URL (Install PWA):  http://localhost:$port" -ForegroundColor Yellow
Write-Host "   Mobile Wi-Fi URL:           http://${lanIp}:$port" -ForegroundColor Yellow
Write-Host "  ------------------------------------------------------------"
Write-Host "   Press Ctrl+C in this window to stop the server."
Write-Host ""

if (-not $Quiet) { Start-Process "http://localhost:$port" }

$mimeMap = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/manifest+json; charset=utf-8'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

# Each connection runs on its own thread: browsers open idle "preconnect" sockets that must not block real requests.
$handler = {
  param($client, $webRoot, $mimeMap)
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 5000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $reqLine = $reader.ReadLine()
    if ($reqLine) { while ($reader.ReadLine()) {} }

    if ($reqLine -match '^GET\s+([^\s]+)') {
      $rawPath = [System.Uri]::UnescapeDataString(($Matches[1] -split '\?')[0])
      if ($rawPath -eq '/' -or $rawPath -eq '') { $rawPath = '/index.html' }
      $safeRel = $rawPath.TrimStart('/').Replace('/', [string][char]92)
      $filePath = [System.IO.Path]::GetFullPath((Join-Path $webRoot $safeRel))
      $inside = $filePath.StartsWith([System.IO.Path]::GetFullPath($webRoot), [System.StringComparison]::OrdinalIgnoreCase)

      if ($inside -and (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
        $ct = if ($mimeMap.ContainsKey($ext)) { $mimeMap[$ext] } else { 'application/octet-stream' }
        $header = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
        $hBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($hBytes, 0, $hBytes.Length)
        $stream.Write($bytes, 0, $bytes.Length)
      } else {
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $header = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain`r`nContent-Length: $($msg.Length)`r`nConnection: close`r`n`r`n"
        $hBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
        $stream.Write($hBytes, 0, $hBytes.Length)
        $stream.Write($msg, 0, $msg.Length)
      }
    }
  } catch {
  } finally {
    try { $client.Close() } catch {}
  }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 16)
$pool.Open()

while ($true) {
  if (-not $listener.Pending()) {
    Start-Sleep -Milliseconds 10
    continue
  }
  $client = $listener.AcceptTcpClient()
  $ps = [powershell]::Create()
  $ps.RunspacePool = $pool
  [void]$ps.AddScript($handler).AddArgument($client).AddArgument($webRoot).AddArgument($mimeMap)
  [void]$ps.BeginInvoke()
}
