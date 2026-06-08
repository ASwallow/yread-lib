$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Lumina Library.lnk")
$Shortcut.TargetPath = "$PSScriptRoot\lumina-library.exe"
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.IconLocation = "$PSScriptRoot\lumina-library.exe,0"
$Shortcut.Description = "Lumina Library - PDF Reader"
$Shortcut.Save()
Write-Host "Desktop shortcut created!"
