' Double-click to open PaperDesk. The server runs hidden and stops when the window closes.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\PaperDesk_PWA.ps1""", 0, False
