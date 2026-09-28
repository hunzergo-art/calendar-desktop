# 在屏幕坐标处点一下鼠标。用于验证界面上难以从外部触发的交互（比如弹窗）。
#
# 坐标是**物理像素**：脚本先把自己声明成 DPI 感知的，
# 否则在缩放不是 100% 的机器上，Windows 会对坐标做虚拟化换算，
# 于是「探测到的原点」和「点击用的坐标」落在两个不同的坐标系里，点位会飘。
# 这台机器是 200% 缩放，不声明的话差得就不是一点半点了。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/click-at.ps1 -X 1220 -Y 125

param(
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y
)

Add-Type -Namespace Click -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
public struct POINT { public int X, Y; }
'@

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
[Click.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null

# 先把落点处那个窗口提到前台再点。
# 不这么做的话，点击会打到叠在最上面的那个窗口上——通常是终端自己，
# 于是看着像「点了没反应」，实际是点错了对象。
$pt = New-Object Click.Native+POINT
$pt.X = $X
$pt.Y = $Y
$target = [Click.Native]::WindowFromPoint($pt)
if ($target -ne [IntPtr]::Zero) {
    # GA_ROOT = 2：拿顶层窗口，否则可能是 webview 内部的子窗口，提不到前台
    $root = [Click.Native]::GetAncestor($target, 2)
    [Click.Native]::SetForegroundWindow($root) | Out-Null
    Start-Sleep -Milliseconds 350
}

$MOVE = 0x0001
$DOWN = 0x0002
$UP = 0x0004

[Click.Native]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 120
[Click.Native]::mouse_event($DOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[Click.Native]::mouse_event($UP, 0, 0, 0, [IntPtr]::Zero)

Write-Output "clicked ($X,$Y)"
