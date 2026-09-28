# 列出某个进程当前所有「可见」的顶层窗口：尺寸 + 标题的 Unicode 码点。
# 码点而不是原文，是因为经过 bash → powershell 的管道时中文会被编坏。
# 用法：powershell -NoProfile -File scripts/dump-windows.ps1 <PID>
param([Parameter(Mandatory = $true)][int]$ProcessId)

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class WinDump {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  public static string Dump(uint target) {
    var sb = new StringBuilder();
    EnumWindows((h, p) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        var title = new StringBuilder(256);
        GetWindowTextW(h, title, 256);
        RECT r;
        GetWindowRect(h, out r);

        var cps = new StringBuilder();
        foreach (char c in title.ToString()) {
          cps.Append(((int)c).ToString("X4")).Append(' ');
        }

        sb.Append("size=").Append(r.Right - r.Left).Append('x').Append(r.Bottom - r.Top);
        sb.Append("  at=(").Append(r.Left).Append(',').Append(r.Top).Append(')');
        sb.Append("  iconic=").Append(IsIconic(h));
        sb.Append("  zoomed=").Append(IsZoomed(h));
        sb.Append("  chars=").Append(title.Length);
        sb.Append("  codepoints=[").Append(cps.ToString().Trim()).Append(']');
        sb.AppendLine();
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
'@

# 不声明 DPI 感知的话，GetWindowRect 返回的尺寸会被 Windows 按缩放比虚拟化——
# 200% 缩放的机器上，一个 2200x1440 的窗口会报成 1100x720。
# 数值本身看着很正常，很容易据此得出错误结论。
if (-not [WinDump]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
  Write-Output "警告：DPI 感知声明失败，下面的尺寸是虚拟化过的"
}
Write-Output "屏幕: $([WinDump]::GetSystemMetrics(0)) x $([WinDump]::GetSystemMetrics(1))"

$out = [WinDump]::Dump([uint32]$ProcessId)
if ([string]::IsNullOrWhiteSpace($out)) {
  Write-Output "(没有可见窗口)"
} else {
  Write-Output $out
}
