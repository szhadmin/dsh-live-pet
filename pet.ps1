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
$script:Image.RenderTransformOrigin = [System.Windows.Point]::new(0.5, 1.0)
$script:Image.RenderTransform = $script:Squash

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
$script:Window = New-Object System.Windows.Window
$script:Window.Title = '小鲸鱼直播宠物'
$script:Window.WindowStyle = [System.Windows.WindowStyle]::None
$script:Window.AllowsTransparency = $true
$script:Window.Background = [System.Windows.Media.Brushes]::Transparent
$script:Window.Topmost = $true
$script:Window.ShowInTaskbar = $false
$script:Window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$script:Window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$script:Window.Content = $shell

# 隐藏启动时 Windows 会把 SW_HIDE 用在第一个顶层窗口上，这里显式显示
$script:Win32Ready = $false
try {
    Add-Type -Namespace PetNative3 -Name WindowApi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
    $script:Win32Ready = $true
} catch { }
$script:Window.Add_SourceInitialized({
    if (-not $script:Win32Ready) { return }
    try {
        $helper = New-Object System.Windows.Interop.WindowInteropHelper($script:Window)
        if ($helper.Handle -ne [IntPtr]::Zero) { [void][PetNative3.WindowApi]::ShowWindow($helper.Handle, 8) }
    } catch { }
})

$script:PositionFile = Join-Path $script:Root 'pet-window.json'

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
    $workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
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
    $script:Window.Width = $script:PetWidth + $boardExtra
    $script:Window.Height = $script:BubbleArea + $pixels
    $script:BoardExtra = $boardExtra
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
$script:CurrentState = 'walking'
$script:FrameIndex = 0
$script:LastSeq = -1
$script:SquashStep = 0

function Set-PetState([string]$StateName) {
    if (-not $script:States.ContainsKey($StateName)) { $StateName = 'walking' }
    if ($script:CurrentState -eq $StateName -and $script:Timer.IsEnabled) { return }
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

function Apply-State($state) {
    Update-Board $state
    if ($null -eq $state) {
        Set-PetState 'crying'
        return
    }
    $emotion = [string]$state.emotion
    if ($script:Emotions -notcontains $emotion) { $emotion = 'walking' }
    if ([string]$state.status -eq 'thinking') { $emotion = 'coding' }
    if ([string]$state.status -eq 'offline') { $emotion = 'crying' }

    $seq = [int]$state.seq
    if ($seq -eq $script:LastSeq) { return }
    $script:LastSeq = $seq

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

# ---------------------------------------------------------------- 交互
$script:Window.Add_MouseLeftButtonDown({
    Invoke-Squash
    $script:DownLeft = $script:Window.Left
    $script:DownTop = $script:Window.Top
    try { $script:Window.DragMove() } catch { }
    $moved = ([Math]::Abs($script:Window.Left - $script:DownLeft) -ge 3) -or ([Math]::Abs($script:Window.Top - $script:DownTop) -ge 3)
    if ($moved) {
        Save-Position
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
$script:HideTimer.Add_Tick({ $script:HideTimer.Stop(); $script:Bubble.Visibility = 'Collapsed' })
$script:Poll.Interval = [TimeSpan]::FromMilliseconds(700)
$script:Poll.Add_Tick({ Apply-State (Fetch-State) })

$script:Window.Add_Closed({
    $script:Timer.Stop()
    $script:Poll.Stop()
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
