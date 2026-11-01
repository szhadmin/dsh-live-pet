#Requires -Version 5.1
<#
    小鲸鱼直播宠物 —— DSH 插件 dsh-live-pet 的"身体"。

    无边框、透明、置顶的桌面窗口：
      · 每 700ms 轮询 DSH Host 的 /dsh-live-pet/state，冒气泡 / 切情绪动图 / 播放 mp3
      · 单击 = 弹出输入条，打字回车就发进同一条 DSH 会话
      · 拖动 = 移动；Ctrl+滚轮 或右键菜单 = 缩放
      · 按下有挤压回弹反馈

    环境变量：
      PET_STATE_URL         状态地址（双智能体时带 ?slot=a|b），默认 http://127.0.0.1:64420/dsh-live-pet/state
      PET_FRAMES            形象目录：<情绪>.gif 或 <情绪>/*.png，默认为本脚本同级的 frames
      PET_FALLBACK_FRAMES   形象缺某个情绪时回退到这（默认也是 frames）
      PET_SLOT              a = 主宠物，b = 连麦搭子（两只宠物就是两个窗口）
      PET_LOG               窗口日志文件名，默认 pet-window.log
      PET_SILENT            1 = 静音启动
#>
$ErrorActionPreference = 'Stop'

$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:Slot = if ($env:PET_SLOT -eq 'b') { 'b' } else { 'a' }
$script:IsSlotB = ($script:Slot -eq 'b')
# 黑白掌机窗口总开关：现在是真·植物大战僵尸（游戏本体窗口在演），这里关掉
$script:ShowGameConsole = $false
$script:FramesRoot = if ($env:PET_FRAMES) { $env:PET_FRAMES } else { Join-Path $script:Root 'frames' }
$script:FramesFallback = if ($env:PET_FALLBACK_FRAMES) { $env:PET_FALLBACK_FRAMES } else { Join-Path $script:Root 'frames' }
$script:StateUrl = if ($env:PET_STATE_URL) { $env:PET_STATE_URL } else { 'http://127.0.0.1:64420/dsh-live-pet/state' }
# 地址里可能带 ?slot=b，替换时要把查询串一起吃掉
$script:ChatUrl = $script:StateUrl -replace '/state(\?.*)?$', '/chat'
# 插件的其它接口都挂在这个前缀下（/poses、/pose、/config）
$script:HostBase = $script:StateUrl -replace '/state(\?.*)?$', ''
$script:LogFile = if ($env:PET_LOG) { Join-Path $script:Root $env:PET_LOG } else { Join-Path $script:Root 'pet-window.log' }
$script:FrameSize = 240
$script:ScaleSteps = @(0.6, 0.85, 1.1, 1.35)
$script:Scale = 0.75
$script:BubbleArea = 190
$script:Silent = ($env:PET_SILENT -eq '1')

function Write-PetLog([string]$Message) {
    try {
        $line = '{0} {1}' -f ([DateTime]::Now.ToString('HH:mm:ss')), $Message
        Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
    } catch { }
}

# 只允许一个宠物窗口
$script:MutexName = 'Global\dsh-live-pet-window-' + $script:Slot
$script:Mutex = New-Object System.Threading.Mutex($false, $script:MutexName)
try {
    if (-not $script:Mutex.WaitOne(0)) { return }
} catch { }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$script:MetaCache = @{}
function Get-FramesMeta([string]$Root) {
    if ($script:MetaCache.ContainsKey($Root)) { return $script:MetaCache[$Root] }
    $result = $null
    $file = Join-Path $Root 'meta.json'
    if (Test-Path $file) {
        try { $result = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $result = $null }
    }
    $script:MetaCache[$Root] = $result
    return $result
}

function ConvertTo-Bitmap([string]$Path) {
    $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit()
    $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bitmap.CreateOptions = [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat
    $bitmap.UriSource = New-Object System.Uri($Path)
    $bitmap.EndInit()
    $bitmap.Freeze()
    return $bitmap
}

# PNG 序列：<root>/<情绪>/*.png
function Load-PngState([string]$Root, [string]$StateName) {
    $dir = Join-Path $Root $StateName
    if (-not (Test-Path $dir)) { return $null }
    $files = @(Get-ChildItem -Path $dir -Filter '*.png' | Sort-Object Name)
    if ($files.Count -eq 0) { return $null }
    $frames = New-Object System.Collections.ArrayList
    foreach ($file in $files) {
        try { [void]$frames.Add((ConvertTo-Bitmap $file.FullName)) } catch { }
    }
    if ($frames.Count -eq 0) { return $null }
    $durations = @()
    $meta = Get-FramesMeta $Root
    if ($null -ne $meta) {
        foreach ($value in $meta.($StateName).durations) { $durations += [int]$value }
    }
    if ($durations.Count -eq 0) {
        for ($i = 0; $i -lt $frames.Count; $i++) { $durations += 90 }
    }
    return @{ Frames = $frames.ToArray(); Durations = $durations }
}

# 从 GIF 字节里读每帧延时（GCE 块 21 F9 04，单位 1/100 秒）
function Get-GifDelays([string]$Path) {
    $delays = New-Object System.Collections.ArrayList
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $i = 0
        while ($i -lt $bytes.Length - 6) {
            if ($bytes[$i] -eq 0x21 -and $bytes[$i + 1] -eq 0xF9 -and $bytes[$i + 2] -eq 0x04) {
                $centis = [int]$bytes[$i + 4] + ([int]$bytes[$i + 5] * 256)
                if ($centis -le 0) { $centis = 10 }
                [void]$delays.Add([int]($centis * 10))
                $i += 8
                continue
            }
            $i += 1
        }
    } catch {
        Write-PetLog ('gif delay parse failed: ' + $_.Exception.Message)
    }
    return $delays.ToArray()
}

# GIF：<root>/<情绪>.gif（或 <root>/gif/<情绪>.gif），每帧时长取 GIF 自己的
function Load-GifState([string]$Root, [string]$StateName) {
    $candidates = @((Join-Path $Root ($StateName + '.gif')), (Join-Path $Root ('gif\' + $StateName + '.gif')))
    foreach ($path in $candidates) {
        if (-not (Test-Path $path)) { continue }
        try {
            $uri = New-Object System.Uri($path)
            $stream = [System.IO.File]::OpenRead($path)
            $decoder = New-Object System.Windows.Media.Imaging.GifBitmapDecoder($stream, [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
            $frames = New-Object System.Collections.ArrayList
            $durations = @()
            foreach ($frame in $decoder.Frames) {
                $frame.Freeze()
                [void]$frames.Add($frame)
                $durations += [int]90
            }
            $stream.Close()
            if ($frames.Count -gt 0) {
                # 先按 GIF 自己写的延时走，skin 目录里的 meta.json 若给了就覆盖
                $real = Get-GifDelays $path
                if ($real.Count -gt 0) { $durations = $real }
                $metaRoot = Get-FramesMeta $Root
                $override = @()
                if ($null -ne $metaRoot) {
                    foreach ($value in $metaRoot.($StateName).durations) { $override += [int]$value }
                }
                if ($override.Count -eq $frames.Count) { $durations = $override }
                while ($durations.Count -lt $frames.Count) { $durations += 90 }
                return @{ Frames = $frames.ToArray(); Durations = $durations }
            }
        } catch {
            Write-PetLog ('gif load failed: ' + $path + ' ' + $_.Exception.Message)
        }
    }
    return $null
}

$script:States = @{}

function Load-State([string]$StateName) {
    # 先看配置的形象（GIF 优先，再 PNG 序列），都没有就回退内置 frames
    $loaded = Load-GifState $script:FramesRoot $StateName
    if ($null -eq $loaded) { $loaded = Load-PngState $script:FramesRoot $StateName }
    if ($null -eq $loaded -and $script:FramesFallback -ne $script:FramesRoot) {
        $loaded = Load-GifState $script:FramesFallback $StateName
        if ($null -eq $loaded) { $loaded = Load-PngState $script:FramesFallback $StateName }
    }
    return $loaded
}

$script:Emotions = @('happy', 'mischievous', 'crying', 'unhappy', 'eating', 'cooking', 'coding', 'tv', 'walking')
foreach ($stateName in $script:Emotions) {
    $loaded = Load-State $stateName
    if ($null -ne $loaded) { $script:States[$stateName] = $loaded }
}
Write-PetLog ('frames loaded: {0} emotions from {1}' -f $script:States.Count, $script:FramesRoot)
if ($script:States.Count -eq 0) { Write-PetLog 'no frames loaded'; return }

# ---------------------------------------------------------------- 窗口控件
$script:Bubble = New-Object System.Windows.Controls.Border
$script:Bubble.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(238, 18, 40, 58))
$script:Bubble.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(120, 120, 200, 240))
$script:Bubble.BorderThickness = [System.Windows.Thickness]::new(1)
$script:Bubble.CornerRadius = [System.Windows.CornerRadius]::new(12)
$script:Bubble.Padding = [System.Windows.Thickness]::new(14, 10, 14, 10)
$script:Bubble.HorizontalAlignment = 'Center'
$script:Bubble.VerticalAlignment = 'Bottom'
$script:Bubble.Visibility = 'Collapsed'

$script:BubbleText = New-Object System.Windows.Controls.TextBlock
$script:BubbleText.Foreground = [System.Windows.Media.Brushes]::White
$script:BubbleText.FontSize = 21
$script:BubbleText.LineHeight = 31
$script:BubbleText.TextWrapping = 'Wrap'
$script:BubbleText.TextAlignment = 'Center'
$script:Bubble.Child = $script:BubbleText

# 输入条：单击宠物时出现，回车发送
$script:InputBorder = New-Object System.Windows.Controls.Border
$script:InputBorder.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(245, 16, 34, 50))
$script:InputBorder.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(200, 110, 190, 240))
$script:InputBorder.BorderThickness = [System.Windows.Thickness]::new(1)
$script:InputBorder.CornerRadius = [System.Windows.CornerRadius]::new(10)
$script:InputBorder.Padding = [System.Windows.Thickness]::new(8, 4, 8, 4)
$script:InputBorder.HorizontalAlignment = 'Center'
$script:InputBorder.VerticalAlignment = 'Bottom'
$script:InputBorder.Visibility = 'Collapsed'

$script:Box = New-Object System.Windows.Controls.TextBox
$script:Box.Width = 280
$script:Box.FontSize = 18
$script:Box.BorderThickness = [System.Windows.Thickness]::new(0)
$script:Box.Background = [System.Windows.Media.Brushes]::Transparent
$script:Box.Foreground = [System.Windows.Media.Brushes]::White
$script:Box.CaretBrush = [System.Windows.Media.Brushes]::White
$script:Box.ToolTip = '打字后回车发送，Esc 取消'
$script:InputBorder.Child = $script:Box

$script:Image = New-Object System.Windows.Controls.Image
$script:Image.Stretch = [System.Windows.Media.Stretch]::Uniform
$script:Image.IsHitTestVisible = $false
$script:Image.VerticalAlignment = 'Stretch'
$script:Image.HorizontalAlignment = 'Center'
[System.Windows.Media.RenderOptions]::SetBitmapScalingMode($script:Image, [System.Windows.Media.BitmapScalingMode]::HighQuality)

# 挤压回弹：以底部中心为原点
$script:Squash = New-Object System.Windows.Media.ScaleTransform(1.0, 1.0)
# 翻转（ScaleX = -1）和挤压是两套变换，合成一个组才不会互相覆盖
$script:Flip = New-Object System.Windows.Media.ScaleTransform(1.0, 1.0)
# 位移：动作特效（蹦一下 / 抖一抖）用，只动渲染，不改窗口几何
$script:Shift = New-Object System.Windows.Media.TranslateTransform(0, 0)
$script:ImageTransforms = New-Object System.Windows.Media.TransformGroup
[void]$script:ImageTransforms.Children.Add($script:Squash)
[void]$script:ImageTransforms.Children.Add($script:Flip)
[void]$script:ImageTransforms.Children.Add($script:Shift)
$script:Image.RenderTransformOrigin = [System.Windows.Point]::new(0.5, 1.0)
$script:Image.RenderTransform = $script:ImageTransforms

$grid = New-Object System.Windows.Controls.Grid
$rowBubble = New-Object System.Windows.Controls.RowDefinition
$rowBubble.Height = New-Object System.Windows.GridLength([double]$script:BubbleArea)
$rowImage = New-Object System.Windows.Controls.RowDefinition
$rowImage.Height = New-Object System.Windows.GridLength(1.0, [System.Windows.GridUnitType]::Star)
[void]$grid.RowDefinitions.Add($rowBubble)
[void]$grid.RowDefinitions.Add($rowImage)

$top = New-Object System.Windows.Controls.Grid
[void]$top.Children.Add($script:Bubble)
[void]$top.Children.Add($script:InputBorder)
[System.Windows.Controls.Grid]::SetRow($top, 0)
[System.Windows.Controls.Grid]::SetRow($script:Image, 1)
[void]$grid.Children.Add($top)
[void]$grid.Children.Add($script:Image)

# ---------------------------------------------------------------- 歌单板
# 放在宠物右侧，和宠物在同一个窗口里：OBS 抓一次就够，不用两个来源。
$script:BoardWidth = 200
$script:PetWidth = 300
$script:BoardEnabled = $true
$script:BoardVisible = $false
$script:BoardExtra = 0
$script:Board = New-Object System.Windows.Controls.Border
$script:Board.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(215, 18, 23, 32))
$script:Board.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(110, 120, 200, 255))
$script:Board.BorderThickness = [System.Windows.Thickness]::new(1)
$script:Board.CornerRadius = [System.Windows.CornerRadius]::new(12)
$script:Board.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
$script:Board.Margin = [System.Windows.Thickness]::new(0, 0, 8, 8)
$script:Board.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
$script:Board.Width = $script:BoardWidth
$script:BoardText = New-Object System.Windows.Controls.TextBlock
$script:BoardText.Foreground = [System.Windows.Media.Brushes]::White
$script:BoardText.FontSize = 16
$script:BoardText.LineHeight = 18
$script:BoardText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$script:BoardText.Text = '点歌台'
$script:Board.Child = $script:BoardText

# 直播场景：背景图 + 左上角弹幕池 + 右上角点歌台，全部画在同一个窗口里
# （单窗口的好处：OBS 直接抓这个窗口就够了，不用多个来源对齐）
$script:SceneMode = $false
# 背景的三态：full / minimal（收起来只留宠物）/ off
$script:SceneDisplay = ''
$script:PetX = 0.0
$script:PetY = 0.0

$script:SceneBg = New-Object System.Windows.Controls.Border
$script:SceneBg.Visibility = 'Collapsed'
$script:SceneBgBrush = New-Object System.Windows.Media.ImageBrush
$script:SceneBgBrush.Stretch = [System.Windows.Media.Stretch]::UniformToFill
$script:SceneBg.Background = $script:SceneBgBrush

# ---- 游戏画面当背景板（植物大战僵尸嵌进宠物窗口的背景里） ----
$script:GameBgOn = $false
$script:GameBgUrl = ''
$script:GameBgClient = $null
$script:GameBgFails = 0
$script:GameBgTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:GameBgTimer.Interval = [TimeSpan]::FromMilliseconds(220)

$script:PoolPanel = New-Object System.Windows.Controls.Border
$script:PoolPanel.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(210, 8, 14, 24))
$script:PoolPanel.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 255, 255, 255))
$script:PoolPanel.BorderThickness = [System.Windows.Thickness]::new(1)
$script:PoolPanel.CornerRadius = [System.Windows.CornerRadius]::new(16)
$script:PoolPanel.Padding = [System.Windows.Thickness]::new(18, 14, 18, 16)
$script:PoolPanel.HorizontalAlignment = 'Left'
$script:PoolPanel.VerticalAlignment = 'Top'
$script:PoolPanel.Margin = [System.Windows.Thickness]::new(28, 26, 0, 0)
$script:PoolPanel.Width = 600
$script:PoolPanel.Visibility = 'Collapsed'
# 弹幕池：一行一个 TextBlock，按类型上色，越旧越淡
$script:PoolFontSize = 26
$script:PoolSignature = ''
$script:PoolRows = New-Object System.Windows.Controls.StackPanel
$script:PoolRows.VerticalAlignment = 'Bottom'
$script:PoolScroll = New-Object System.Windows.Controls.ScrollViewer
$script:PoolScroll.VerticalScrollBarVisibility = 'Hidden'
$script:PoolScroll.HorizontalScrollBarVisibility = 'Disabled'
$script:PoolScroll.Content = $script:PoolRows
$script:PoolTitle = New-Object System.Windows.Controls.TextBlock
$script:PoolTitle.Text = '弹幕池'
$script:PoolTitle.Foreground = [System.Windows.Media.Brushes]::White
$script:PoolTitle.FontSize = 26
$script:PoolTitle.FontWeight = 'Bold'
$script:PoolTitle.Margin = [System.Windows.Thickness]::new(0, 0, 0, 10)
$script:PoolHost = New-Object System.Windows.Controls.StackPanel
[void]$script:PoolHost.Children.Add($script:PoolTitle)
[void]$script:PoolHost.Children.Add($script:PoolScroll)
$script:PoolPanel.Child = $script:PoolHost

$script:SongPanel = New-Object System.Windows.Controls.Border
$script:SongPanel.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(210, 8, 14, 24))
$script:SongPanel.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 255, 255, 255))
$script:SongPanel.BorderThickness = [System.Windows.Thickness]::new(1)
$script:SongPanel.CornerRadius = [System.Windows.CornerRadius]::new(16)
$script:SongPanel.Padding = [System.Windows.Thickness]::new(18, 14, 18, 16)
$script:SongPanel.HorizontalAlignment = 'Right'
$script:SongPanel.VerticalAlignment = 'Top'
$script:SongPanel.Margin = [System.Windows.Thickness]::new(0, 26, 28, 0)
$script:SongPanel.Width = 360
$script:SongPanel.Visibility = 'Collapsed'
$script:SongText = New-Object System.Windows.Controls.TextBlock
$script:SongText.Foreground = [System.Windows.Media.Brushes]::White
$script:SongText.FontSize = 22
$script:SongText.LineHeight = 27
$script:SongText.TextWrapping = [System.Windows.TextWrapping]::Wrap
# 当前播放进度条
$script:SongTrack = New-Object System.Windows.Controls.Border
$script:SongTrack.Height = 6
$script:SongTrack.CornerRadius = [System.Windows.CornerRadius]::new(3)
$script:SongTrack.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 255, 255, 255))
$script:SongTrack.Margin = [System.Windows.Thickness]::new(0, 10, 0, 0)
$script:SongFill = New-Object System.Windows.Shapes.Rectangle
$script:SongFill.Height = 6
$script:SongFill.Width = 0
$script:SongFill.RadiusX = 3
$script:SongFill.RadiusY = 3
$script:SongFill.HorizontalAlignment = 'Left'
$script:SongFill.Fill = New-Object System.Windows.Media.LinearGradientBrush(
    [System.Windows.Media.Color]::FromArgb(255, 74, 222, 128),
    [System.Windows.Media.Color]::FromArgb(255, 56, 189, 248),
    [System.Windows.Point]::new(0, 0.5),
    [System.Windows.Point]::new(1, 0.5))
$script:SongTrack.Child = $script:SongFill
$script:SongClock = New-Object System.Windows.Controls.TextBlock
$script:SongClock.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(180, 234, 242, 255))
$script:SongClock.FontSize = 18
$script:SongClock.Margin = [System.Windows.Thickness]::new(0, 6, 0, 0)
$script:SongHost = New-Object System.Windows.Controls.StackPanel
[void]$script:SongHost.Children.Add($script:SongText)
[void]$script:SongHost.Children.Add($script:SongTrack)
[void]$script:SongHost.Children.Add($script:SongClock)
$script:SongPanel.Child = $script:SongHost

# 左下角：本场数据（开播时长 / 弹幕 / 礼物 / 队列）
$script:StatsPanel = New-Object System.Windows.Controls.Border
$script:StatsPanel.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(210, 8, 14, 24))
$script:StatsPanel.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(90, 255, 255, 255))
$script:StatsPanel.BorderThickness = [System.Windows.Thickness]::new(1)
$script:StatsPanel.CornerRadius = [System.Windows.CornerRadius]::new(14)
$script:StatsPanel.Padding = [System.Windows.Thickness]::new(16, 12, 16, 14)
$script:StatsPanel.HorizontalAlignment = 'Left'
$script:StatsPanel.VerticalAlignment = 'Bottom'
$script:StatsPanel.Margin = [System.Windows.Thickness]::new(28, 0, 0, 26)
$script:StatsPanel.Width = 300
$script:StatsPanel.Visibility = 'Collapsed'
$script:StatsText = New-Object System.Windows.Controls.TextBlock
$script:StatsText.Foreground = [System.Windows.Media.Brushes]::White
$script:StatsText.FontSize = 20
$script:StatsText.LineHeight = 25
$script:StatsText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$script:StatsPanel.Child = $script:StatsText

# 烟花特效层：盖在最上面，不挡鼠标
# ---------------------------------------------- 第二只宠物（连麦搭子 B）
# 开了直播背景时 B 不再自己开窗口，而是由 A 的窗口一起画出来：
# OBS 只抓一个窗口就能同时看到两只，B 也一定落在背景范围内。
$script:PartnerWidth = 0.0
$script:PartnerHeight = 0.0
$script:PartnerVisible = $false
$script:PartnerScale = 0.84
$script:PartnerName = ''
$script:PartnerSeq = -1
$script:PartnerEmotion = ''
$script:PartnerFrames = $null
$script:PartnerDurations = $null
$script:PartnerIndex = 0
$script:PartnerX = 0.0
$script:PartnerY = 0.0
$script:PartnerTargetX = 0.0
$script:LastUsageLine = ''

$script:PartnerBubbleText = New-Object System.Windows.Controls.TextBlock
$script:PartnerBubbleText.Foreground = [System.Windows.Media.Brushes]::White
$script:PartnerBubbleText.FontSize = 18
$script:PartnerBubbleText.LineHeight = 26
$script:PartnerBubbleText.TextWrapping = 'Wrap'
$script:PartnerBubbleText.TextAlignment = 'Center'

$script:PartnerTag = New-Object System.Windows.Controls.TextBlock
$script:PartnerTag.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(215, 168, 226, 255))
$script:PartnerTag.FontSize = 14
$script:PartnerTag.TextAlignment = 'Center'
$script:PartnerTag.Margin = [System.Windows.Thickness]::new(0, 0, 0, 3)

$script:PartnerTagHost = New-Object System.Windows.Controls.StackPanel
[void]$script:PartnerTagHost.Children.Add($script:PartnerTag)
[void]$script:PartnerTagHost.Children.Add($script:PartnerBubbleText)

$script:PartnerBubble = New-Object System.Windows.Controls.Border
$script:PartnerBubble.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(238, 18, 40, 58))
$script:PartnerBubble.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(120, 120, 200, 240))
$script:PartnerBubble.BorderThickness = [System.Windows.Thickness]::new(1)
$script:PartnerBubble.CornerRadius = [System.Windows.CornerRadius]::new(12)
$script:PartnerBubble.Padding = [System.Windows.Thickness]::new(12, 8, 12, 8)
$script:PartnerBubble.HorizontalAlignment = 'Center'
$script:PartnerBubble.VerticalAlignment = 'Bottom'
$script:PartnerBubble.Visibility = 'Collapsed'
$script:PartnerBubble.Child = $script:PartnerTagHost

$script:PartnerImage = New-Object System.Windows.Controls.Image
$script:PartnerImage.Stretch = [System.Windows.Media.Stretch]::Uniform
$script:PartnerImage.IsHitTestVisible = $false
[System.Windows.Media.RenderOptions]::SetBitmapScalingMode($script:PartnerImage, [System.Windows.Media.BitmapScalingMode]::HighQuality)
$script:PartnerFlipTransform = New-Object System.Windows.Media.ScaleTransform(1.0, 1.0)
$script:PartnerImage.RenderTransformOrigin = [System.Windows.Point]::new(0.5, 1.0)
$script:PartnerImage.RenderTransform = $script:PartnerFlipTransform

$script:PartnerGrid = New-Object System.Windows.Controls.Grid
$pRowBubble = New-Object System.Windows.Controls.RowDefinition
$pRowBubble.Height = New-Object System.Windows.GridLength([double]120)
$pRowImage = New-Object System.Windows.Controls.RowDefinition
$pRowImage.Height = New-Object System.Windows.GridLength(1.0, [System.Windows.GridUnitType]::Star)
[void]$script:PartnerGrid.RowDefinitions.Add($pRowBubble)
[void]$script:PartnerGrid.RowDefinitions.Add($pRowImage)
[System.Windows.Controls.Grid]::SetRow($script:PartnerBubble, 0)
[System.Windows.Controls.Grid]::SetRow($script:PartnerImage, 1)
[void]$script:PartnerGrid.Children.Add($script:PartnerBubble)
[void]$script:PartnerGrid.Children.Add($script:PartnerImage)
$script:PartnerShell = $script:PartnerGrid
$script:PartnerShell.HorizontalAlignment = 'Left'
$script:PartnerShell.VerticalAlignment = 'Top'
$script:PartnerShell.IsHitTestVisible = $false
$script:PartnerShell.Visibility = 'Collapsed'
$script:FxLayer = New-Object System.Windows.Controls.Canvas
$script:FxLayer.IsHitTestVisible = $false
$script:Particles = New-Object System.Collections.ArrayList
$script:LastGiftFxAt = 0.0
$script:FxTimer = New-Object System.Windows.Threading.DispatcherTimer

# 宠物本体（含气泡和输入条）放在一个 host 里，场景模式下靠 Margin 在背景里移动
$shell = New-Object System.Windows.Controls.Grid
$colPet = New-Object System.Windows.Controls.ColumnDefinition
$colPet.Width = New-Object System.Windows.GridLength(1.0, [System.Windows.GridUnitType]::Star)
$colBoard = New-Object System.Windows.Controls.ColumnDefinition
$colBoard.Width = New-Object System.Windows.GridLength(0, [System.Windows.GridUnitType]::Auto)
# 左列放板子、右列放宠物：板子出现在宠物左侧
[void]$shell.ColumnDefinitions.Add($colBoard)
[void]$shell.ColumnDefinitions.Add($colPet)
[void]$shell.Children.Add($grid)
[System.Windows.Controls.Grid]::SetColumn($script:Board, 0)
[System.Windows.Controls.Grid]::SetColumn($grid, 1)
[void]$shell.Children.Add($script:Board)
$script:Shell = $shell
$script:Window = New-Object System.Windows.Window
$script:Window.Title = '小鲸鱼直播宠物'
$script:Window.WindowStyle = [System.Windows.WindowStyle]::None
$script:Window.AllowsTransparency = $true
$script:Window.Background = [System.Windows.Media.Brushes]::Transparent
$script:Window.Topmost = $true
$script:Window.ShowInTaskbar = $false
$script:Window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$script:Window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$root = New-Object System.Windows.Controls.Grid
[void]$root.Children.Add($script:SceneBg)
[void]$root.Children.Add($script:PoolPanel)
[void]$root.Children.Add($script:SongPanel)
[void]$root.Children.Add($script:StatsPanel)
[void]$root.Children.Add($script:PartnerShell)
[void]$root.Children.Add($shell)
[void]$root.Children.Add($script:FxLayer)
[System.Windows.Controls.Panel]::SetZIndex($script:PoolPanel, 1)
[System.Windows.Controls.Panel]::SetZIndex($script:SongPanel, 1)
[System.Windows.Controls.Panel]::SetZIndex($script:StatsPanel, 1)
[System.Windows.Controls.Panel]::SetZIndex($script:PartnerShell, 2)
[System.Windows.Controls.Panel]::SetZIndex($shell, 2)
[System.Windows.Controls.Panel]::SetZIndex($script:FxLayer, 3)
$script:Shell.HorizontalAlignment = 'Stretch'
$script:Shell.VerticalAlignment = 'Stretch'
$script:Window.Content = $root

# 隐藏启动时 Windows 会把 SW_HIDE 用在第一个顶层窗口上，这里显式显示
$script:Win32Ready = $false
try {
    Add-Type -Namespace PetNative3 -Name WindowApi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
'@
    $script:Win32Ready = $true
} catch { }
# 任何没接住的异常都记下来，别让窗口默默消失
$script:Window.Dispatcher.Add_UnhandledException({
    param($sender, $eventArgs)
    try { Write-PetLog ('UNHANDLED: ' + $eventArgs.Exception.GetType().Name + ': ' + $eventArgs.Exception.Message) } catch { }
    $eventArgs.Handled = $true
})

$script:Window.Add_SourceInitialized({
    if (-not $script:Win32Ready) { return }
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
        if ($helper.Handle -ne [IntPtr]::Zero) { [void][PetNative3.WindowApi]::ShowWindow($helper.Handle, 8) }
    } catch { }
})

$script:PositionFile = Join-Path $script:Root ('pet-window-' + $script:Slot + '.json')

# 读宠物当前位置（场景模式是窗口内坐标，普通模式是屏幕坐标）
function Get-PetPos {
    if ($script:SceneMode) { return @{ Left = [double]$script:PetX; Top = [double]$script:PetY } }
    return @{ Left = [double]$script:Window.Left; Top = [double]$script:Window.Top }
}

# 设置宠物位置（场景模式移动 host 的 Margin）
function Set-PetPos([double]$Left, [double]$Top) {
    if ($script:SceneMode) {
        $script:PetX = $Left
        $script:PetY = $Top
        $script:Shell.Margin = New-Object System.Windows.Thickness($Left, $Top, 0, 0)
        return
    }
    $script:Window.Left = $Left
    $script:Window.Top = $Top
}

function Save-Position {
    try {
        $playlist = 'false'
        if ($script:BoardEnabled) { $playlist = 'true' }
        $extra = 0
        if ($script:BoardExtra) { $extra = $script:BoardExtra }
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $json = '{{ "left": {0}, "top": {1}, "scale": {2}, "playlist": {3}, "screenWidth": {4}, "screenHeight": {5} }}' -f [int]($script:Window.Left + $extra), [int]$script:Window.Top, $script:Scale, $playlist, [int]$wa.Right, [int]$wa.Bottom
        # 必须写成无 BOM 的 UTF-8：Node 那边 JSON.parse 会把 BOM 当非法字符
        [System.IO.File]::WriteAllText($script:PositionFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Clamp-ToScreen {
    if ($script:SceneMode) {
        $pos = Get-PetPos
        $maxX = [Math]::Max(0, $script:Window.Width - $script:PetWidth)
        $maxY = [Math]::Max(0, $script:Window.Height - $script:PetBodyHeight)
        $x = [Math]::Max(0, [Math]::Min($maxX, $pos.Left))
        $y = [Math]::Max(0, [Math]::Min($maxY, $pos.Top))
        Set-PetPos $x $y
        return
    }
    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    if ($null -ne $script:SceneBounds) {
        # 场景模式下活动范围就是背景矩形
        $sb = $script:SceneBounds
        $extraB = $script:BoardExtra
        if (-not $extraB) { $extraB = 0 }
        $wB = $script:PetWidth
        if (-not $wB -or $wB -lt 100) { $wB = $script:Window.Width }
        $petLeft = $script:Window.Left + $extraB
        if ($petLeft -lt $sb.left) { $petLeft = $sb.left }
        if ($petLeft -gt ($sb.left + $sb.width - $wB)) { $petLeft = $sb.left + $sb.width - $wB }
        $top = $script:Window.Top
        if ($top -lt $sb.top) { $top = $sb.top }
        if ($top -gt ($sb.top + $sb.height - $script:Window.Height)) { $top = $sb.top + $sb.height - $script:Window.Height }
        $script:Window.Left = $petLeft - $extraB
        $script:Window.Top = $top
        return
    }
    # 只保证宠物本体在屏幕内；歌单板允许挂到屏幕外，这样开关板子时宠物不会乱跑
    $width = $script:PetWidth
    if (-not $width -or $width -lt 100) { $width = $script:Window.Width }
    $height = $script:Window.Height
    $extra = $script:BoardExtra
    if (-not $extra) { $extra = 0 }
    $left = $script:Window.Left + $extra
    $top = $script:Window.Top
    if ($left -lt 0) { $left = 0 }
    if ($top -lt 0) { $top = 0 }
    if ($left -gt $workArea.Right - $width) { $left = $workArea.Right - $width }
    $left = $left - $extra
    if ($top -gt $workArea.Bottom - $height) { $top = $workArea.Bottom - $height }
    $script:Window.Left = $left
    $script:Window.Top = $top
}

function Restore-Position {
    param([switch]$IgnoreSaved)
    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    if ($script:IsSlotB) {
        # 搭子默认站左边，跟主宠物错开
        $script:Window.Left = 60
        $script:Window.Top = $workArea.Bottom - $script:Window.Height - 40
    } else {
        $script:Window.Left = $workArea.Right - $script:Window.Width - 30
        $script:Window.Top = $workArea.Bottom - $script:Window.Height - 40
    }
    if ((-not $IgnoreSaved) -and (Test-Path $script:PositionFile)) {
        try {
            $saved = Get-Content $script:PositionFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($null -ne $saved.left -and $null -ne $saved.top) {
                # 存的是宠物本体的屏幕坐标；窗口 left 由 Apply-Size 按板子宽度算
                $script:BoardExtra = 0
                $script:Window.Left = [int]$saved.left
                $script:Window.Top = [int]$saved.top
            }
            if ($null -ne $saved.scale -and [double]$saved.scale -gt 0.3) { $script:Scale = [double]$saved.scale }
            if ($null -ne $saved.playlist) { $script:BoardEnabled = [bool]$saved.playlist }
        } catch { }
    }
    Clamp-ToScreen
}

# 形象包的图不一定是正方形：按第一帧比例摆，别拉变形
function Update-ImageSize {
    $pixels = [int][Math]::Round($script:FrameSize * $script:Scale)
    $width = $pixels
    $height = $pixels
    if ($script:CurrentState -ne '' -and $script:States.ContainsKey($script:CurrentState)) {
        $data = $script:States[$script:CurrentState]
        if ($null -ne $data -and $data.Frames.Count -gt 0) {
            $frame = $data.Frames[0]
            $w = [double]$frame.PixelWidth
            $h = [double]$frame.PixelHeight
            if ($w -gt 0 -and $h -gt 0 -and [Math]::Abs($w - $h) -gt 1) {
                if ($w -gt $h) { $height = [int][Math]::Round($pixels * $h / $w) }
                else { $width = [int][Math]::Round($pixels * $w / $h) }
            }
        }
    }
    $script:Image.Width = $width
    $script:Image.Height = $height
}

function Apply-Size([double]$NewScale, [switch]$KeepAnchor) {
    $oldWidth = $script:Window.Width
    $oldHeight = $script:Window.Height
    $script:Scale = [Math]::Max(0.4, [Math]::Min(2.0, $NewScale))
    $pixels = [int][Math]::Round($script:FrameSize * $script:Scale)
    Update-ImageSize
    if ($script:BoardEnabled -and $script:BoardVisible) { $script:Board.Visibility = 'Visible' } else { $script:Board.Visibility = 'Collapsed' }
    $prevExtra = 0
    if ($script:BoardExtra) { $prevExtra = $script:BoardExtra }
    $petLeft = $script:Window.Left + $prevExtra
    $boardExtra = 0
    if ($script:BoardEnabled -and $script:BoardVisible) { $boardExtra = $script:BoardWidth + 16 }
    $script:PetWidth = [Math]::Max(300, $pixels + 40)
    $script:PetBodyHeight = $script:BubbleArea + $pixels
    $script:BoardExtra = $boardExtra
    if ($script:SceneMode) {
        # 场景模式：窗口铺满屏幕，宠物本体单独缩放
        $script:Shell.Width = $script:PetWidth
        $script:Shell.Height = $script:PetBodyHeight
        Clamp-ToScreen
        return
    }
    $script:Window.Width = $script:PetWidth + $boardExtra
    $script:Window.Height = $script:PetBodyHeight
    $script:Window.Left = $petLeft - $boardExtra
    if ($KeepAnchor) {
        $script:Window.Left = $script:Window.Left + ($oldWidth - $script:Window.Width)
        $script:Window.Top = $script:Window.Top + ($oldHeight - $script:Window.Height)
    }
    Clamp-ToScreen
}

# ---------------------------------------------------------------- 动画
$script:Player = New-Object System.Windows.Media.MediaPlayer
$script:Timer = New-Object System.Windows.Threading.DispatcherTimer
$script:Poll = New-Object System.Windows.Threading.DispatcherTimer
$script:HideTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:SquashTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PartnerTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PartnerHideTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PartnerWalkTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PartnerPlayer = New-Object System.Windows.Media.MediaPlayer
$script:TopTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:CurrentState = 'walking'
$script:FrameIndex = 0
$script:LastSeq = -1
$script:SquashStep = 0

function Set-PetState([string]$StateName) {
    if (-not $script:States.ContainsKey($StateName)) { $StateName = 'walking' }
    if ($script:CurrentState -eq $StateName -and $script:Timer.IsEnabled) { return }
    if ($script:CurrentState -ne $StateName) { Write-PetLog ('emotion -> ' + $StateName) }
    $script:CurrentState = $StateName
    $script:FrameIndex = 0
    $data = $script:States[$StateName]
    $script:Image.Source = $data.Frames[0]
    Update-ImageSize
    $script:Timer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max($data.Durations[0], 20))
    $script:Timer.Start()
}

function Step-Frame {
    $data = $script:States[$script:CurrentState]
    if ($data.Frames.Count -le 1) { return }
    $script:FrameIndex = ($script:FrameIndex + 1) % $data.Frames.Count
    $script:Image.Source = $data.Frames[$script:FrameIndex]
    $script:Timer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max($data.Durations[$script:FrameIndex], 20))
}

# ------------------------------------------------------ 搭子 B 的画面
function Set-PartnerPos([double]$Left, [double]$Top) {
    $script:PartnerX = $Left
    $script:PartnerY = $Top
    $script:PartnerShell.Margin = New-Object System.Windows.Thickness($Left, $Top, 0, 0)
}

function Set-PartnerEmotion([string]$Name) {
    if (-not $script:States.ContainsKey($Name)) { $Name = 'walking' }
    if ($script:PartnerEmotion -eq $Name -and $null -ne $script:PartnerFrames) { return }
    $script:PartnerEmotion = $Name
    $data = $script:States[$Name]
    $script:PartnerFrames = $data.Frames
    $script:PartnerDurations = $data.Durations
    $script:PartnerIndex = 0
    $script:PartnerImage.Source = $script:PartnerFrames[0]
    $script:PartnerTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max($script:PartnerDurations[0], 20))
    $script:PartnerTimer.Start()
}

function Step-PartnerFrame {
    if ($null -eq $script:PartnerFrames) { return }
    if ($script:PartnerFrames.Count -le 1) { return }
    $script:PartnerIndex = ($script:PartnerIndex + 1) % $script:PartnerFrames.Count
    $script:PartnerImage.Source = $script:PartnerFrames[$script:PartnerIndex]
    $script:PartnerTimer.Interval = [TimeSpan]::FromMilliseconds([Math]::Max($script:PartnerDurations[$script:PartnerIndex], 20))
}

function Show-PartnerBubble([string]$Text, [int]$HoldMs) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $script:PartnerBubbleText.Text = $Text
    $script:PartnerBubble.Visibility = 'Visible'
    $script:PartnerHideTimer.Stop()
    $script:PartnerHideTimer.Interval = [TimeSpan]::FromMilliseconds($HoldMs)
    $script:PartnerHideTimer.Start()
}

function Play-PartnerAudio([string]$Path) {
    if ($script:Silent -or [string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path $Path)) { return }
    try {
        $script:PartnerPlayer.Volume = $script:VoiceVolume
        $script:PartnerPlayer.Open((New-Object System.Uri($Path)))
        $script:PartnerPlayer.Play()
    } catch {
        Write-PetLog ('partner audio failed: ' + $_.Exception.Message)
    }
}

# 在背景范围里随手挑个落脚点，慢慢走过去（朝向跟着翻）
function Partner-PickTarget {
    $maxX = [Math]::Max(0.0, ([double]$script:Window.Width - [double]$script:PartnerWidth))
    $left = [Math]::Max(0.0, $maxX * 0.08)
    $right = [Math]::Max($left + 3.0, $maxX * 0.9)
    if (($right - $left) -gt 3.0) {
        $script:PartnerTargetX = $left + (Get-Random -Minimum 0 -Maximum ([int]($right - $left)))
    } else {
        $script:PartnerTargetX = $left
    }
    $bottom = [Math]::Max(0.0, [double]$script:Window.Height - [double]$script:PartnerHeight - 26)
    Set-PartnerPos $script:PartnerX $bottom
}

function Step-PartnerWalk {
    if (-not $script:PartnerVisible) { return }
    $delta = [double]$script:PartnerTargetX - [double]$script:PartnerX
    if ([Math]::Abs($delta) -lt 2.0) { return }
    $step = 3.0
    if ($delta -lt 0) {
        $step = -$step
        if ($script:PartnerFlipTransform.ScaleX -gt 0) { $script:PartnerFlipTransform.ScaleX = -1 }
    } elseif ($script:PartnerFlipTransform.ScaleX -lt 0) {
        $script:PartnerFlipTransform.ScaleX = 1
    }
    Set-PartnerPos ($script:PartnerX + $step) $script:PartnerY
}

function Hide-Partner {
    if ($script:PartnerVisible) { Write-PetLog 'partner hidden from scene' }
    $script:PartnerVisible = $false
    $script:PartnerSeq = -1
    $script:PartnerEmotion = ''
    $script:PartnerFrames = $null
    $script:PartnerTimer.Stop()
    $script:PartnerHideTimer.Stop()
    $script:PartnerBubble.Visibility = 'Collapsed'
    $script:PartnerShell.Visibility = 'Collapsed'
}

# 每轮 /state 都会调：把 B 的台词、表情、位置画进 A 的背景里
function Update-Partner($state) {
    $p = $null
    if ($null -ne $state -and ($state.PSObject.Properties.Name -contains 'partner')) { $p = $state.partner }
    if ($null -eq $p) { if ($script:PartnerVisible) { Hide-Partner }; return }
    if (-not $script:SceneMode) { if ($script:PartnerVisible) { Hide-Partner }; return }
    $showPartner = $true
    if ($p.PSObject.Properties.Name -contains 'show') { $showPartner = [bool]$p.show }
    if (-not $showPartner) { if ($script:PartnerVisible) { Hide-Partner }; return }

    $name = '搭子'
    if ($p.PSObject.Properties.Name -contains 'name') {
        if (-not [string]::IsNullOrWhiteSpace([string]$p.name)) { $name = [string]$p.name }
    }

    $w = [Math]::Round([double]$script:PetWidth * $script:PartnerScale)
    $h = [Math]::Round([double]$script:PetBodyHeight * $script:PartnerScale)
    if ([Math]::Abs($w - [double]$script:PartnerWidth) -gt 1.0) {
        $script:PartnerWidth = $w
        $script:PartnerShell.Width = $w
        $script:PartnerGrid.RowDefinitions[0].Height = New-Object System.Windows.GridLength([Math]::Round($h * 0.32))
    }
    if ([Math]::Abs($h - [double]$script:PartnerHeight) -gt 1.0) {
        $script:PartnerHeight = $h
        $script:PartnerShell.Height = $h
    }

    if (-not $script:PartnerVisible) {
        $script:PartnerVisible = $true
        $script:PartnerShell.Visibility = 'Visible'
        $script:PartnerName = $name
        $script:PartnerTag.Text = $name
        Set-PartnerPos ([Math]::Max(0.0, [double]$script:Window.Width * 0.08)) ([Math]::Max(0.0, [double]$script:Window.Height - [double]$script:PartnerHeight - 26))
        Partner-PickTarget
        Write-PetLog ('partner in scene -> ' + $name)
    }
    if ($script:PartnerName -ne $name) {
        $script:PartnerName = $name
        $script:PartnerTag.Text = $name
    }

    $emotion = 'walking'
    if ($p.PSObject.Properties.Name -contains 'emotion') { $emotion = [string]$p.emotion }
    if ($script:Emotions -notcontains $emotion) { $emotion = 'walking' }
    if ([string]$p.status -eq 'thinking') { $emotion = 'coding' }
    if ([string]$p.status -eq 'offline') { $emotion = 'crying' }
    Set-PartnerEmotion $emotion

    $seq = [int]$p.seq
    if ($seq -ne $script:PartnerSeq) {
        $script:PartnerSeq = $seq
        $say = ''
        if ($p.PSObject.Properties.Name -contains 'say') { $say = [string]$p.say }
        $duration = 0.0
        if ($p.PSObject.Properties.Name -contains 'audioDuration') { $duration = [double]$p.audioDuration }
        if (-not [string]::IsNullOrWhiteSpace($say)) {
            $hold = [int][Math]::Max(2600, [Math]::Min(14000, ($duration + 3.0) * 1000))
            Show-PartnerBubble $say $hold
            Partner-PickTarget
        }
        if ($p.PSObject.Properties.Name -contains 'audioPath') { Play-PartnerAudio ([string]$p.audioPath) }
    }
}
function Show-Bubble([string]$Text, [int]$HoldMs) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $script:BubbleText.Text = $Text
    $script:Bubble.Visibility = 'Visible'
    $script:HideTimer.Stop()
    $script:HideTimer.Interval = [TimeSpan]::FromMilliseconds($HoldMs)
    $script:HideTimer.Start()
}

# ---------------------------------------------------------------- audio
# Voice volume: WPF MediaPlayer defaults to 0.5 -> set it explicitly.
# Music: MediaPlayer.Open() on http(s) throws here, so each song is downloaded
# to %TEMP%\dsh-live-pet-music first; when it ends we POST /api/song/finished so
# the live service advances its queue (same contract the stage page uses).
$script:VoiceVolume = 1.0
try {
    $vv = [string]$env:PET_VOICE_VOLUME
    if (-not [string]::IsNullOrWhiteSpace($vv)) {
        $parsed = 0.0
        if ([double]::TryParse($vv, [ref]$parsed)) {
            if ($parsed -lt 0) { $parsed = 0.0 }
            if ($parsed -gt 1) { $parsed = 1.0 }
            $script:VoiceVolume = $parsed
        }
    }
} catch { }
Write-PetLog ('voice volume = ' + $script:VoiceVolume)

$script:MusicPlayer = $null
$script:MusicKey = ''
$script:MusicId = 0
$script:MusicVolume = -1.0
$script:MusicClient = $null
$script:MusicTask = $null
$script:MusicTaskKey = ''
$script:MusicTaskPath = ''
$script:MusicFailedKey = ''
$script:MusicEnded = $false
$script:MusicBroken = $false

function Get-LiveBase {
    $base = [string]$env:PET_LIVE_BASE
    if ([string]::IsNullOrWhiteSpace($base)) { $base = 'http://127.0.0.1:8791' }
    return $base.TrimEnd('/')
}

function Get-MusicCachePath([string]$Url) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hash = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Url)))
    $sha.Dispose()
    $dir = Join-Path $env:TEMP 'dsh-live-pet-music'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    return (Join-Path $dir ($hash.Replace('-', '').ToLower() + '.mp3'))
}

function Send-SongEvent([string]$Path, [int]$Id) {
    try {
        $body = '{"id":' + $Id + '}'
        Invoke-RestMethod -Uri ((Get-LiveBase) + $Path) -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 8 | Out-Null
        return $true
    } catch {
        Write-PetLog ('song event failed (' + $Path + '): ' + $_.Exception.Message)
        return $false
    }
}

function Play-MusicFile([string]$Path, [string]$Title, [double]$Vol, [int]$Id) {
    $old = $script:MusicPlayer
    $player = New-Object System.Windows.Media.MediaPlayer
    $script:MusicPlayer = $player
    $script:MusicEnded = $false
    $script:MusicBroken = $false
    $script:MusicId = $Id
    try {
        $player.add_MediaEnded({ $script:MusicEnded = $true })
        $player.add_MediaFailed({ $script:MusicBroken = $true })
    } catch { }
    if ($null -ne $old) { try { $old.Stop(); $old.Close() } catch { } }
    try {
        $player.Open((New-Object System.Uri($Path)))
        $player.Volume = $Vol
        $player.Play()
        $script:MusicVolume = $Vol
        Write-PetLog ('music -> ' + $Title + ' (id ' + $Id + ', vol ' + $Vol + ')')
        return $true
    } catch {
        Write-PetLog ('music play failed: ' + $_.Exception.Message)
        return $false
    }
}

function Stop-Music {
    if ($null -ne $script:MusicPlayer) {
        try { $script:MusicPlayer.Stop(); $script:MusicPlayer.Close() } catch { }
        $script:MusicVolume = -1.0
    }
    if ($script:MusicKey -ne '') { Write-PetLog 'music stopped' }
    $script:MusicKey = ''
    $script:MusicEnded = $false
    $script:MusicBroken = $false
}

function Sync-Music($state) {
    if ($null -eq $state) { return }
    $m = $null
    if (($state.PSObject.Properties.Name -contains 'live') -and ($null -ne $state.live) -and
        ($state.live.PSObject.Properties.Name -contains 'music')) {
        $m = $state.live.music
    }
    if ($null -eq $m) { return }

    if ($script:MusicEnded -or $script:MusicBroken) {
        $why = 'ended'
        if ($script:MusicBroken) { $why = 'failed' }
        $id = [int]$script:MusicId
        $script:MusicEnded = $false
        $script:MusicBroken = $false
        $script:MusicKey = ''
        $script:MusicVolume = -1.0
        Write-PetLog ('music ' + $why + ' -> asking live service for the next song')
        Send-SongEvent '/api/song/finished' $id | Out-Null
        return
    }

    $url = [string]$m.url
    $title = [string]$m.title
    $id = [int]$m.id
    $playing = ($m.playing -eq $true) -and (-not [string]::IsNullOrWhiteSpace($url))
    if ($script:Silent -or (-not $playing)) { Stop-Music; return }

    $vol = 0.55
    if ($null -ne $m.volume) { $vol = [double]$m.volume }
    if ($vol -lt 0) { $vol = 0.0 }
    if ($vol -gt 1) { $vol = 1.0 }

    $key = ([string]$m.id) + '|' + $url
    $local = ''
    if ($url -match '^[a-zA-Z][a-zA-Z0-9+.\-]*:file:') { $local = ([System.Uri]$url).LocalPath }
    elseif ($url -match '^[a-zA-Z][a-zA-Z0-9+.\-]*:') { $local = Get-MusicCachePath $url }
    else {
        $full = (Get-LiveBase) + '/' + $url.TrimStart('/')
        $local = Get-MusicCachePath $full
        $url = $full
        $key = ([string]$m.id) + '|' + $full
    }

    if ($key -eq $script:MusicKey) {
        if ($null -ne $script:MusicPlayer -and [Math]::Abs($vol - $script:MusicVolume) -gt 0.001) {
            try { $script:MusicPlayer.Volume = $vol; $script:MusicVolume = $vol } catch { }
        }
        return
    }
    if ($key -eq $script:MusicFailedKey) { return }

    if ($local -ne '' -and (Test-Path $local) -and ((Get-Item $local).Length -gt 65536)) {
        if (Play-MusicFile $local $title $vol $id) { $script:MusicKey = $key } else { $script:MusicFailedKey = $key }
        return
    }

    if ($script:MusicTaskKey -eq $key -and $null -ne $script:MusicTask) {
        $task = $script:MusicTask
        if (-not $task.IsCompleted) { return }
        $script:MusicTask = $null
        if ($task.IsFaulted -or $task.IsCanceled) {
            Write-PetLog ('music download failed: ' + $title)
            $script:MusicFailedKey = $key
            Send-SongEvent '/api/song/retry' $id | Out-Null
            return
        }
        if (Test-Path $script:MusicTaskPath) {
            if (Play-MusicFile $script:MusicTaskPath $title $vol $id) { $script:MusicKey = $key }
            else { $script:MusicFailedKey = $key; Send-SongEvent '/api/song/retry' $id | Out-Null }
        }
        return
    }

    if ($url -notmatch '^https?:') { return }
    try {
        if ($null -eq $script:MusicClient) { $script:MusicClient = New-Object System.Net.WebClient }
        if (Test-Path $local) { Remove-Item $local -Force -ErrorAction SilentlyContinue }
        $script:MusicTaskKey = $key
        $script:MusicTaskPath = $local
        $script:MusicTask = $script:MusicClient.DownloadFileTaskAsync((New-Object System.Uri($url)), $local)
        Write-PetLog ('music download started: ' + $title + ' (id ' + $id + ')')
    } catch {
        Write-PetLog ('music download start failed: ' + $_.Exception.Message)
        $script:MusicFailedKey = $key
    }
}
function Play-Audio([string]$Path) {
    if ($script:Silent -or [string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path $Path)) { return }
    try {
        $script:Player.Volume = $script:VoiceVolume
        $script:Player.Open((New-Object System.Uri($Path)))
        $script:Player.Play()
    } catch {
        Write-PetLog ('audio failed: ' + $_.Exception.Message)
    }
}

# 触碰反馈：快速挤压再回弹
function Invoke-Squash {
    $script:SquashStep = 0
    $script:SquashTimer.Stop()
    $script:SquashTimer.Start()
}

function Reassert-Topmost {
    # 只做一件事：如果被系统降级了就重新声明 Topmost。
    # （不要在这里做 false/true 抖动，也不要 Win32 SetWindowPos——实测都会把窗口搞没）
    try {
        if ($script:Window.Topmost -ne $true) { $script:Window.Topmost = $true }
    } catch { }
}

function Step-Squash {
    $script:SquashStep++
    if ($script:SquashStep -eq 1) { $script:Squash.ScaleX = 0.9; $script:Squash.ScaleY = 0.9; return }
    if ($script:SquashStep -eq 2) { $script:Squash.ScaleX = 1.06; $script:Squash.ScaleY = 1.06; return }
    $script:SquashTimer.Stop()
    $script:Squash.ScaleX = 1.0
    $script:Squash.ScaleY = 1.0
}

$script:TouchLines = @('别戳啦～', '痒！', '哎哟，摸头了？', '在的在的', '有事说事，别上手', '这一下力气不小啊')

# ------------------------------------------------------------ 动作特效
# 动作 = 情绪（帧序列）+ 时长 + 一点特效，由插件下发 state.pose.fx 或右键菜单触发。
$script:PoseKind = ''
$script:PoseStep = 0
$script:PoseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:PoseTimer.Interval = [TimeSpan]::FromMilliseconds(40)

function Invoke-PoseFx([string]$Kind) {
    $script:Shift.X = 0
    $script:Shift.Y = 0
    switch ($Kind) {
        'squash' { Invoke-Squash; return }
        'firework' { Start-Firework; Invoke-Squash; return }
        'spin' {
            # 转个身：左右翻转一次，到点自己翻回来
            if ($script:Flip.ScaleX -lt 0) { $script:Flip.ScaleX = 1.0 } else { $script:Flip.ScaleX = -1.0 }
            return
        }
        'shake' { $script:PoseKind = 'shake'; $script:PoseStep = 0; $script:PoseTimer.Start(); return }
        'hop' { $script:PoseKind = 'hop'; $script:PoseStep = 0; $script:PoseTimer.Start(); return }
        default { return }
    }
}

function Step-PoseFx {
    $script:PoseStep++
    $step = $script:PoseStep
    if ($script:PoseKind -eq 'hop') {
        # 9 步一个正弦跳：先上后下
        $height = [Math]::Sin([Math]::PI * [Math]::Min(1.0, $step / 9.0)) * 26
        $script:Shift.Y = - $height
        if ($step -ge 9) {
            $script:PoseTimer.Stop()
            $script:Shift.Y = 0
        }
        return
    }
    if ($script:PoseKind -eq 'shake') {
        if ($step % 2 -eq 0) { $script:Shift.X = 8 } else { $script:Shift.X = -8 }
        if ($step -ge 8) {
            $script:PoseTimer.Stop()
            $script:Shift.X = 0
        }
        return
    }
    $script:PoseTimer.Stop()
}
$script:PoseTimer.Add_Tick({ Step-PoseFx })

# ---------------------------------------------------------------- 输入条
function Show-Input {
    $script:Bubble.Visibility = 'Collapsed'
    $script:InputBorder.Visibility = 'Visible'
    $script:Box.Text = ''
    try {
        $script:Box.Focus() | Out-Null
        [System.Windows.Input.Keyboard]::Focus($script:Box) | Out-Null
    } catch { }
}

function Hide-Input {
    $script:InputBorder.Visibility = 'Collapsed'
    $script:Box.Text = ''
}

# 后台发 /see（别卡 WPF 界面），结果由插件推进 state，宠物自己会说
function Send-SeeRequest([string]$JsonBody) {
    $url = $script:HostBase + '/see'
    Start-Job -ArgumentList $url, $JsonBody -ScriptBlock {
        param($url, $jsonBody)
        try {
            $request = [System.Net.HttpWebRequest]::Create($url)
            $request.Method = 'POST'
            $request.ContentType = 'application/json; charset=utf-8'
            $request.Timeout = 60000
            $request.Proxy = $null
            $body = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)
            $request.ContentLength = $body.Length
            $stream = $request.GetRequestStream()
            $stream.Write($body, 0, $body.Length)
            $stream.Close()
            $response = $request.GetResponse()
            $response.Close()
        } catch { }
    } | Out-Null
}

function Look-Desktop {
    Show-Bubble '我看一眼…' 8000
    Write-PetLog 'look desktop requested'
    Send-SeeRequest '{}'
}

function Look-Image {
    $dialog = New-Object Microsoft.Win32.OpenFileDialog
    $dialog.Title = '挑一张图给它看'
    $dialog.Filter = '图片文件|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp|所有文件|*.*'
    $dialog.Multiselect = $false
    if ($dialog.ShowDialog() -ne $true) { return }
    $path = [string]$dialog.FileName
    Show-Bubble '我看看这张…' 8000
    Write-PetLog ('look image: ' + $path)
    Send-SeeRequest ('{"file":' + (ConvertTo-Json $path -Compress) + '}')
}

function Send-Chat([string]$Text) {
    $Text = ($Text -replace '\s+', ' ').Trim()
    if ($Text -eq '') { return }
    Hide-Input
    Show-Bubble ('想：' + $Text) 3000
    $payload = ConvertTo-Json @{ text = $Text } -Compress
    try {
        $request = [System.Net.HttpWebRequest]::Create($script:ChatUrl)
        $request.Method = 'POST'
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Timeout = 8000
        $request.Proxy = $null
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Close()
        $response = $request.GetResponse()
        $response.Close()
        Write-PetLog ('chat sent: ' + $Text)
    } catch {
        Write-PetLog ('chat failed: ' + $_.Exception.Message)
        Show-Bubble '信号不好，没发出去' 3500
    }
}

# ------------------------------------------------- 跟插件要东西（动作 / 背景）
function Send-HostJson([string]$Path, [string]$Method, [string]$Body, [int]$TimeoutMs = 4000) {
    $url = $script:HostBase + $Path
    try {
        $request = [System.Net.HttpWebRequest]::Create($url)
        $request.Method = $Method
        $request.Timeout = $TimeoutMs
        $request.ReadWriteTimeout = $TimeoutMs
        $request.Proxy = $null
        if ($Method -ne 'GET' -and $Body -ne '') {
            $request.ContentType = 'application/json; charset=utf-8'
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
            $request.ContentLength = $bytes.Length
            $stream = $request.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
        }
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Close()
        $response.Close()
        if ($text -eq '') { return $null }
        return $text | ConvertFrom-Json
    } catch {
        Write-PetLog ('host ' + $Path + ' failed: ' + $_.Exception.Message)
        return $null
    }
}

# 动作库：直接从插件拿，设置页里加了自定义动作这里也会跟着变
function Get-Poses {
    $result = Send-HostJson '/poses' 'GET' '' 3000
    if ($null -eq $result -or $result.ok -ne $true) { return @() }
    return @($result.poses)
}

function Invoke-PetPose([string]$Id) {
    if ([string]::IsNullOrWhiteSpace($Id)) { return }
    $result = Send-HostJson ('/pose?id=' + [uri]::EscapeDataString($Id)) 'POST' '' 5000
    if ($null -eq $result -or $result.ok -ne $true) {
        Show-Bubble '这个动作没触发成功' 2500
        return
    }
    Write-PetLog ('pose requested: ' + $Id)
}

# 背景：full = 全屏直播场景；minimal = 背景收起来只留宠物；off = 关掉背景
function Set-BackgroundMode([string]$Mode) {
    $pet = @{}
    switch ($Mode) {
        'full' { $pet['sceneEnabled'] = $true; $pet['sceneMinimized'] = $false }
        'minimal' { $pet['sceneEnabled'] = $true; $pet['sceneMinimized'] = $true }
        'off' { $pet['sceneEnabled'] = $false; $pet['sceneMinimized'] = $false }
        default { return }
    }
    $body = ConvertTo-Json @{ pet = $pet } -Depth 4 -Compress
    $result = Send-HostJson '/config' 'POST' $body 6000
    if ($null -eq $result -or $result.ok -ne $true) {
        Show-Bubble '背景设置没保存成功' 2500
        return
    }
    Write-PetLog ('background mode -> ' + $Mode)
    switch ($Mode) {
        'full' { Show-Bubble '背景回来了' 1600 }
        'minimal' { Show-Bubble '背景先收起来' 1600 }
        'off' { Show-Bubble '背景关掉了' 1600 }
    }
}

# ---------------------------------------------------------------- 状态轮询
function Fetch-State {    try {
        $request = [System.Net.HttpWebRequest]::Create($script:StateUrl)
        $request.Timeout = 1500
        $request.ReadWriteTimeout = 1500
        $request.Proxy = $null
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Close()
        $response.Close()
        return $body | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Set-BoardVisible([bool]$On) {
    # 只控制“允不允许显示”；实际显示与否还取决于有没有在放歌
    $script:BoardEnabled = $On
    if (-not $On) { $script:BoardVisible = $false }
    Apply-Size $script:Scale
    Save-Position
}

function Set-BoardShown([bool]$On) {
    if ($script:BoardVisible -eq $On) { return }
    $script:BoardVisible = $On
    Apply-Size $script:Scale
}

function Format-Clock([int]$Seconds) {
    if ($Seconds -lt 0) { $Seconds = 0 }
    return ('{0}:{1:d2}' -f [int][Math]::Floor($Seconds / 60), ($Seconds % 60))
}

function Update-Board($state) {
    $songs = $null
    if ($null -ne $state -and $null -ne $state.live -and $null -ne $state.live.songs) { $songs = $state.live.songs }
    $playing = $null -ne $songs -and $songs.playing -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$songs.title)
    # 只有真在放歌才显示板子
    Set-BoardShown ($script:BoardEnabled -and $playing)
    if (-not $playing) { return }
    $lines = New-Object System.Collections.Generic.List[string]
    [void]$lines.Add('点歌台')
    if ($songs.playing -and -not [string]::IsNullOrWhiteSpace([string]$songs.title)) {
        $nowTitle = [string]$songs.title
        if ($nowTitle.Length -gt 12) { $nowTitle = $nowTitle.Substring(0, 12) + '…' }
        [void]$lines.Add('正在放：' + $nowTitle)
        if (-not [string]::IsNullOrWhiteSpace([string]$songs.user)) {
            $nowUser = [string]$songs.user
            if ($nowUser.Length -gt 8) { $nowUser = $nowUser.Substring(0, 8) + '…' }
            [void]$lines.Add('点歌：' + $nowUser)
        }
        if ([int]$songs.duration -gt 0) {
            [void]$lines.Add((Format-Clock ([int]$songs.elapsed)) + ' / ' + (Format-Clock ([int]$songs.duration)))
        }
    } else {
        [void]$lines.Add('现在没在放歌')
    }
    [void]$lines.Add('————————')
    $queue = @($songs.queue)
    if ($queue.Count -eq 0) {
        [void]$lines.Add('队列空着')
        [void]$lines.Add('喊「点歌 歌名」就行')
    } else {
        for ($i = 0; $i -lt $queue.Count; $i++) {
            $title = [string]$queue[$i].title
            if ($title.Length -gt 16) { $title = $title.Substring(0, 16) + '…' }
            $line = ('{0}. {1}' -f ($i + 1), $title)
            if (-not [string]::IsNullOrWhiteSpace([string]$queue[$i].user)) { $line += '（' + [string]$queue[$i].user + '）' }
            [void]$lines.Add($line)
        }
        $rest = [int]$songs.len - $queue.Count
        if ($rest -gt 0) { [void]$lines.Add('…还有 ' + $rest + ' 首') }
    }
    $text = [string]::Join("`r`n", $lines)
    if ($script:BoardText.Text -ne $text) { $script:BoardText.Text = $text }
}

# 切换直播场景模式：窗口铺满屏幕 + 显示背景和两块面板
function Set-SceneMode([bool]$On, [string]$ImagePath) {
    if ($On -eq $script:SceneMode) {
        if ($On -and $ImagePath -ne '') { Ensure-SceneImage $ImagePath }
        return
    }
    $script:SceneMode = $On
    if ($On) {
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $script:PetX = [double]([Math]::Max(0, $wa.Width - $script:PetWidth - 240))
        $script:PetY = [double]([Math]::Max(0, $wa.Height - $script:PetBodyHeight - 40))
        $script:Window.WindowState = 'Normal'
        $script:Window.Width = $wa.Width
        $script:Window.Height = $wa.Height
        $script:Window.Left = $wa.Left
        $script:Window.Top = $wa.Top
        Move-WindowRect ([int]$wa.Left) ([int]$wa.Top) ([int]$wa.Width) ([int]$wa.Height)
        if ($script:Scale -lt 1.2) {
            # 整屏背景上按 0.6 倍显示太少了，场景里至少给到 1.35
            $script:ScaleBeforeScene = $script:Scale
            $script:Scale = 1.35
            Apply-Size $script:Scale
        }
        $script:SceneBg.Visibility = 'Visible'
        $script:PoolPanel.Visibility = 'Visible'
        $script:SongPanel.Visibility = 'Visible'
        $script:StatsPanel.Visibility = 'Visible'
        $script:FxLayer.Visibility = 'Visible'
        $script:FxTimer.Interval = [TimeSpan]::FromMilliseconds(33)
        if (-not $script:FxTimer.IsEnabled -and $script:Particles.Count -gt 0) { $script:FxTimer.Start() }
        $script:Shell.HorizontalAlignment = 'Left'
        $script:Shell.VerticalAlignment = 'Top'
        $script:Shell.Width = $script:PetWidth
        $script:Shell.Height = $script:PetBodyHeight
        if ($ImagePath -ne '') { Ensure-SceneImage $ImagePath }
        Set-PetPos $script:PetX $script:PetY
        Write-PetLog 'scene mode on: 背景 + 弹幕池 + 点歌台'
        return
    }
    $script:Window.Width = $script:PetWidth + $script:BoardExtra
    $script:Window.Height = $script:PetBodyHeight
    if ($null -ne $script:ScaleBeforeScene) {
        $script:Scale = $script:ScaleBeforeScene
        $script:ScaleBeforeScene = $null
        Apply-Size $script:Scale
    }
    $script:SceneBg.Visibility = 'Collapsed'
    $script:PoolPanel.Visibility = 'Collapsed'
    $script:SongPanel.Visibility = 'Collapsed'
    $script:StatsPanel.Visibility = 'Collapsed'
    $script:FxLayer.Visibility = 'Collapsed'
    $script:FxTimer.Stop()
    $script:FxLayer.Children.Clear()
    $script:Particles.Clear()
    $script:Shell.HorizontalAlignment = 'Stretch'
    $script:Shell.VerticalAlignment = 'Stretch'
    $script:Shell.Width = [double]::NaN
    $script:Shell.Height = [double]::NaN
    $script:Shell.Margin = New-Object System.Windows.Thickness(0, 0, 0, 0)
    $script:BgLoaded = ''
    Write-PetLog 'scene mode off'
}

# 用 Win32 把窗口硬摆到指定矩形（WPF 的 Left/Top 在透明无边框窗口上偶尔不生效）
function Move-WindowRect([int]$X, [int]$Y, [int]$W, [int]$H) {
    try {
        if (-not $script:Win32Ready) { return }
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
        if ($helper.Handle -eq [IntPtr]::Zero) { return }
        # SWP_NOZORDER=0x0004, SWP_SHOWWINDOW=0x0040
        [void][PetNative3.WindowApi]::SetWindowPos($helper.Handle, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0004 -bor 0x0040)
    } catch {
        Write-PetLog ('move window failed: ' + $_.Exception.Message)
    }
}

$script:BgLoaded = ''
function Ensure-SceneImage([string]$Path) {
    if ($Path -eq $script:BgLoaded) { return }
    try {
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.UriSource = New-Object System.Uri($Path)
        $bitmap.EndInit()
        $bitmap.Freeze()
        $script:SceneBgBrush.ImageSource = $bitmap
        $script:BgLoaded = $Path
        Write-PetLog ('scene background -> ' + $Path)
    } catch {
        Write-PetLog ('scene background failed: ' + $_.Exception.Message)
    }
}

# 刷新左上角弹幕池和右上角点歌台
# 秒 -> mm:ss
function Format-Clock([int]$Seconds) {
    if ($Seconds -lt 0) { $Seconds = 0 }
    $m = [int][Math]::Floor($Seconds / 60)
    $s = $Seconds % 60
    return ('{0:00}:{1:00}' -f $m, $s)
}

# 放一串烟花（粒子）：在宠物头顶炸开
function Start-Firework {
    if (-not $script:SceneMode) { return }
    try {
        $pos = Get-PetPos
        $originX = $pos.Left + ($script:PetWidth / 2)
        $originY = $pos.Top + 60
        $palette = @(
            [System.Windows.Media.Color]::FromArgb(255, 255, 209, 102),
            [System.Windows.Media.Color]::FromArgb(255, 255, 107, 107),
            [System.Windows.Media.Color]::FromArgb(255, 120, 220, 255),
            [System.Windows.Media.Color]::FromArgb(255, 176, 255, 158),
            [System.Windows.Media.Color]::FromArgb(255, 255, 158, 240)
        )
        for ($i = 0; $i -lt 34; $i++) {
            $angle = (Get-Random -Minimum 0 -Maximum 360) * [Math]::PI / 180
            $speed = (Get-Random -Minimum 90 -Maximum 260) / 60.0
            $dot = New-Object System.Windows.Shapes.Ellipse
            $size = Get-Random -Minimum 3 -Maximum 7
            $dot.Width = $size
            $dot.Height = $size
            $dot.Fill = New-Object System.Windows.Media.SolidColorBrush($palette[(Get-Random -Minimum 0 -Maximum $palette.Count)])
            [void]$script:FxLayer.Children.Add($dot)
            [System.Windows.Controls.Canvas]::SetLeft($dot, $originX)
            [System.Windows.Controls.Canvas]::SetTop($dot, $originY)
            [void]$script:Particles.Add(@{
                Shape = $dot
                X = [double]$originX
                Y = [double]$originY
                Vx = [Math]::Cos($angle) * $speed
                Vy = [Math]::Sin($angle) * $speed - 1.2
                Life = 0
                MaxLife = Get-Random -Minimum 26 -Maximum 46
            })
        }
        $script:FxTimer.Start()
        Write-PetLog 'firework!'
    } catch {
        Write-PetLog ('firework failed: ' + $_.Exception.Message)
    }
}

# 粒子物理：每 33ms 走一步，寿命到了就删
function Step-Fx {
    if ($script:Particles.Count -eq 0) { $script:FxTimer.Stop(); return }
    $expired = New-Object System.Collections.ArrayList
    foreach ($p in $script:Particles) {
        $p.Life = $p.Life + 1
        $p.Vy = $p.Vy + 0.16
        $p.Vx = $p.Vx * 0.985
        $p.X = $p.X + $p.Vx
        $p.Y = $p.Y + $p.Vy
        [System.Windows.Controls.Canvas]::SetLeft($p.Shape, $p.X)
        [System.Windows.Controls.Canvas]::SetTop($p.Shape, $p.Y)
        $p.Shape.Opacity = [Math]::Max(0, 1.0 - ($p.Life / $p.MaxLife))
        if ($p.Life -ge $p.MaxLife) { [void]$expired.Add($p) }
    }
    foreach ($p in $expired) {
        [void]$script:FxLayer.Children.Remove($p.Shape)
        [void]$script:Particles.Remove($p)
    }
}

# 弹幕池一行：按类型上色
function Add-PoolRow($item, [int]$ageFromNewest, [int]$total) {
    $kind = [string]$item.kind
    $who = [string]$item.user
    if ([string]::IsNullOrWhiteSpace($who)) { $who = '观众' }
    $text = [string]$item.text
    $row = New-Object System.Windows.Controls.TextBlock
    $row.FontSize = $script:PoolFontSize
    $row.LineHeight = [Math]::Round($script:PoolFontSize * 1.45)
    $row.TextWrapping = [System.Windows.TextWrapping]::Wrap
    $row.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
    # 越旧越淡（最新的 1.0，最旧约 0.42）
    $fade = 1.0 - (($ageFromNewest / [Math]::Max(1, $total)) * 0.58)
    $row.Opacity = [Math]::Max(0.42, $fade)

    $runWho = New-Object System.Windows.Documents.Run
    $runSay = New-Object System.Windows.Documents.Run
    switch ($kind) {
        'gift' {
            $runWho.Text = ('[礼物] ' + $who + ' ')
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 255, 209, 102))
            $runSay.Text = $text
            $runSay.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 255, 230, 163))
        }
        'enter' {
            $runWho.Text = ('[进场] ' + $who)
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 159, 176, 196))
            $runSay.Text = ''
        }
        'me' {
            $runWho.Text = '[我] '
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 157, 255, 208))
            $runSay.Text = $text
            $runSay.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 214, 255, 233))
        }
        'agent-b' {
            # 双智能体里的搭子：换个颜色，一眼看出是谁在说话
            $runWho.Text = ($who + '：')
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 255, 175, 130))
            $runSay.Text = $text
            $runSay.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 255, 226, 208))
        }
        'pose' {
            $runWho.Text = ('[动作] ')
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 202, 178, 255))
            $runSay.Text = ($who + ' ' + $text)
            $runSay.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 231, 224, 255))
        }
        default {
            $runWho.Text = ($who + '：')
            $runWho.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 127, 212, 255))
            $runSay.Text = $text
            $runSay.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(255, 242, 247, 255))
        }
    }
    [void]$row.Inlines.Add($runWho)
    if (-not [string]::IsNullOrWhiteSpace($runSay.Text)) { [void]$row.Inlines.Add($runSay) }
    [void]$script:PoolRows.Children.Add($row)
}

# 刷新左上弹幕池 / 右上点歌台 / 左下场次数据
# 把游戏画面当背景：小海豚窗口的底图就是正在打的这一局
function Update-GameBackdrop($game) {
    if ($script:IsSlotB) { return }
    $active = $false
    if ($null -ne $game -and ($game.PSObject.Properties.Name -contains 'active')) { $active = [bool]$game.active }
    $url = ''
    if ($active -and ($game.PSObject.Properties.Name -contains 'frameUrl')) { $url = [string]$game.frameUrl }
    if ([string]::IsNullOrWhiteSpace($url)) {
        if ($script:GameBgOn) { Stop-GameBackdrop }
        return
    }
    $script:GameBgUrl = $url
    if (-not $script:GameBgOn) {
        $script:GameBgOn = $true
        $script:GameBgFails = 0
        $script:GameBgClient = New-Object System.Net.WebClient
        $script:SceneBg.Visibility = 'Visible'
        $script:GameBgTimer.Start()
        Write-PetLog ('game backdrop on -> ' + $url)
    }
}

function Stop-GameBackdrop {
    $script:GameBgOn = $false
    $script:GameBgTimer.Stop()
    $script:SceneBgBrush.ImageSource = $null
    $script:BgLoaded = ''
    if (-not $script:SceneMode) { $script:SceneBg.Visibility = 'Collapsed' }
    if ($null -ne $script:GameBgClient) { try { $script:GameBgClient.Dispose() } catch { } }
    $script:GameBgClient = $null
    Write-PetLog 'game backdrop off'
}

function Update-GameFrame {
    if (-not $script:GameBgOn) { return }
    if ([string]::IsNullOrWhiteSpace($script:GameBgUrl)) { return }
    $w = [int]$script:Window.Width
    $h = [int]$script:Window.Height
    if ($w -lt 60 -or $h -lt 60) { return }
    if ($w -gt 1280) {
        $h = [int][Math]::Round($h * 1280.0 / $w)
        $w = 1280
    }
    $url = $script:GameBgUrl + '?w=' + $w + '&h=' + $h + '&bias=0.55'
    try {
        $bytes = $script:GameBgClient.DownloadData($url)
        if ($null -eq $bytes -or $bytes.Length -lt 512) { throw '空帧' }
        $stream = New-Object System.IO.MemoryStream(, $bytes)
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.StreamSource = $stream
        $bitmap.EndInit()
        $bitmap.Freeze()
        $script:SceneBgBrush.ImageSource = $bitmap
        $stream.Dispose()
        $script:GameBgFails = 0
    } catch {
        $script:GameBgFails = $script:GameBgFails + 1
        if ($script:GameBgFails -eq 3) { Write-PetLog ('game backdrop frame failed: ' + $_.Exception.Message) }
        if ($script:GameBgFails -gt 25) { Stop-GameBackdrop }
    }
}

function Update-ScenePanels($state) {
    if (-not $script:SceneMode) { return }

    # ---- 弹幕池 ----
    $items = @()
    if ($state.PSObject.Properties.Name -contains 'pool') { $items = @($state.pool) }
    $tail = @()
    if ($items.Count -gt 11) { $tail = $items[($items.Count - 11)..($items.Count - 1)] } else { $tail = $items }
    $sig = (($tail | ForEach-Object { "$($_.kind)|$($_.user)|$($_.text)" }) -join '~')
    if ($sig -ne $script:PoolSignature) {
        $script:PoolSignature = $sig
        $script:PoolRows.Children.Clear()
        if ($tail.Count -eq 0) {
            $empty = New-Object System.Windows.Controls.TextBlock
            $empty.Text = '还没人说话…'
            $empty.FontSize = $script:PoolFontSize
            $empty.Foreground = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(150, 234, 242, 255))
            [void]$script:PoolRows.Children.Add($empty)
        } else {
            for ($i = 0; $i -lt $tail.Count; $i++) {
                Add-PoolRow $tail[$i] ($tail.Count - 1 - $i) $tail.Count
            }
        }
    }
    # 有新的礼物就放烟花
    foreach ($item in $tail) {
        if ([string]$item.kind -eq 'gift') {
            $at = [double]$item.at
            if ($at -gt $script:LastGiftFxAt) {
                $script:LastGiftFxAt = $at
                Start-Firework
            }
        }
    }

    # ---- 点歌台 ----
    $songs = $null
    if ($null -ne $state.live -and $null -ne $state.live.songs) { $songs = $state.live.songs }
    elseif ($state.PSObject.Properties.Name -contains 'songs') { $songs = $state.songs }
    $lines = New-Object System.Collections.Generic.List[string]
    $playing = $null -ne $songs -and $songs.playing -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$songs.title)
    $elapsed = 0
    $duration = 0
    if ($playing) {
        $title = [string]$songs.title
        if ($title.Length -gt 22) { $title = $title.Substring(0, 22) + '…' }
        [void]$lines.Add($title)
        $artist = [string]$songs.artist
        if ([string]::IsNullOrWhiteSpace($artist)) { $artist = [string]$songs.user }
        if (-not [string]::IsNullOrWhiteSpace($artist)) { [void]$lines.Add(('— ' + $artist)) }
        $elapsed = [int]$songs.elapsed
        $duration = [int]$songs.duration
    } else {
        [void]$lines.Add('喊首歌名，我就点上')
    }
    if ($null -ne $songs -and $null -ne $songs.queue) {
        $queue = @($songs.queue)
        if ($queue.Count -gt 0) {
            [void]$lines.Add('')
            [void]$lines.Add('排队中：')
            $max = [Math]::Min(4, $queue.Count)
            for ($i = 0; $i -lt $max; $i++) {
                $qTitle = [string]$queue[$i].title
                if ($qTitle.Length -gt 14) { $qTitle = $qTitle.Substring(0, 14) + '…' }
                [void]$lines.Add(('{0}. {1}' -f ($i + 1), $qTitle))
            }
        }
    }
    $songText = [string]::Join([Environment]::NewLine, $lines)
    if ($script:SongText.Text -ne $songText) { $script:SongText.Text = $songText }

    # 进度条
    $trackWidth = 320.0
    if ($duration -gt 0) {
        $ratio = [Math]::Max(0.0, [Math]::Min(1.0, $elapsed / [double]$duration))
        $script:SongFill.Width = [Math]::Round($trackWidth * $ratio)
        $script:SongClock.Text = ((Format-Clock $elapsed) + ' / ' + (Format-Clock $duration))
    } else {
        $script:SongFill.Width = 0
        $script:SongClock.Text = ''
    }

    # ---- 本场数据 ----
    $statsLines = New-Object System.Collections.Generic.List[string]
    [void]$statsLines.Add('本场数据')
    $live = $state.live
    if ($null -ne $live) {
        $startedRaw = $null
        if ($null -ne $live.started_at) { $startedRaw = $live.started_at }
        $uptimeLine = ''
        try {
            $startDt = [datetime]::MinValue
            if ($startedRaw -is [string]) {
                if ([string]$startedRaw -ne '') { $startDt = [datetime]::Parse([string]$startedRaw) }
            } elseif ($null -ne $startedRaw) {
                $num = [double]$startedRaw
                if ($num -gt 100000000000) { $startDt = [datetime]::FromFileTime([int64]$num) }
                elseif ($num -gt 0) { $startDt = (Get-Date '1970-01-01').ToLocalTime().AddSeconds($num) }
            }
            if ($startDt -ne [datetime]::MinValue) {
                $span = (Get-Date) - $startDt
                if ($span.TotalSeconds -gt 0 -and $span.TotalDays -lt 2) {
                    $uptimeLine = ('开播  ' + [int][Math]::Floor($span.TotalMinutes) + ' 分钟')
                }
            }
        } catch { $uptimeLine = '' }
        if ($uptimeLine -ne '') { [void]$statsLines.Add($uptimeLine) }
        $requests = 0
        if ($null -ne $live.requests) { $requests = [int]$live.requests }
        $giftCount = 0
        if ($null -ne $live.gifts) { $giftCount = [int]$live.gifts }
        $giftValue = 0.0
        if ($null -ne $live.gift_value) { $giftValue = [double]$live.gift_value }
        $queueLen = 0
        if ($null -ne $songs -and $null -ne $songs.len) { $queueLen = [int]$songs.len }
        [void]$statsLines.Add(('弹幕回复  ' + $requests))
        [void]$statsLines.Add(('收到礼物  ' + $giftCount + ' 个 / ' + [Math]::Round($giftValue, 1) + ' 元'))
        [void]$statsLines.Add(('排队歌曲  ' + $queueLen + ' 首'))
    }
    # token 用量（插件累计、重启不清零）：直播画面上也看得到花了多少
    if ($state.PSObject.Properties.Name -contains 'usage' -and $null -ne $state.usage) {
        $u = $state.usage
        $totalTok = [int64]0
        if ($null -ne $u.total) { $totalTok = [int64]$u.total }
        $turnsUse = 0
        if ($null -ne $u.turns) { $turnsUse = [int]$u.turns }
        [void]$statsLines.Add('token  ' + $totalTok.ToString('N0') + ' / ' + $turnsUse + ' 轮')
        $usageKey = [string]$totalTok + '/' + $turnsUse
        if ($script:LastUsageLine -ne $usageKey) {
            $script:LastUsageLine = $usageKey
            Write-PetLog ('scene token -> ' + $totalTok.ToString('N0') + ' / ' + $turnsUse + ' 轮')
        }
        $perMin = 0
        if ($null -ne $u.perMinute) { $perMin = [int]$u.perMinute }
        if ($perMin -gt 0) { [void]$statsLines.Add('每分钟  ' + $perMin.ToString('N0')) }
    }
    $statsText = [string]::Join([Environment]::NewLine, $statsLines)
    if ($script:StatsText.Text -ne $statsText) { $script:StatsText.Text = $statsText }
}


# --------------------------------------------------------------- 掌机游戏机
# 黑白 LCD 掌机：小海豚打红白机老游戏的"演出"。画面（一格格像素）由插件算好
# 推过来，这里只负责把它画在一块 Game Boy 味的壳子里。
$script:GameWin = $null
$script:GameCells = @{}
$script:GameFrameKey = ''
$script:GameCanvas = $null
$script:GameCellPx = 10
$script:GameCols = 18
$script:GameRows = 10

function Get-GameBrush([string]$Hex) {
    return (New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($Hex)))
}

function Set-GameGrid([int]$cols, [int]$rows, [int]$cellPx) {
    if ($cols -lt 4) { $cols = 18 }
    if ($rows -lt 4) { $rows = 10 }
    if ($cellPx -lt 2) { $cellPx = 6 }
    if ($null -eq $script:GameCanvas) { return }
    if ($cols -eq $script:GameCols -and $rows -eq $script:GameRows -and $cellPx -eq $script:GameCellPx -and $script:GameCells.Count -gt 0) { return }
    $script:GameCols = $cols
    $script:GameRows = $rows
    $script:GameCellPx = $cellPx
    $canvas = $script:GameCanvas
    $canvas.Children.Clear()
    $script:GameCells = @{}
    $canvas.Width = ($cols * $cellPx)
    $canvas.Height = ($rows * $cellPx)
    $paper = Get-GameBrush '#E7E9D6'
    for ($y = 0; $y -lt $rows; $y++) {
        for ($x = 0; $x -lt $cols; $x++) {
            $rect = New-Object System.Windows.Shapes.Rectangle
            $rect.Width = [Math]::Max(1, ($cellPx - 1))
            $rect.Height = [Math]::Max(1, ($cellPx - 1))
            $rect.Fill = $paper
            [System.Windows.Controls.Canvas]::SetLeft($rect, ($x * $cellPx))
            [System.Windows.Controls.Canvas]::SetTop($rect, ($y * $cellPx))
            [void]$canvas.Children.Add($rect)
            $script:GameCells["$x,$y"] = $rect
        }
    }
    $script:GameFrameKey = ''
    Write-PetLog ('game grid -> ' + $cols + 'x' + $rows + ' @' + $cellPx + 'px')
}

function New-GameConsole {
    if ($null -ne $script:GameWin) { return }
    try {
        $win = New-Object System.Windows.Window
        $win.WindowStyle = [System.Windows.WindowStyle]::None
        $win.AllowsTransparency = $true
        $win.Background = [System.Windows.Media.Brushes]::Transparent
        $win.Topmost = $true
        $win.ShowInTaskbar = $false
        $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
        $win.Width = 320
        $win.Height = 430

        $shell = New-Object System.Windows.Controls.Border
        $shell.CornerRadius = (New-Object System.Windows.CornerRadius 26)
        $shell.Background = (Get-GameBrush '#D9D9CF')
        $shell.BorderBrush = (Get-GameBrush '#A6A69C')
        $shell.BorderThickness = (New-Object System.Windows.Thickness 3)
        $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
        $shadow.BlurRadius = 20
        $shadow.ShadowDepth = 5
        $shadow.Opacity = 0.42
        $shell.Effect = $shadow
        $win.Content = $shell
        $win.Add_MouseLeftButtonDown({ try { $script:GameWin.DragMove() } catch { } })

        $stack = New-Object System.Windows.Controls.StackPanel
        $stack.Margin = (New-Object System.Windows.Thickness 14, 12, 14, 8)
        $shell.Child = $stack

        # ---- 屏幕外框 ----
        $bezel = New-Object System.Windows.Controls.Border
        $bezel.Background = (Get-GameBrush '#77776E')
        $bezel.CornerRadius = (New-Object System.Windows.CornerRadius 12)
        $bezel.Padding = (New-Object System.Windows.Thickness 10, 9, 10, 9)
        [void]$stack.Children.Add($bezel)

        $inner = New-Object System.Windows.Controls.StackPanel
        $bezel.Child = $inner

        $mark = New-Object System.Windows.Controls.TextBlock
        $mark.Text = 'DOLPHIN BOY  ·  DOT MATRIX WITH STEREO SOUND'
        $mark.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas')
        $mark.FontSize = 7
        $mark.Foreground = (Get-GameBrush '#C9C9BE')
        $mark.Margin = (New-Object System.Windows.Thickness 2, 0, 0, 4)
        [void]$inner.Children.Add($mark)

        $lcd = New-Object System.Windows.Controls.Border
        $lcd.Background = (Get-GameBrush '#E7E9D6')
        $lcd.CornerRadius = (New-Object System.Windows.CornerRadius 4)
        $lcd.Padding = (New-Object System.Windows.Thickness 7, 5, 7, 6)
        [void]$inner.Children.Add($lcd)

        $lcdStack = New-Object System.Windows.Controls.StackPanel
        $lcd.Child = $lcdStack

        $script:GameTitle = New-Object System.Windows.Controls.TextBlock
        $script:GameTitle.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas, Microsoft YaHei UI')
        $script:GameTitle.FontSize = 11
        $script:GameTitle.FontWeight = [System.Windows.FontWeights]::Bold
        $script:GameTitle.Foreground = (Get-GameBrush '#2B2B26')
        $script:GameTitle.Text = '- INSERT CART -'
        [void]$lcdStack.Children.Add($script:GameTitle)

        $script:GameHud = New-Object System.Windows.Controls.TextBlock
        $script:GameHud.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas, Microsoft YaHei UI')
        $script:GameHud.FontSize = 10
        $script:GameHud.Foreground = (Get-GameBrush '#3A3A33')
        $script:GameHud.Text = ''
        [void]$lcdStack.Children.Add($script:GameHud)

        $canvas = New-Object System.Windows.Controls.Canvas
        $canvas.Background = (Get-GameBrush '#E7E9D6')
        $canvas.Margin = (New-Object System.Windows.Thickness 0, 3, 0, 3)
        [void]$lcdStack.Children.Add($canvas)
        $script:GameCanvas = $canvas
        $script:GameCells = @{}
        $script:GameCols = 0
        $script:GameRows = 0
        Set-GameGrid 40 26 4

        $script:GameBoss = New-Object System.Windows.Controls.TextBlock
        $script:GameBoss.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas, Microsoft YaHei UI')
        $script:GameBoss.FontSize = 9
        $script:GameBoss.Foreground = (Get-GameBrush '#3A3A33')
        $script:GameBoss.Text = ''
        [void]$lcdStack.Children.Add($script:GameBoss)

        # ---- 品牌字 ----
        $brand = New-Object System.Windows.Controls.TextBlock
        $brand.Text = 'DOLPHIN BOY'
        $brand.FontFamily = (New-Object System.Windows.Media.FontFamily 'Microsoft YaHei UI')
        $brand.FontSize = 15
        $brand.FontStyle = [System.Windows.FontStyles]::Italic
        $brand.FontWeight = [System.Windows.FontWeights]::Bold
        $brand.Foreground = (Get-GameBrush '#62625A')
        $brand.HorizontalAlignment = 'Center'
        $brand.Margin = (New-Object System.Windows.Thickness 0, 7, 0, 2)
        [void]$stack.Children.Add($brand)

        $brandSub = New-Object System.Windows.Controls.TextBlock
        $brandSub.Text = '8-BIT HANDHELD'
        $brandSub.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas')
        $brandSub.FontSize = 7
        $brandSub.Foreground = (Get-GameBrush '#8A8A80')
        $brandSub.HorizontalAlignment = 'Center'
        $brandSub.Margin = (New-Object System.Windows.Thickness 0, 0, 0, 4)
        [void]$stack.Children.Add($brandSub)

        # ---- 按键区：十字键 + AB + START/SELECT ----
        $pad = New-Object System.Windows.Controls.Canvas
        $pad.Width = 284
        $pad.Height = 96
        $pad.HorizontalAlignment = 'Center'
        [void]$stack.Children.Add($pad)

        $dark = Get-GameBrush '#55554D'
        $vbar = New-Object System.Windows.Shapes.Rectangle
        $vbar.Width = 26
        $vbar.Height = 76
        $vbar.RadiusX = 4
        $vbar.RadiusY = 4
        $vbar.Fill = $dark
        [System.Windows.Controls.Canvas]::SetLeft($vbar, 34)
        [System.Windows.Controls.Canvas]::SetTop($vbar, 10)
        [void]$pad.Children.Add($vbar)

        $hbar = New-Object System.Windows.Shapes.Rectangle
        $hbar.Width = 76
        $hbar.Height = 26
        $hbar.RadiusX = 4
        $hbar.RadiusY = 4
        $hbar.Fill = $dark
        [System.Windows.Controls.Canvas]::SetLeft($hbar, 9)
        [System.Windows.Controls.Canvas]::SetTop($hbar, 35)
        [void]$pad.Children.Add($hbar)

        $btnA = New-Object System.Windows.Shapes.Ellipse
        $btnA.Width = 34
        $btnA.Height = 34
        $btnA.Fill = (Get-GameBrush '#9E4148')
        [System.Windows.Controls.Canvas]::SetLeft($btnA, 222)
        [System.Windows.Controls.Canvas]::SetTop($btnA, 30)
        [void]$pad.Children.Add($btnA)

        $btnB = New-Object System.Windows.Shapes.Ellipse
        $btnB.Width = 34
        $btnB.Height = 34
        $btnB.Fill = (Get-GameBrush '#9E4148')
        [System.Windows.Controls.Canvas]::SetLeft($btnB, 186)
        [System.Windows.Controls.Canvas]::SetTop($btnB, 44)
        [void]$pad.Children.Add($btnB)

        foreach ($pair in @(@('A', 231, 36), @('B', 195, 50))) {
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = $pair[0]
            $t.FontFamily = (New-Object System.Windows.Media.FontFamily 'Consolas')
            $t.FontSize = 12
            $t.FontWeight = [System.Windows.FontWeights]::Bold
            $t.Foreground = (Get-GameBrush '#E8D6D8')
            [System.Windows.Controls.Canvas]::SetLeft($t, $pair[1])
            [System.Windows.Controls.Canvas]::SetTop($t, $pair[2])
            [void]$pad.Children.Add($t)
        }

        for ($i = 0; $i -lt 6; $i++) {
            $dot = New-Object System.Windows.Shapes.Ellipse
            $dot.Width = 3
            $dot.Height = 3
            $dot.Fill = (Get-GameBrush '#8A8A80')
            [System.Windows.Controls.Canvas]::SetLeft($dot, (120 + ($i * 6)))
            [System.Windows.Controls.Canvas]::SetTop($dot, 78)
            [void]$pad.Children.Add($dot)
        }

        $script:GameHint = New-Object System.Windows.Controls.TextBlock
        $script:GameHint.Text = 'GAME OVER 后自己关掉'
        $script:GameHint.FontFamily = (New-Object System.Windows.Media.FontFamily 'Microsoft YaHei UI')
        $script:GameHint.FontSize = 8
        $script:GameHint.Foreground = (Get-GameBrush '#8A8A80')
        $script:GameHint.HorizontalAlignment = 'Center'
        [void]$stack.Children.Add($script:GameHint)

        $wa = [System.Windows.SystemParameters]::WorkArea
        $win.Left = $wa.Right - $win.Width - 30
        $win.Top = $wa.Bottom - $win.Height - 40

        $script:GameWin = $win
        Write-PetLog 'game console window created'
    } catch {
        Write-PetLog ('game console failed: ' + $_.Exception.Message)
        $script:GameWin = $null
    }
}

function Update-GameConsole($game) {
    if ($script:IsSlotB) { return }
    if ($null -eq $game) { return }
    # 现在演的是游戏本体窗口（真画面），宠物窗口里不再弹黑白掌机
    if (-not $script:ShowGameConsole) {
        if ($null -ne $script:GameWin -and $script:GameWin.IsVisible) {
            $script:GameWin.Hide()
            Write-PetLog 'game console hidden'
        }
        return
    }
    if (-not ($game.PSObject.Properties.Name -contains 'active')) { return }
    if (-not [bool]$game.active) {
        if ($null -ne $script:GameWin -and $script:GameWin.IsVisible) {
            $script:GameWin.Hide()
            Write-PetLog 'game console hidden'
        }
        return
    }
    New-GameConsole
    if ($null -eq $script:GameWin) { return }

    $title = [string]$game.title
    if (-not [string]::IsNullOrWhiteSpace([string]$game.stageName)) {
        $title = $title + '  ·  ' + [string]$game.stageName
    }
    if ($script:GameTitle.Text -ne $title) { $script:GameTitle.Text = $title }
    $hud = [string]$game.hud
    if ($script:GameHud.Text -ne $hud) { $script:GameHud.Text = $hud }

    $bossText = ''
    if ([int]$game.bossHp -gt 0) {
        $bossText = [string]$game.boss + '  ' + ([string]$game.bossBar)
    } else {
        $bossText = 'BOSS 已击破 → 下一关'
    }
    if ($script:GameBoss.Text -ne $bossText) { $script:GameBoss.Text = $bossText }

    # 画面尺寸（植物大战僵尸给的是 40x26 的 4px 点；换游戏会自动重建格子）
    $cols = 40
    $rows = 26
    $cellPx = 4
    if ($game.PSObject.Properties.Name -contains 'cols') { $cols = [int]$game.cols }
    if ($game.PSObject.Properties.Name -contains 'rows') { $rows = [int]$game.rows }
    if ($game.PSObject.Properties.Name -contains 'cell') { $cellPx = [int]$game.cell }
    Set-GameGrid $cols $rows $cellPx

    $frame = $game.frame
    $key = ''
    if ($null -ne $frame) { $key = [string]($frame -join '|') }
    if ($key -ne $script:GameFrameKey) {
        $script:GameFrameKey = $key
        $on = Get-GameBrush '#2B2B26'
        $off = Get-GameBrush '#E7E9D6'
        for ($y = 0; $y -lt $script:GameRows; $y++) {
            $row = ''
            if ($null -ne $frame -and $frame.Count -gt $y) { $row = [string]$frame[$y] }
            for ($x = 0; $x -lt $script:GameCols; $x++) {
                $ch = '.'
                if ($row.Length -gt $x) { $ch = $row.Substring($x, 1) }
                $cell = $script:GameCells["$x,$y"]
                if ($null -eq $cell) { continue }
                if ($ch -eq '.') { $cell.Fill = $off } else { $cell.Fill = $on }
            }
        }
    }

    if (-not $script:GameWin.IsVisible) {
        $script:GameWin.Show()
        Write-PetLog ('game console shown: ' + $title)
    }
}

function Start-DolphinGame {
    $url = $script:HostBase + '/game'
    Start-Job -ArgumentList $url -ScriptBlock {
        param($url)
        try {
            $request = [System.Net.HttpWebRequest]::Create($url)
            $request.Method = 'POST'
            $request.ContentType = 'application/json; charset=utf-8'
            $request.Timeout = 20000
            $request.Proxy = $null
            $body = [System.Text.Encoding]::UTF8.GetBytes('{"action":"start","by":"老板"}')
            $request.ContentLength = $body.Length
            $stream = $request.GetRequestStream()
            $stream.Write($body, 0, $body.Length)
            $stream.Close()
            $response = $request.GetResponse()
            $response.Close()
        } catch { }
    } | Out-Null
    Show-Bubble '小海豚开游戏机了…' 6000
}

function Apply-State($state) {
    if (-not $script:IsSlotB) {
        Update-Board
        Sync-Music $state
    }
    if ($null -eq $state) {
        Set-PetState 'crying'
        return
    }
    # 掌机游戏：有局面就画出来（画面变了才重绘）
    if ($state.PSObject.Properties.Name -contains 'game') {
        Update-GameConsole $state.game
        Update-GameBackdrop $state.game
    }
    # 溜达配置由插件下发（每轮都读一次，改了设置立刻生效，不用重启窗口）
    if ($state.PSObject.Properties.Name -contains 'wander') {
        $w = $state.wander
        $wasEnabled = $script:WanderEnabled
        $script:WanderEnabled = [bool]$w.enabled
        if ($null -ne $w.speed) { $script:WanderSpeed = [double]$w.speed }
        if ($null -ne $w.dwellMinSec) { $script:WanderDwellMinMs = [int]([double]$w.dwellMinSec * 1000) }
        if ($null -ne $w.dwellMaxSec) { $script:WanderDwellMaxMs = [int]([double]$w.dwellMaxSec * 1000) }
        if ($script:WanderEnabled -and -not $wasEnabled) {
            Write-PetLog 'wander enabled'
            Wander-ScheduleNext
        } elseif ((-not $script:WanderEnabled) -and $wasEnabled) {
            Write-PetLog 'wander disabled'
            Wander-Stop
            Clear-LocalEmotion
        }
    }

    # 直播场景：开关、背景图、字号（每轮都读，改设置立刻生效）
    # B 是搭子，不画全屏背景也不放弹幕池，只当一只会说话的宠物
    if ($script:IsSlotB) { Set-SceneMode $false '' }
    if ((-not $script:IsSlotB) -and ($state.PSObject.Properties.Name -contains 'scene')) {
        $sc = $state.scene
        # display: full = 全屏背景；minimal = 背景收起来只留宠物；off = 没开背景
        $display = ''
        if ($sc.PSObject.Properties.Name -contains 'display') { $display = [string]$sc.display }
        if ([string]::IsNullOrWhiteSpace($display)) {
            if ([bool]$sc.enabled) { $display = 'full' } else { $display = 'off' }
        }
        if ($display -ne $script:SceneDisplay) {
            Write-PetLog ('scene display -> ' + $display)
            $script:SceneDisplay = $display
        }
        Set-SceneMode ($display -eq 'full') ([string]$sc.imagePath)
        $poolFont = [double]$sc.poolFontSize
        if ($poolFont -ge 10 -and $poolFont -le 60 -and [Math]::Abs($poolFont - $script:PoolFontSize) -gt 0.1) {
            $script:PoolFontSize = $poolFont
            $script:PoolTitle.FontSize = $poolFont
            $script:PoolSignature = ''
            $script:SongText.FontSize = [Math]::Max(12, $poolFont - 2)
            $script:SongText.LineHeight = [Math]::Round([Math]::Max(12, $poolFont - 2) * 1.5)
            $script:StatsText.FontSize = [Math]::Max(12, $poolFont - 4)
            $script:StatsText.LineHeight = [Math]::Round([Math]::Max(12, $poolFont - 4) * 1.5)
        }
        $fontSize = [double]$sc.bubbleFontSize
        if ($fontSize -ge 10 -and $fontSize -le 60 -and [Math]::Abs($fontSize - $script:BubbleFontSize) -gt 0.1) {
            $script:BubbleFontSize = $fontSize
            $script:BubbleText.FontSize = $fontSize
            $script:BubbleText.LineHeight = [Math]::Round($fontSize * 1.5)
            $script:Bubble.MaxWidth = [Math]::Round($fontSize * 16)
            Write-PetLog ('bubble font -> ' + $fontSize)
        }
    }
    if (-not $script:IsSlotB) { Update-ScenePanels $state }
    if (-not $script:IsSlotB) { Update-Partner $state }

    $emotion = [string]$state.emotion
    if ($script:Emotions -notcontains $emotion) { $emotion = 'walking' }
    if ([string]$state.status -eq 'thinking') { $emotion = 'coding' }
    if ([string]$state.status -eq 'offline') { $emotion = 'crying' }

    $seq = [int]$state.seq
    if ($seq -eq $script:LastSeq) {
        # 没有新事件：溜达/停留的姿势优先，画面别乱跳
        if ($script:WanderMoving) {
            Set-PetState 'walking'
        } elseif ($script:LocalEmotion -ne '' -and (Get-Date) -lt $script:LocalEmotionUntil) {
            Set-PetState $script:LocalEmotion
        }
        return
    }
    $script:LastSeq = $seq

    # 有新事件（弹幕/礼物/进场/老板说话）：情绪的优先级最高。
    # 正在溜达就先停下，把表情露出来，别让走路动画把哭/笑盖掉。
    if ($script:WanderMoving) { Wander-Stop }
    $script:EmotionHoldUntil = (Get-Date).AddMilliseconds(9000)
    Clear-LocalEmotion
    Set-PetState $emotion

    $say = [string]$state.say
    $duration = [double]$state.audioDuration
    if (-not [string]::IsNullOrWhiteSpace($say)) {
        # 双智能体连麦时，气泡前面带上是「谁」说的
        $who = ''
        if ($state.PSObject.Properties.Name -contains 'speaker') { $who = [string]$state.speaker }
        $me = ''
        if ($state.PSObject.Properties.Name -contains 'config' -and $null -ne $state.config) {
            if ($state.config.PSObject.Properties.Name -contains 'petName') { $me = [string]$state.config.petName }
        }
        if ($who -ne '' -and $me -ne '' -and $who -ne $me) { $say = $who + '：' + $say }
        $hold = [int][Math]::Max(3000, [Math]::Min(15000, ($duration + 3.0) * 1000))
        Show-Bubble $say $hold
    }
    if ($state.PSObject.Properties.Name -contains 'audioPath') {
        Play-Audio ([string]$state.audioPath)
    }

    # 主动动作（右键菜单 / 设置页 / 插件触发）：情绪已经由 emotion 带上，这里补特效
    if ($state.PSObject.Properties.Name -contains 'pose' -and $null -ne $state.pose) {
        $poseFx = 'none'
        if ($state.pose.PSObject.Properties.Name -contains 'fx') { $poseFx = [string]$state.pose.fx }
        if (-not [string]::IsNullOrWhiteSpace($poseFx) -and $poseFx -ne 'none') { Invoke-PoseFx $poseFx }
        $poseLabel = ''
        if ($state.pose.PSObject.Properties.Name -contains 'label') { $poseLabel = [string]$state.pose.label }
        if (-not [string]::IsNullOrWhiteSpace($poseLabel) -and [string]::IsNullOrWhiteSpace($say)) {
            Show-Bubble $poseLabel 2200
        }
        Write-PetLog ('pose -> ' + $poseFx)
    }
}

# ---------------------------------------------------------------- 自动溜达
# 自己在桌面各处走动：随机挑目标 → 走过去 → 停一会儿 → 再挑下一个。
# 用户一碰（点/拖/输入条）就暂停，别跟人抢窗口。
$script:WanderEnabled = $true
$script:WanderSpeed = 55.0
$script:WanderDwellMinMs = 6000
$script:WanderDwellMaxMs = 18000
$script:WanderTargetX = 0.0
$script:WanderTargetY = 0.0
$script:WanderMoving = $false
$script:WanderPausedUntil = [DateTime]::MinValue
$script:WanderLastTick = $null
$script:WanderIdleEmotion = 'happy'
$script:LocalEmotion = ''
$script:LocalEmotionUntil = [DateTime]::MinValue

# 直播背景模式：宠物只能在这块矩形里活动（屏幕坐标），空 = 不受限
$script:SceneBounds = $null
$script:BubbleFontSize = 13
# 情绪保护期：刚哭/刚笑的时候别让溜达把它顶掉
$script:EmotionHoldUntil = [DateTime]::MinValue

$script:WanderTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:WanderDwellTimer = New-Object System.Windows.Threading.DispatcherTimer

function Wander-IsPaused {
    if (-not $script:WanderEnabled) { return $true }
    if ((Get-Date) -lt $script:WanderPausedUntil) { return $true }
    if ($script:InputBorder.Visibility -eq 'Visible') { return $true }
    return $false
}

function Wander-Pause([int]$Ms = 2500) {
    $script:WanderPausedUntil = (Get-Date).AddMilliseconds($Ms)
    $script:WanderMoving = $false
    $script:WanderTimer.Stop()
    $script:WanderDwellTimer.Stop()
    $script:FxTimer.Stop()
    # 暂停结束后自动接着溜达，否则一次点击/一次回复就把溜达永久停掉
    $script:WanderDwellTimer.Interval = [TimeSpan]::FromMilliseconds($Ms + 200)
    $script:WanderDwellTimer.Start()
}

function Wander-Stop {
    $script:WanderMoving = $false
    $script:WanderTimer.Stop()
    $script:WanderDwellTimer.Stop()
}

function Set-LocalEmotion([string]$Name, [int]$HoldMs = 0) {
    $script:LocalEmotion = $Name
    if ($HoldMs -gt 0) {
        $script:LocalEmotionUntil = (Get-Date).AddMilliseconds($HoldMs)
    } else {
        $script:LocalEmotionUntil = [DateTime]::MaxValue
    }
    Set-PetState $Name
}

function Clear-LocalEmotion {
    $script:LocalEmotion = ''
}

function Get-PetBounds {
    if ($script:SceneMode) {
        # 场景模式：宠物在整块背景（本窗口）里活动
        return @{
            MinLeft = [double]0
            MaxLeft = [double][Math]::Max(0, $script:Window.Width - $script:PetWidth)
            MinTop = [double]0
            MaxTop = [double][Math]::Max(0, $script:Window.Height - $script:PetBodyHeight)
        }
    }
    if ($null -ne $script:SceneBounds) {
        $sb = $script:SceneBounds
        $wS = $script:PetWidth
        if (-not $wS -or $wS -lt 100) { $wS = $script:Window.Width }
        return @{
            MinLeft = [double]$sb.left
            MaxLeft = [double]($sb.left + $sb.width - $wS)
            MinTop = [double]$sb.top
            MaxTop = [double]($sb.top + $sb.height - $script:Window.Height)
        }
    }
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $extra = $script:BoardExtra
    if (-not $extra) { $extra = 0 }
    $width = $script:PetWidth
    if (-not $width -or $width -lt 100) { $width = $script:Window.Width }
    return @{
        MinLeft = [double]$wa.Left
        MaxLeft = [double]($wa.Right - $width)
        MinTop = [double]$wa.Top
        MaxTop = [double]($wa.Bottom - $script:Window.Height)
    }
}

function Wander-PickTarget {
    $bounds = Get-PetBounds
    if (($bounds.MaxLeft - $bounds.MinLeft) -lt 4 -or ($bounds.MaxTop - $bounds.MinTop) -lt 4) {
        # 窗口还没铺满（刚进场景的那一两秒）：这次先不走，等下一轮
        return $null
    }
    # 当前宠物本体的位置（窗口 left 里带了板子的偏移）
    $extra = $script:BoardExtra
    if (-not $extra) { $extra = 0 }
    $posNow = Get-PetPos
    $curLeft = $posNow.Left + $extra
    $curTop = $posNow.Top
    $best = $null
    for ($i = 0; $i -lt 12; $i++) {
        $x = $bounds.MinLeft + (Get-Random -Minimum 0 -Maximum ([Math]::Max(1, [int]($bounds.MaxLeft - $bounds.MinLeft))))
        $y = $bounds.MinTop + (Get-Random -Minimum 0 -Maximum ([Math]::Max(1, [int]($bounds.MaxTop - $bounds.MinTop))))
        $distance = [Math]::Sqrt([Math]::Pow($x - $curLeft, 2) + [Math]::Pow($y - $curTop, 2))
        $best = @{ X = [double]$x; Y = [double]$y }
        if ($distance -gt 180) { break }
    }
    return $best
}

function Wander-BeginMove {
    if (Wander-IsPaused) { return }
    # 刚有情绪反应（哭/笑）就先站着，别马上走开
    if ((Get-Date) -lt $script:EmotionHoldUntil) { Wander-ScheduleNext; return }
    $target = Wander-PickTarget
    if ($null -eq $target) { Wander-ScheduleNext; return }
    $script:WanderTargetX = $target.X
    $script:WanderTargetY = $target.Y
    $extra = $script:BoardExtra
    if (-not $extra) { $extra = 0 }
    $posBegin = Get-PetPos
    $dx = $script:WanderTargetX - ($posBegin.Left + $extra)
    if ([Math]::Abs($dx) -gt 4) {
        # 素材默认朝左（尾巴甩在右后方），所以：往左走保持原样，往右走才镜像
        if ($dx -gt 0) { $script:Flip.ScaleX = -1.0 } else { $script:Flip.ScaleX = 1.0 }
    }
    $script:WanderMoving = $true
    $script:WanderLastTick = $null
    Set-LocalEmotion 'walking'
    $script:WanderTimer.Start()
    Write-PetLog ('wander -> {0},{1}' -f [int]$script:WanderTargetX, [int]$script:WanderTargetY)
}

function Wander-ScheduleNext {
    $min = [Math]::Max(1500, $script:WanderDwellMinMs)
    $max = [Math]::Max($min, $script:WanderDwellMaxMs)
    $wait = Get-Random -Minimum $min -Maximum ($max + 1)
    $script:WanderDwellTimer.Interval = [TimeSpan]::FromMilliseconds($wait)
    $script:WanderDwellTimer.Start()
}

function Step-Wander {
    if (-not $script:WanderMoving) { $script:WanderTimer.Stop(); return }
    if (Wander-IsPaused) { Wander-Stop; return }
    $now = Get-Date
    if ($null -eq $script:WanderLastTick) { $script:WanderLastTick = $now; return }
    $dt = ($now - $script:WanderLastTick).TotalSeconds
    $script:WanderLastTick = $now
    if ($dt -le 0) { return }
    if ($dt -gt 0.35) { $dt = 0.35 }

    $extra = $script:BoardExtra
    if (-not $extra) { $extra = 0 }
    $posStep = Get-PetPos
    $curX = $posStep.Left + $extra
    $curY = $posStep.Top
    $dx = $script:WanderTargetX - $curX
    $dy = $script:WanderTargetY - $curY
    $distance = [Math]::Sqrt($dx * $dx + $dy * $dy)
    $speed = [Math]::Max(10.0, $script:WanderSpeed)
    $step = $speed * $dt

    if ($distance -le $step -or $distance -lt 2) {
        Set-PetPos ($script:WanderTargetX - $extra) $script:WanderTargetY
        $script:WanderMoving = $false
        $script:WanderTimer.Stop()
        # 到了就换个心情歇一会儿，再继续溜达
        # 停下来就别放走路动画了，换一个站立/生活类情绪（walking 看着像原地踏步）
        $idle = @('happy', 'mischievous', 'eating', 'unhappy') | Get-Random
        Set-LocalEmotion $idle 8000
        Save-Position
        Wander-ScheduleNext
        return
    }

    $nextX = $curX + ($dx / $distance) * $step
    $nextY = $curY + ($dy / $distance) * $step
    Set-PetPos ($nextX - $extra) $nextY
}

$script:WanderTimer.Interval = [TimeSpan]::FromMilliseconds(30)
$script:WanderTimer.Add_Tick({ Step-Wander })
$script:WanderDwellTimer.Add_Tick({
    $script:WanderDwellTimer.Stop()
    if (Wander-IsPaused) { return }
    Wander-BeginMove
})
# ---------------------------------------------------------------- 交互
$script:Window.Add_MouseLeftButtonDown({
    Wander-Pause 4000
    Invoke-Squash
    $script:DownLeft = $script:Window.Left
    $script:DownTop = $script:Window.Top
    try { $script:Window.DragMove() } catch { }
    $moved = ([Math]::Abs($script:Window.Left - $script:DownLeft) -ge 3) -or ([Math]::Abs($script:Window.Top - $script:DownTop) -ge 3)
    if ($moved) {
        Save-Position
        Wander-ScheduleNext
        return
    }
    if ($script:InputBorder.Visibility -eq 'Visible') {
        Hide-Input
        return
    }
    Show-Bubble ($script:TouchLines[(Get-Random -Minimum 0 -Maximum $script:TouchLines.Count)]) 1600
    Show-Input
})

$script:Window.Add_MouseWheel({
    if (([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control) -ne 0) {
        $direction = if ($_.Delta -gt 0) { 1 } else { -1 }
        $index = 0
        $best = [Math]::Abs($script:ScaleSteps[0] - $script:Scale)
        for ($i = 1; $i -lt $script:ScaleSteps.Count; $i++) {
            $distance = [Math]::Abs($script:ScaleSteps[$i] - $script:Scale)
            if ($distance -lt $best) { $best = $distance; $index = $i }
        }
        $index = [Math]::Max(0, [Math]::Min($script:ScaleSteps.Count - 1, $index + $direction))
        Apply-Size $script:ScaleSteps[$index] -KeepAnchor
        Save-Position
        $_.Handled = $true
    }
})

$script:Box.Add_KeyDown({
    param($sender, $event)
    if ($event.Key -eq [System.Windows.Input.Key]::Enter) {
        Send-Chat $script:Box.Text
        $event.Handled = $true
    } elseif ($event.Key -eq [System.Windows.Input.Key]::Escape) {
        Hide-Input
        $event.Handled = $true
    }
})

$menu = New-Object System.Windows.Controls.ContextMenu

$sizeMenu = New-Object System.Windows.Controls.MenuItem
$sizeMenu.Header = '大小'
foreach ($pair in @(@('小', 0.6), @('中', 0.85), @('大', 1.1), @('超大', 1.35))) {
    $item = New-Object System.Windows.Controls.MenuItem
    $item.Header = $pair[0]
    $item.Tag = [double]$pair[1]
    $item.Add_Click({
        param($sender, $event)
        Apply-Size ([double]$sender.Tag) -KeepAnchor
        Save-Position
    })
    [void]$sizeMenu.Items.Add($item)
}
[void]$menu.Items.Add($sizeMenu)

$muteItem = New-Object System.Windows.Controls.MenuItem
$muteItem.Header = '静音'
$muteItem.IsCheckable = $true
$muteItem.IsChecked = $script:Silent
$muteItem.Add_Click({
    $script:Silent = $muteItem.IsChecked
    if ($script:Silent) { try { $script:Player.Stop() } catch { } }
})
[void]$menu.Items.Add($muteItem)

$chatItem = New-Object System.Windows.Controls.MenuItem
$chatItem.Header = '跟它说句话'
$chatItem.Add_Click({ Show-Input })
[void]$menu.Items.Add($chatItem)

# 看一眼桌面：截图 + 视觉模型，结果由插件推回来（走正常说话那套）
$lookItem = New-Object System.Windows.Controls.MenuItem
$lookItem.Header = '看一眼桌面'
$lookItem.Add_Click({ Look-Desktop })
[void]$menu.Items.Add($lookItem)

# 让小海豚玩游戏：随机抽一盘红白机老游戏，黑白掌机窗口弹出来
$gameItem = New-Object System.Windows.Controls.MenuItem
$gameItem.Header = '让小海豚玩游戏机'
$gameItem.Add_Click({ Start-DolphinGame })
[void]$menu.Items.Add($gameItem)

# 看一眼图片：挑一张本地图（png/jpg/gif/bmp/webp）丢给视觉模型
$lookImageItem = New-Object System.Windows.Controls.MenuItem
$lookImageItem.Header = '看一眼图片…'
$lookImageItem.Add_Click({ Look-Image })
[void]$menu.Items.Add($lookImageItem)

# 动作：主动让它演一个（动作库从插件 /poses 拿，设置页加了自定义动作这里会自动出现）
$script:PoseMenu = New-Object System.Windows.Controls.MenuItem
$script:PoseMenu.Header = '动作'

function Update-PoseMenu {
    $poses = Get-Poses
    $script:PoseMenu.Items.Clear()
    if ($poses.Count -eq 0) {
        $empty = New-Object System.Windows.Controls.MenuItem
        $empty.Header = '(没拿到动作库)'
        $empty.IsEnabled = $false
        [void]$script:PoseMenu.Items.Add($empty)
        return
    }
    foreach ($pose in $poses) {
        $item = New-Object System.Windows.Controls.MenuItem
        $poseId = [string]$pose.id
        $poseLabel = [string]$pose.label
        if ($poseLabel -eq '') { $poseLabel = $poseId }
        $item.Header = $poseLabel
        $item.Tag = $poseId
        $item.Add_Click({ param($sender, $eventArgs) Invoke-PetPose ([string]$sender.Tag) })
        [void]$script:PoseMenu.Items.Add($item)
    }
}

# 背景：全屏 / 收起来只有宠物 / 关掉
$script:BgMenu = New-Object System.Windows.Controls.MenuItem
$script:BgMenu.Header = '背景'
$script:BgFullItem = New-Object System.Windows.Controls.MenuItem
$script:BgFullItem.Header = '全屏背景'
$script:BgFullItem.IsCheckable = $true
$script:BgFullItem.Add_Click({ Set-BackgroundMode 'full' })
[void]$script:BgMenu.Items.Add($script:BgFullItem)
$script:BgMinItem = New-Object System.Windows.Controls.MenuItem
$script:BgMinItem.Header = '最小化背景（只留宠物）'
$script:BgMinItem.IsCheckable = $true
$script:BgMinItem.Add_Click({ Set-BackgroundMode 'minimal' })
[void]$script:BgMenu.Items.Add($script:BgMinItem)
$script:BgOffItem = New-Object System.Windows.Controls.MenuItem
$script:BgOffItem.Header = '关闭背景'
$script:BgOffItem.IsCheckable = $true
$script:BgOffItem.Add_Click({ Set-BackgroundMode 'off' })
[void]$script:BgMenu.Items.Add($script:BgOffItem)
[void]$menu.Items.Add($script:BgMenu)
[void]$menu.Items.Add($script:PoseMenu)

# 菜单一打开就刷新：动作库可能刚在设置页里改过
$menu.Add_Opened({
    try {
        Update-PoseMenu
        $display = $script:SceneDisplay
        $script:BgFullItem.IsChecked = ($display -eq 'full')
        $script:BgMinItem.IsChecked = ($display -eq 'minimal')
        $script:BgOffItem.IsChecked = ($display -eq 'off' -or $display -eq '')
    } catch { }
})

$boardItem = New-Object System.Windows.Controls.MenuItem
$boardItem.Header = '歌单板'
$boardItem.IsCheckable = $true
$boardItem.IsChecked = $script:BoardEnabled
$boardItem.Add_Click({
    Set-BoardVisible (-not $script:BoardVisible)
    $boardItem.IsChecked = $script:BoardEnabled
})
[void]$menu.Items.Add($boardItem)

$wanderItem = New-Object System.Windows.Controls.MenuItem
$wanderItem.Header = '自动溜达'
$wanderItem.IsCheckable = $true
$wanderItem.IsChecked = $script:WanderEnabled
$wanderItem.Add_Click({
    $script:WanderEnabled = $wanderItem.IsChecked
    if ($script:WanderEnabled) { Wander-ScheduleNext } else { Wander-Stop; Clear-LocalEmotion }
})
[void]$menu.Items.Add($wanderItem)

$recenterItem = New-Object System.Windows.Controls.MenuItem
$recenterItem.Header = '重新居中'
$recenterItem.Add_Click({ Restore-Position -IgnoreSaved; Save-Position })
[void]$menu.Items.Add($recenterItem)

$resetItem = New-Object System.Windows.Controls.MenuItem
$resetItem.Header = '重开 DSH 会话'
$resetItem.Add_Click({
    try {
        $url = $script:StateUrl -replace '/state(\?.*)?$', '/reset'
        [void](Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5)
    } catch { Write-PetLog ('reset failed: ' + $_.Exception.Message) }
})
[void]$menu.Items.Add($resetItem)

[void]$menu.Items.Add((New-Object System.Windows.Controls.Separator))

$exitItem = New-Object System.Windows.Controls.MenuItem
$exitItem.Header = '退出'
$exitItem.Add_Click({ Save-Position; $script:Window.Close() })
[void]$menu.Items.Add($exitItem)
$script:Window.ContextMenu = $menu

$script:Timer.Add_Tick({ Step-Frame })
$script:SquashTimer.Interval = [TimeSpan]::FromMilliseconds(45)
$script:SquashTimer.Add_Tick({ Step-Squash })
$script:FxTimer.Add_Tick({ Step-Fx })
$script:TopTimer.Interval = [TimeSpan]::FromMilliseconds(3000)
$script:TopTimer.Add_Tick({ Reassert-Topmost })
$script:HideTimer.Add_Tick({ $script:HideTimer.Stop(); $script:Bubble.Visibility = 'Collapsed' })
$script:PartnerTimer.Add_Tick({ Step-PartnerFrame })
$script:PartnerHideTimer.Add_Tick({ $script:PartnerHideTimer.Stop(); $script:PartnerBubble.Visibility = 'Collapsed' })
$script:PartnerWalkTimer.Interval = [TimeSpan]::FromMilliseconds(60)
$script:PartnerWalkTimer.Add_Tick({ Step-PartnerWalk })
$script:Poll.Interval = [TimeSpan]::FromMilliseconds(700)
$script:GameBgTimer.Add_Tick({ Update-GameFrame })
$script:Poll.Add_Tick({ Apply-State (Fetch-State) })

$script:Window.Add_Closed({
    $script:Timer.Stop()
    $script:Poll.Stop()
    $script:WanderTimer.Stop()
    $script:WanderDwellTimer.Stop()
    $script:HideTimer.Stop()
    $script:SquashTimer.Stop()
    $script:PartnerTimer.Stop()
    $script:PartnerHideTimer.Stop()
    $script:PartnerWalkTimer.Stop()
    try { $script:Player.Close() } catch { }
if ($null -ne $script:GameWin) { try { $script:GameWin.Close() } catch { } }
    try { $script:PartnerPlayer.Close() } catch { }
})

# ---------------------------------------------------------------- 启动
Apply-Size $script:Scale
Restore-Position
Apply-Size $script:Scale
Set-PetState 'walking'
$script:Poll.Start()
$script:TopTimer.Start()
$script:PartnerWalkTimer.Start()
Wander-ScheduleNext
Write-PetLog ('window started (slot {0}) at scale {1}, state url = {2}, frames = {3}' -f $script:Slot, $script:Scale, $script:StateUrl, $script:FramesRoot)

try {
    [void]$script:Window.ShowDialog()
} catch {
    Write-PetLog ('window failed: ' + $_.Exception.Message)
    throw
} finally {
    try { $script:Mutex.ReleaseMutex() } catch { }
    Write-PetLog 'window closed'
}
