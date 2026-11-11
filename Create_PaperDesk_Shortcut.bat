@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Create_PaperDesk_Shortcut.ps1"
pause
