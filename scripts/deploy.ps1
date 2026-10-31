<#
  把本仓库的插件代码部署到「已安装的插件目录」，用于边改边测。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
    powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Target "C:\...\node_modules\dsh-live-pet"

  只覆盖代码与静态资源；不碰运行期产物（config.json / *.log / live-data / scene-profile /
  live/data、live/logs、live/songs、live/gifs、live/settings.json / __pycache__ / *.bak*）。
  部署完记得跑 scripts\reload.ps1 让 DSH 重新组合插件。
#>
param(
    [string]$Target = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Target -eq '') {
    if ($env:DSH_PROFILE_DIR) {
        $Target = Join-Path $env:DSH_PROFILE_DIR 'node_modules\dsh-live-pet'
    } else {
        $Target = 'C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-live-pet'
    }
}
if (-not (Test-Path (Join-Path $Target 'package.json'))) {
    throw "目标目录不像已安装的插件：$Target"
}

# 顶层：代码与静态资源
$topFiles = @('index.js', 'client.js', 'pet.ps1', 'cordis.patch.yml', 'package.json', 'icon.svg', 'README.md', 'config.example.json', 'LICENSE')
$topDirs  = @('scene', 'locale', 'frames', 'bg', 'live', 'profile', 'scripts')

function Should-Skip([string]$rel) {
    if ($rel -match '(^|\\)__pycache__(\\|$)') { return $true }
    if ($rel -match '\.pyc$') { return $true }
    if ($rel -match '\.bak') { return $true }
    if ($rel -match '(^|\\)data(\\|$)') { return $true }
    if ($rel -match '(^|\\)logs(\\|$)') { return $true }
    if ($rel -match '(^|\\)songs(\\|$)') { return $true }
    if ($rel -match '(^|\\)gifs(\\|$)') { return $true }
    if ($rel -match '(^|\\)settings\.json$') { return $true }
    if ($rel -match 'scene-profile') { return $true }
    if ($rel -match 'live-data') { return $true }
    return $false
}

$copied = 0
foreach ($f in $topFiles) {
    $from = Join-Path $root $f
    if (-not (Test-Path $from)) { continue }
    Copy-Item $from (Join-Path $Target $f) -Force
    $copied++
}
foreach ($d in $topDirs) {
    $fromDir = Join-Path $root $d
    if (-not (Test-Path $fromDir)) { continue }
    Get-ChildItem $fromDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length + 1)
        if (Should-Skip $rel) { return }
        $dest = Join-Path $Target $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
        Copy-Item $_.FullName $dest -Force
        $script:copied++
    }
}

Write-Host "已部署到 $Target（$copied 个文件）"
Write-Host "下一步：powershell -ExecutionPolicy Bypass -File scripts\reload.ps1"
