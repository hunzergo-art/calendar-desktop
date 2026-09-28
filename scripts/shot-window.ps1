# 把某个进程最大的那个可见窗口截下来存成 PNG。
# 只截该窗口自己的矩形，不截整个桌面——避免把屏幕上无关的内容也拍进去。
# 用法：powershell -NoProfile -File scripts/shot-window.ps1 <PID> <输出路径>
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Out
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public class WinPick {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

  // 让窗口把自己画进给定的 DC。PW_RENDERFULLCONTENT = 2，
  // 没有这个标志时 WebView2 这类分层窗口会画成空白。
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);

  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  public static IntPtr Biggest;
  public static int BestArea = 0;

  // 面积最大的那个可见窗口，通常就是主窗口
  public static IntPtr Find(uint target) {
    Biggest = IntPtr.Zero;
    BestArea = 0;
    EnumWindows((h, p) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        RECT r;
        GetWindowRect(h, out r);
        int area = (r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > BestArea) { BestArea = area; Biggest = h; }
      }
      return true;
    }, IntPtr.Zero);
    return Biggest;
  }
}
'@

# 必须在任何 Add-Type 之前声明 DPI 感知，而且只能声明一次——
# 所以不放在 C# 里，放在最外层由这里调用，并检查结果。
#
# 不声明的话 PowerShell 是「DPI 无感知」的，`GetWindowRect` 返回的尺寸会被
# Windows 按缩放比虚拟化（这台机器 200%，1100 逻辑宽的窗口报成 1100 物理宽的
# 一半）。而 `PrintWindow` 是按窗口**原生**分辨率往 DC 里画的，
# 于是只画进了左上角那一块——看上去像界面被裁了一半，其实是截图脚本的坐标系错了。
$dpiOk = [WinPick]::SetProcessDpiAwarenessContext([IntPtr](-4))   # PER_MONITOR_AWARE_V2
if (-not $dpiOk) { Write-Output "警告：DPI 感知声明失败，截出来的尺寸可能是虚拟化过的" }
Write-Output "截图进程看到的屏幕: $([WinPick]::GetSystemMetrics(0)) x $([WinPick]::GetSystemMetrics(1))"

# 加载 WinForms 会顺带把进程的 DPI 感知改成 SystemAware，
# 所以必须排在上面那次声明之后。
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$hwnd = [WinPick]::Find([uint32]$ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "找不到可见窗口"; exit 1 }

[void][WinPick]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 900

$r = New-Object WinPick+RECT
[void][WinPick]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinPick]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "已保存 $Out  ($w x $h)  PrintWindow=$ok"
