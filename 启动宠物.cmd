@echo off
chcp 65001 >nul
cd /d "%~dp0dist"
if not exist dsh-live-pet.exe (
  echo 找不到 dist\dsh-live-pet.exe
  echo 先运行： powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
  pause
  exit /b 1
)
echo 正在启动 dsh-live-pet，请等 5~15 秒（第一次要解包资源）…
start "" "%~dp0dist\dsh-live-pet.exe"
echo.
echo   设置页： http://127.0.0.1:8899/settings
echo   关宠物： 右键宠物 - 退出
echo.
echo 没反应就跑「诊断启动.cmd」看报错。
timeout /t 8 >nul