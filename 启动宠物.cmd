@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0dist"
set EXE=%~dp0dist\dsh-live-pet.exe
if not exist "%EXE%" (
  echo [错误] 找不到 %EXE%
  pause
  exit /b 1
)
echo ============================================================
echo   直播宠物 dsh-live-pet
echo ============================================================
echo 正在启动：%EXE%
echo 第一次启动杀软会先扫一遍 100MB 的 exe，可能十几秒没反应，别急着重复点。
echo.
start "" "%EXE%"
set FOUND=0
for /L %%i in (1,1,40) do (
  if !FOUND! equ 0 (
    tasklist /fi "imagename eq dsh-live-pet.exe" 2>nul | find /i "dsh-live-pet.exe" >nul
    if !errorlevel! equ 0 (
      set FOUND=1
      echo [OK] 进程已在运行（%%i 秒）
    ) else (
      if %%i equ 5 echo   ...5 秒还没起来，继续等（要解包 9.6MB 资源）
      if %%i equ 15 echo   ...15 秒还没起来，继续等
      if %%i equ 30 echo   ...30 秒还没起来，快出结论了
      timeout /t 1 >nul
    )
  )
)
echo.
if !FOUND! equ 0 (
  echo [失败] 40 秒内没等到 dsh-live-pet.exe 进程，说明 exe 根本没跑起来。
  echo 常见原因：杀软/SmartScreen 拦截、文件被占用、权限不足。
  echo.
  echo 日志内容（有就贴给我）：
  echo ---- %LOCALAPPDATA%\dsh-live-pet\app.log ----
  if exist "%LOCALAPPDATA%\dsh-live-pet\app.log" type "%LOCALAPPDATA%\dsh-live-pet\app.log"
  echo ---- %TEMP%\dsh-live-pet-logs\app.log ----
  if exist "%TEMP%\dsh-live-pet-logs\app.log" type "%TEMP%\dsh-live-pet-logs\app.log"
  echo ---- 以上都没有输出 = 连日志都没写，基本被拦了 ----
  echo.
  pause
  exit /b 1
)
echo 设置页地址： http://127.0.0.1:8899/settings
echo 稍后会自动弹设置窗口；没弹就手动把地址粘到浏览器。
echo 关宠物：右键宠物 - 退出。
timeout /t 6 >nul