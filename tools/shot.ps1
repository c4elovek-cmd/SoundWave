// Скриншот главного окна SoundWave через PowerShell + WinAPI
param([string]$Out = "$env:TEMP\soundwave-shot.png", [int]$WaitSec = 4)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$exe = "G:\Users\c4elovek\this\AIFiles\SoundWave\node_modules\electron\dist\electron.exe"
$p = Start-Process -FilePath $exe -ArgumentList "." -WorkingDirectory "G:\Users\c4elovek\this\AIFiles\SoundWave" -PassThru
Start-Sleep -Seconds $WaitSec

$proc = Get-Process -Id $p.Id
$h = $proc.MainWindowHandle
if ($h -eq 0) { Write-Output "no window"; exit 1 }

[W]::ShowWindow($h, 9) | Out-Null
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 1200

$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$hh = $r.B - $r.T
Write-Output "rect $w x $hh"

$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out"

Stop-Process -Id $p.Id -Force
