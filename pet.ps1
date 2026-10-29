#Requires -Version 5.1
<#
    小鲸鱼直播宠物 —— DSH 插件 dsh-live-pet 的"身体"。

    无边框、透明、置顶的桌面窗口：
      · 每 700ms 轮询 DSH Host 的 /dsh-live-pet/state，冒气泡 / 切情绪动图 / 播放 mp3
      · 单击 = 弹出输入条，打字回车就发进同一条 DSH 会话
      · 拖动 = 移动；Ctrl+滚轮 或右键菜单 = 缩放
      · 按下有挤压回弹反馈

    环境变量：
      PET_STATE_URL  状态地址，默认 http://127.0.0.1:64420/dsh-live-pet/state
      PET_FRAMES     帧目录（含 meta.json），默认为本脚本同级的 frames
      PET_SILENT     1 = 静音启动
#>
$ErrorActionPreference = 'Stop'

$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:FramesRoot = if ($env:PET_FRAMES) { $env:PET_FRAMES } else { Join-Path $script:Root 'frames' }
$script:StateUrl = if ($env:PET_STATE_URL) { $env:PET_STATE_URL } else { 'http://127.0.0.1:64420/dsh-live-pet/state' }
$script:ChatUrl = $script:StateUrl -replace '/state$', '/chat'
$script:LogFile = Join-Path $script:Root 'pet-window.log'
$script:FrameSize = 240
$script:ScaleSteps = @(0.6, 0.85, 1.1, 1.35)
$script:Scale = 0.75
$script:BubbleArea = 96
$script:Silent = ($env:PET_SILENT -eq '1')

function Write-PetLog([string]$Message) {
    try {
        $line = '{0} {1}' -f ([DateTime]::Now.ToString('HH:mm:ss')), $Message
        Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
    } catch { }
}

# 只允许一个宠物窗口
$script:Mutex = New-Object System.Threading.Mutex($false, 'Global\dsh-live-pet-window')
try {
    if (-not $script:Mutex.WaitOne(0)) { return }
} catch { }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

if (-not (Test-Path (Join-Path $script:FramesRoot 'meta.json'))) {
    Write-PetLog ('frames missing: ' + $script:FramesRoot)
    return
}
$meta = Get-Content (Join-Path $script:FramesRoot 'meta.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$script:States = @{}

function Load-State([string]$StateName) {
    $dir = Join-Path $script:FramesRoot $StateName
    if (-not (Test-Path $dir)) { return $null }
    $frames = New-Object System.Collections.ArrayList
    foreach ($file in (Get-ChildItem -Path $dir -Filter '*.png' | Sort-Object Name)) {
        $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
        $bitmap.BeginInit()
        $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bitmap.CreateOptions = [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat
        $bitmap.UriSource = New-Object System.Uri($file.FullName)
        $bitmap.EndInit()
        $bitmap.Freeze()
        [void]$frames.Add($bitmap)
    }
    $durations = @()
    foreach ($value in $meta.($StateName).durations) { $durations += [int]$value }
    return @{ Frames = $frames.ToArray(); Durations = $durations }
}

$script:Emotions = @('happy', 'mischievous', 'crying', 'unhappy', 'eating', 'cooking', 'coding', 'tv', 'walking')
foreach ($stateName in $script:Emotions) {
    $loaded = Load-State $stateName
    if ($null -ne $loaded) { $script:States[$stateName] = $loaded }
}
if ($script:States.Count -eq 0) { Write-PetLog 'no frames loaded'; return }

# ---------------------------------------------------------------- 窗口控件
$script:Bubble = New-Object System.Windows.Controls.Border
$script:Bubble.Background = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(238, 18, 40, 58))
$script:Bubble.BorderBrush = [System.Windows.Media.SolidColorBrush]::new([System.Windows.Media.Color]::FromArgb(120, 120, 200, 240))
$script:Bubble.BorderThickness = [System.Windows.Thickness]::new(1)
$script:Bubble.CornerRadius = [System.Windows.CornerRadius]::new(12)
$script:Bubble.Padding = [System.Windows.Thickness]::new(10, 7, 10, 7)
$script:Bubble.HorizontalAlignment = 'Center'
$script:Bubble.VerticalAlignment = 'Bottom'
$script:Bubble.Visibility = 'Collapsed'

$script:BubbleText = New-Object System.Windows.Controls.TextBlock
$script:BubbleText.Foreground = [System.Windows.Media.Brushes]::White
$script:BubbleText.FontSize = 13
$script:BubbleText.LineHeight = 20
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
$script:Box.Width = 236
$script:Box.FontSize = 13
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
$script:ImageTransforms = New-Object System.Windows.Media.TransformGroup
[void]$script:ImageTransforms.Children.Add($script:Squash)
[void]$script:ImageTransforms.Children.Add($script:Flip)
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
$script:BoardText.FontSize = 12
$script:BoardText.LineHeight = 18
$script:BoardText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$script:BoardText.Text = '点歌台'
$script:Board.Child = $script:BoardText

# 直播场景：背景图 + 左上角弹幕池 + 右上角点歌台，全部画在同一个窗口里
# （单窗口的好处：OBS 直接抓这个窗口就够了，不用多个来源对齐）
$script:SceneMode = $false
$script:PetX = 0.0
$script:PetY = 0.0

$script:SceneBg = New-Object System.Windows.Controls.Border
$script:SceneBg.Visibility = 'Collapsed'
$script:SceneBgBrush = New-Object System.Windows.Media.ImageBrush
$script:SceneBgBrush.Stretch = [System.Windows.Media.Stretch]::UniformToFill
$script:SceneBg.Background = $script:SceneBgBrush

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
$script:PoolFontSize = 20
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
$script:PoolTitle.FontSize = 20
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
$script:SongText.FontSize = 18
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
$script:SongClock.FontSize = 14
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
$script:StatsText.FontSize = 16
$script:StatsText.LineHeight = 25
$script:StatsText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$script:StatsPanel.Child = $script:StatsText

# 烟花特效层：盖在最上面，不挡鼠标
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
[void]$root.Children.Add($shell)
[void]$root.Children.Add($script:FxLayer)
[System.Windows.Controls.Panel]::SetZIndex($script:PoolPanel, 1)
[System.Windows.Controls.Panel]::SetZIndex($script:SongPanel, 1)
[System.Windows.Controls.Panel]::SetZIndex($script:StatsPanel, 1)
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

$script:PositionFile = Join-Path $script:Root 'pet-window.json'

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
    $script:Window.Left = $workArea.Right - $script:Window.Width - 30
    $script:Window.Top = $workArea.Bottom - $script:Window.Height - 40
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

function Apply-Size([double]$NewScale, [switch]$KeepAnchor) {
    $oldWidth = $script:Window.Width
    $oldHeight = $script:Window.Height
    $script:Scale = [Math]::Max(0.4, [Math]::Min(2.0, $NewScale))
    $pixels = [int][Math]::Round($script:FrameSize * $script:Scale)
    $script:Image.Width = $pixels
    $script:Image.Height = $pixels
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

function Show-Bubble([string]$Text, [int]$HoldMs) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $script:BubbleText.Text = $Text
    $script:Bubble.Visibility = 'Visible'
    $script:HideTimer.Stop()
    $script:HideTimer.Interval = [TimeSpan]::FromMilliseconds($HoldMs)
    $script:HideTimer.Start()
}

function Play-Audio([string]$Path) {
    if ($script:Silent -or [string]::IsNullOrWhiteSpace($Path)) { return }
    if (-not (Test-Path $Path)) { return }
    try {
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

# ---------------------------------------------------------------- 状态轮询
function Fetch-State {
    try {
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
    $statsText = [string]::Join([Environment]::NewLine, $statsLines)
    if ($script:StatsText.Text -ne $statsText) { $script:StatsText.Text = $statsText }
}

function Apply-State($state) {
    Update-Board $state
    if ($null -eq $state) {
        Set-PetState 'crying'
        return
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
    if ($state.PSObject.Properties.Name -contains 'scene') {
        $sc = $state.scene
        Set-SceneMode ([bool]$sc.enabled) ([string]$sc.imagePath)
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
    Update-ScenePanels $state

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
        $hold = [int][Math]::Max(3000, [Math]::Min(15000, ($duration + 3.0) * 1000))
        Show-Bubble $say $hold
    }
    if ($state.PSObject.Properties.Name -contains 'audioPath') {
        Play-Audio ([string]$state.audioPath)
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
        $url = $script:StateUrl -replace '/state$', '/reset'
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
$script:Poll.Interval = [TimeSpan]::FromMilliseconds(700)
$script:Poll.Add_Tick({ Apply-State (Fetch-State) })

$script:Window.Add_Closed({
    $script:Timer.Stop()
    $script:Poll.Stop()
    $script:WanderTimer.Stop()
    $script:WanderDwellTimer.Stop()
    $script:HideTimer.Stop()
    $script:SquashTimer.Stop()
    try { $script:Player.Close() } catch { }
})

# ---------------------------------------------------------------- 启动
Apply-Size $script:Scale
Restore-Position
Apply-Size $script:Scale
Set-PetState 'walking'
$script:Poll.Start()
$script:TopTimer.Start()
Wander-ScheduleNext
Write-PetLog ('window started at scale {0}, state url = {1}' -f $script:Scale, $script:StateUrl)

try {
    [void]$script:Window.ShowDialog()
} catch {
    Write-PetLog ('window failed: ' + $_.Exception.Message)
    throw
} finally {
    try { $script:Mutex.ReleaseMutex() } catch { }
    Write-PetLog 'window closed'
}
