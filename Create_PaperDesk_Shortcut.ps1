# Creates a "PaperDesk" shortcut on the Desktop and in the Start menu.
$root = $PSScriptRoot
$tmp = Join-Path $env:TEMP 'PaperDesk.lnk'
# WScript.Shell can only save to ANSI-safe paths, so build the file in TEMP and move it (handles any language's folder names).
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($tmp)
$s.TargetPath = 'wscript.exe'
$s.Arguments = "`"$root\PaperDesk.vbs`""
$s.WorkingDirectory = $root
$s.Description = 'PaperDesk Freeboard'
$s.IconLocation = "$env:SystemRoot\System32\shell32.dll,43"
$s.Save()
$ok = $true
foreach ($name in 'Desktop', 'Programs') {
  $dest = [Environment]::GetFolderPath($name)
  try {
    Copy-Item -LiteralPath $tmp -Destination (Join-Path $dest 'PaperDesk.lnk') -Force -ErrorAction Stop
    Write-Host "Created in: $dest"
  } catch { $ok = $false; Write-Host "FAILED in ${name}: $($_.Exception.Message)" -ForegroundColor Red }
}
Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
if ($ok) { Write-Host 'Done. Look for PaperDesk on your Desktop and in the Start menu.' } else { exit 1 }
