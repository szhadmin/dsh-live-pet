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
    $Origin = if ($env:DSH_WEB_URL) { $env:DSH_WEB_URL.TrimEnd('/') } else { 'http://127.0.0.1:62209' }
}
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
