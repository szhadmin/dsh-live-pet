<#
  把直播服务的最新代码同步进本仓库的 live/ 目录。
  用法：  powershell -ExecutionPolicy Bypass -File scripts\sync-live.ps1 -Source F:\douyinlive
  只拷代码（app.py / core / vendor / web / defaults），不带 data、logs、songs、gifs、dist、settings.json。
#>
param([Parameter(Mandatory=$true)][string]$Source)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'live'
if (-not (Test-Path (Join-Path $Source 'app.py'))) { throw "源目录里没有 app.py：$Source" }

New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $Source 'app.py') (Join-Path $dest 'app.py') -Force
foreach ($d in 'core', 'vendor', 'web') {
    $from = Join-Path $Source $d
    if (-not (Test-Path $from)) { continue }
    $to = Join-Path $dest $d
    if (Test-Path $to) { Remove-Item -Recurse -Force $to }
    Copy-Item $from $to -Recurse
}
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'defaults') | Out-Null
foreach ($f in 'settings.json', 'douyin-gifts.json', 'README.md') {
    $p = Join-Path $Source "defaults\$f"
    if (Test-Path $p) { Copy-Item $p (Join-Path $dest 'defaults') -Force }
}
# 清掉缓存文件
Get-ChildItem $dest -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $dest -Recurse -File -Filter '*.pyc' | Remove-Item -Force -ErrorAction SilentlyContinue

$size = [math]::Round(((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 2)
$count = (Get-ChildItem $dest -Recurse -File | Measure-Object).Count
Write-Host "live/ 已同步：$count 个文件，$size MB"
Write-Host "记得 git add live && git commit"