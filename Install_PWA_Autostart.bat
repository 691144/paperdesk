@echo off
rem One-time setup: starts the PaperDesk PWA server silently every time you sign in to Windows.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\PaperDesk PWA Server.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0PaperDesk_Server_Hidden.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
wscript.exe "%~dp0PaperDesk_Server_Hidden.vbs"
echo.
echo Done. The PaperDesk server now starts by itself at sign-in.
echo Open http://localhost:8080 once and choose "Install" in the address bar.
echo After that, PaperDesk opens like any app, with nothing to start.
echo To undo: delete "PaperDesk PWA Server" from %%APPDATA%%\Microsoft\Windows\Start Menu\Programs\Startup
pause
