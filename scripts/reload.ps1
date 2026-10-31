<#
  让运行中的 DSH 重新组合 dsh-live-pet（改完代码后调用）。

  原理：在 profile 的 cordis.patch.yml 里临时加一条 `- id: dsh-live-pet / disabled: true`，
  HMR 会卸载插件；删掉这一条后 HMR 再重新加载 —— 于是新代码生效，且不用重启 DSH。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts\reload.ps1
    powershell -ExecutionPolicy Bypass -File scripts\reload.ps1 -Origin http://127.0.0.1:62209 -StatePath /dsh-live-pet/state
#>
param(
    [string]$Origin = "",
    [string]$StatePath = "/dsh-live-pet/state",
    [int]$OffSeconds = 4,
    [int]$OnSeconds = 12
)

$ErrorActionPreference = 'Stop'

if ($Origin -eq '') {
    if ($env:DSH_WEB_URL) {
        $Origin = $env:DSH_WEB_URL.TrimEnd('/')
    } else {
        # DSH 每次启动的网页端口都是随机的：挨个试本机监听端口，
        # 谁能回 /dsh-live-pet/state 或者像 DSH 的网页根，就用谁。
        $candidates = @()
        try {
            $appPids = @(Get-Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ProcessName -match 'deepseek|dsh|node|electron' } |
                Select-Object -ExpandProperty Id)
            $candidates += Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $appPids -contains $_.OwningProcess -and $_.LocalPort -ne 8791 } |
                Select-Object -ExpandProperty LocalPort -Unique
        } catch { /* 拿不到就退回默认端口 */ }
        $candidates += @(62209, 56915)
        # 只认能回插件 state 的那个端口，别把直播服务（8791）当成 DSH
        foreach ($port in ($candidates | Sort-Object -Unique)) {
            try {
                $null = Invoke-WebRequest -Uri ("http://127.0.0.1:$port" + $StatePath) -UseBasicParsing -TimeoutSec 3
                $Origin = "http://127.0.0.1:$port"
                break
            } catch { /* 下一个 */ }
        }
        if ($Origin -eq '') { $Origin = 'http://127.0.0.1:62209' }
    }
}
Write-Host "使用地址：$Origin" -ForegroundColor DarkGray
$profileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$patch = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $patch)) { throw "找不到 profile patch：$patch" }

$original = Get-Content -Raw -Encoding UTF8 $patch
$backup = "$patch.bak-reload-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $patch $backup -Force

try {
    $block = "`n- id: dsh-live-pet`n  disabled: true`n"
    Set-Content -Path $patch -Value ($original.TrimEnd() + $block) -Encoding UTF8 -NoNewline
    Write-Host "已停用插件，等待 HMR 卸载…"
    Start-Sleep -Seconds $OffSeconds

    Set-Content -Path $patch -Value $original -Encoding UTF8 -NoNewline
    Write-Host "已恢复配置，等待重新加载…"
    Start-Sleep -Seconds $OnSeconds

    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $response = Invoke-WebRequest -Uri ($Origin + $StatePath) -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 800
    }
    if ($ok) {
        Write-Host "插件已重新加载：$Origin$StatePath" -ForegroundColor Green
    } else {
        Write-Host "插件没回来，检查 $profileDir\node_modules\dsh-live-pet\live-pet.log" -ForegroundColor Yellow
        exit 1
    }
} finally {
    if ((Get-Content -Raw -Encoding UTF8 $patch) -ne $original) {
        Set-Content -Path $patch -Value $original -Encoding UTF8 -NoNewline
        Write-Host "配置已还原（备份：$backup）"
    }
}
