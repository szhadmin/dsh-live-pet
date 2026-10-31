<#
  把 dsh-live-pet 打成一个单文件 exe（Node SEA）。

  powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1 -Out "D:\dist\dsh-live-pet.exe"

  产物：dist\dsh-live-pet.exe（自带宠物窗口脚本 + 帧图 + 直播服务代码 + 设置页），
  首次运行会把资源解到 %LOCALAPPDATA%\dsh-live-pet\app，配置也写在那。
#>
param(
    [string]$Out = "",
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
if ($Out -eq '') { $Out = Join-Path $dist 'dsh-live-pet.exe' }

# 原生命令（esbuild / tar / node / postject）往 stderr 写东西时，
# PowerShell 5.1 会当成 ErrorRecord，配合 Stop 会直接中断，所以单独包一层。
function Invoke-Native([string]$Exe, [string[]]$Argv) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Argv 2>&1 | ForEach-Object { Write-Host ("    " + $_) }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

$node = (Get-Command node -ErrorAction Stop).Source
# 版本号交给 node 读（PowerShell 5.1 的 ConvertFrom-Json 会被 UTF-8 中文描述噎住）
$version = (& $node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" (Join-Path $root 'package.json')).Trim()
Write-Host "打 exe：版本 $version，node $((& $node -v))"

if (-not $SkipInstall) {
    if (-not (Test-Path (Join-Path $root 'node_modules\esbuild'))) {
        Write-Host '安装 esbuild…'
        Invoke-Native 'npm' @('install', '--no-audit', '--no-fund', '--silent', 'esbuild') | Out-Null
    }
    if (-not (Test-Path (Join-Path $root 'node_modules\postject'))) {
        Write-Host '安装 postject…'
        Invoke-Native 'npm' @('install', '--no-audit', '--no-fund', '--silent', 'postject') | Out-Null
    }
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null

# 1) 打成单个 CJS 包
$bundle = Join-Path $dist 'app.bundle.js'
Write-Host '1/5 esbuild 打包 app/main.js…'
Invoke-Native $node @(
    (Join-Path $root 'node_modules\esbuild\bin\esbuild'),
    (Join-Path $root 'app\main.js'),
    '--bundle', '--platform=node', '--format=cjs', '--target=node24', '--minify-syntax',
    "--outfile=$bundle",
    '--define:__IS_SEA__=true'
) | Out-Null
if (-not (Test-Path $bundle)) { throw 'esbuild 没有产出 bundle' }
Write-Host ("    bundle {0:N1} KB" -f ((Get-Item $bundle).Length / 1KB))

# 2) 资源打包成 zip（frames / bg / live / profile / pet.ps1 / app\settings.html …）
$zip = Join-Path $dist 'assets.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host '2/5 打包资源 zip…'
$items = @('pet.ps1', 'frames', 'bg', 'live', 'profile', 'scene', 'locale', 'app\settings.html', 'package.json', 'config.example.json', 'README.md') |
    Where-Object { Test-Path (Join-Path $root $_) }
Push-Location $root
try {
    Invoke-Native 'tar' (@('-a', '-c', '-f', $zip) + $items) | Out-Null
} finally {
    Pop-Location
}
if (-not (Test-Path $zip)) { throw 'tar 打包失败' }
Write-Host ("    assets.zip {0:N1} MB" -f ((Get-Item $zip).Length / 1MB))

# 3) SEA 配置 → blob
Write-Host '3/5 生成 SEA blob…'
$seaConfig = Join-Path $dist 'sea-config.json'
$config = [ordered]@{
    main                          = 'app.bundle.js'
    output                        = 'sea-prep.blob'
    disableExperimentalSEAWarning = $true
    useSnapshot                   = $false
    useCodeCache                  = $false
    assets                        = @{ 'assets.zip' = 'assets.zip' }
}
# 无 BOM（node 读 sea-config.json 时不一定吃 BOM）
[System.IO.File]::WriteAllText($seaConfig, ($config | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Push-Location $dist
try {
    Invoke-Native $node @('--experimental-sea-config', 'sea-config.json') | Out-Null
} finally {
    Pop-Location
}
if (-not (Test-Path (Join-Path $dist 'sea-prep.blob'))) { throw '生成 SEA blob 失败' }

# 4) 复制 node.exe 并注入 blob
Write-Host '4/5 注入 blob 到 exe…'
Copy-Item $node $Out -Force
$postject = Join-Path $root 'node_modules\postject\dist\cli.js'
Invoke-Native $node @(
    $postject, $Out, 'NODE_SEA_BLOB', (Join-Path $dist 'sea-prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
) | Out-Null

# 5) 收尾
$sizeMb = [Math]::Round((Get-Item $Out).Length / 1MB, 1)
Write-Host "5/5 完成：$Out（$sizeMb MB）"
Write-Host '双击即用；第一次运行会自动打开设置页，资源解到 %LOCALAPPDATA%\dsh-live-pet\app'
