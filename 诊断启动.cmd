@echo off
chcp 65001 >nul
cd /d "%~dp0dist"
echo 在窗口里直接运行，报错不会闪退（方便截图发我）。
echo 正常启动后这个窗口会一直占着，最小化就行；关掉它 = 关掉程序。
echo.
"%~dp0dist\dsh-live-pet.exe"
echo.
echo 退出码：%ERRORLEVEL%
echo.
echo 日志（按顺序找）：
echo   %LOCALAPPDATA%\dsh-live-pet\app.log
echo   %TEMP%\dsh-live-pet-logs\app.log
echo   %~dp0dist\dsh-live-pet-data\app.log
pause