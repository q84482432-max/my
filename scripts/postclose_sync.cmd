@echo off
REM 本地收盘后自动同步任务包装器
REM 由 Windows 任务计划程序（AStockPostcloseSync-1840 / -2100）调用。
REM 脚本自身会把带时间戳的明细写入 D:\AStockData\logs\postclose_sync_<YYYY-MM-DD>.txt；
REM 这里再把控制台输出追加到一份按日期的日志，便于排查。
setlocal
set "PY=C:\Users\Administrator.USER-20260201WA\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
set "PROJ=D:\a-share-sim-trading"
set "LOG=D:\AStockData\logs"
if not exist "%LOG%" mkdir "%LOG%"

REM 取本机日期（与脚本日志同名日期前缀一致）
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "STAMP=%%i"

"%PY%" "%PROJ%\scripts\postclose_sync.py" >> "%LOG%\postclose_sync_%STAMP%.cmd.txt" 2>&1
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] postclose_sync.py exit=%RC% >> "%LOG%\postclose_sync_%STAMP%.cmd.txt"
exit /b %RC%
