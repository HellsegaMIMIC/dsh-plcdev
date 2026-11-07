@echo off
setlocal
cd /d "%~dp0..\.."
python tools\plcdev_workbench.py open
if errorlevel 1 pause
