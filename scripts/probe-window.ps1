# 打印某个进程最大可见窗口的客户区尺寸、屏幕原点和 DPI。
#
# 和 dump-windows.ps1 的区别：那个给的是**外框**（含标题栏和边框），
# 这个给的是**客户区**——也就是网页实际拿到的那块画布。
# 要把界面上的逻辑坐标换算成屏幕坐标去点击时，必须用客户区原点。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-window.ps1 -ProcessId <PID>

param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    # 传了就顺手把窗口改成这个物理尺寸。诊断 DPI 相关问题时用来对照：
    # 缩放 200% 的机器上，CSS 视口 = 物理客户区 / 2。
    [int[]]$ResizeTo
)

Add-Type -Namespace Probe -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
[DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
public delegate bool EnumProc(IntPtr h, IntPtr l);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
'@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2：不声明的话拿到的是被虚拟化过的尺寸，
# 和 SetWindowPos 实际生效的坐标系对不上。
#
# 结果要检查：这个声明每个进程只能生效一次，失败时后续读到的全是虚拟化坐标，
# 数值看着正常（1100x720 这种），但和屏幕上真实的位置差着一个缩放比。
$dpiOk = [Probe.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not $dpiOk) { Write-Output "警告：DPI 感知声明失败，下面的坐标是虚拟化过的" }
Write-Output "探测进程看到的屏幕: $([Probe.Native]::GetSystemMetrics(0)) x $([Probe.Native]::GetSystemMetrics(1))"

$best = $null
$cb = [Probe.Native+EnumProc] {
    param($h, $l)

    $owner = 0
    [Probe.Native]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    if ($owner -ne $ProcessId -or -not [Probe.Native]::IsWindowVisible($h)) { return $true }

    $r = New-Object Probe.Native+RECT
    [Probe.Native]::GetClientRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { return $true }

    if ($null -eq $script:best -or ($w * $ht) -gt ($script:best.W * $script:best.H)) {
        $pt = New-Object Probe.Native+POINT
        [Probe.Native]::ClientToScreen($h, [ref]$pt) | Out-Null
        $script:best = [pscustomobject]@{
            W = $w; H = $ht; X = $pt.X; Y = $pt.Y
            Dpi = [Probe.Native]::GetDpiForWindow($h)
            Hwnd = $h
        }
    }
    return $true
}

[Probe.Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($null -eq $best) { Write-Output "没找到可见窗口"; exit 1 }

$scale = $best.Dpi / 96.0
"client=$($best.W)x$($best.H) origin=($($best.X),$($best.Y)) dpi=$($best.Dpi) scale=$scale"
"logical=$([math]::Round($best.W / $scale))x$([math]::Round($best.H / $scale))"

if ($ResizeTo -and $ResizeTo.Count -ge 2) {
    # MoveWindow 要的是**外框**尺寸，这里按差值补上标题栏和边框，
    # 让客户区精确落在要求的物理尺寸上。
    $border = 16
    $titleBar = 62
    if ($scale -ge 1.5) { $border = 8; $titleBar = 31 }

    [Probe.Native]::MoveWindow($best.Hwnd, $best.X - $border, $best.Y - $titleBar - $border,
        $ResizeTo[0] + 2 * $border, $ResizeTo[1] + $titleBar + 2 * $border, $true) | Out-Null
    Start-Sleep -Milliseconds 400

    $r = New-Object Probe.Native+RECT
    [Probe.Native]::GetClientRect($best.Hwnd, [ref]$r) | Out-Null
    "resized -> client=$(($r.Right - $r.Left))x$(($r.Bottom - $r.Top))"
}
