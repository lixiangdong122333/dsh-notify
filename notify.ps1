# Windows toast notification helper for DSH (Windows PowerShell 5.1).
#
# WinRT is reached through the projected Windows.* types PowerShell binds on
# first use; the toast is raised as a Start Menu shortcut id because Windows
# ignores toasts from an unpackaged desktop app that has no such identity.
#
# This file must stay UTF-8 WITH BOM: Windows PowerShell 5.1 reads a .ps1
# script in the system code page unless the BOM says otherwise, and the action
# label below is Chinese. Without the BOM the label renders as mojibake.
#
#   -Mode send     raise one toast (the default)
#   -Mode install  register this helper as the toast activator (only needed so a
#                  click can launch a command line; focus needs it)
#   -Mode test     report notification settings and the helper's own state
param(
  [ValidateSet('send', 'install', 'test')]
  [string]$Mode = 'send',
  [string]$Title = 'DeepSeek-Harness',
  [string]$Body = '',
  [string]$Activate = 'dsh://notify',
  [string]$Image = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Find-Shortcut {
  # The Electron installer writes "DeepSeek Harness.lnk" — a space, not a hyphen —
  # into the per-user Start Menu, and a manual or older install may use either
  # spelling, so both are tried. The directory is enumerated with a wide filter
  # and the name compared ordinally: a narrower -Filter misses the spaced file,
  # and [Environment]::GetFolderPath is empty in some non-interactive hosts.
  $dirs = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:PUBLIC 'Desktop')
  )
  $names = @('DeepSeek Harness.lnk', 'DeepSeek-Harness.lnk')
  foreach ($dir in $dirs) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter 'DeepSeek*.lnk' -Recurse -ErrorAction SilentlyContinue)
    foreach ($name in $names) {
      foreach ($file in $files) {
        if ($file.Name -ceq $name) { return $file.FullName }
      }
    }
  }
  return $null
}

# The icon Windows shows beside the app name. A .lnk carries its own icon, and
# the shell resolves it for the toast header.
function Find-Icon($shortcut) {
  if (-not $shortcut) { return '' }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    if ($link.IconLocation) {
      $icon = ($link.IconLocation -split ',')[0].Trim()
      if ($icon -and (Test-Path -LiteralPath $icon)) { return $icon }
    }
    if ($link.TargetPath -and (Test-Path -LiteralPath $link.TargetPath)) { return $link.TargetPath }
  } catch {
    # No icon is cosmetically worse but not worth failing the toast over.
  }
  return ''
}

function Write-Status($state, $extra) {
  $payload = [ordered]@{ ok = $state -ne 'dropped' -and $state -ne 'error'; state = $state }
  if ($extra) { foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] } }
  $payload | ConvertTo-Json -Compress
}

if ($Mode -eq 'test') {
  $settings = Get-ItemProperty -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings' -ErrorAction SilentlyContinue
  $shortcut = Find-Shortcut
  Write-Status 'ok' ([ordered]@{
    shortcut = $shortcut
    icon = Find-Icon $shortcut
    toastsDisabled = if ($settings) { $settings.NOC_GLOBAL_SETTING_TOASTS_ENABLED -eq 0 } else { $null }
    doNotDisturb = if ($settings) { $settings.EnableDoNotDisturb } else { $null }
    bannersHidden = if ($settings) { $settings.NOC_GLOBAL_SETTING_QUIET_HOURS_HIDE_BANNERS } else { $null }
    powershell = $PSVersionTable.PSVersion.ToString()
    activator = (Get-ItemProperty -LiteralPath 'HKCU:\SOFTWARE\Classes\CLSID\{6F0D9A55-3E1C-4F2E-9B7A-5D2C8E1A4B63}\LocalServer32' -ErrorAction SilentlyContinue).'(default)'
  })
  exit 0
}

if ($Mode -eq 'install') {
  $shortcut = Find-Shortcut
  if (-not $shortcut) { Write-Status 'error' @{ detail = 'no DeepSeek-Harness shortcut to register' }; exit 1 }
  $key = 'HKCU:\SOFTWARE\Classes\CLSID\{6F0D9A55-3E1C-4F2E-9B7A-5D2C8E1A4B63}'
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -LiteralPath $key -Name '(default)' -Value 'DSH Notifications'
  Set-ItemProperty -LiteralPath $key -Name 'AppID' -Value $shortcut
  New-Item -Path (Join-Path $key 'LocalServer32') -Force | Out-Null
  $command = '"{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"' -f `
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'), $PSCommandPath
  Set-ItemProperty -LiteralPath (Join-Path $key 'LocalServer32') -Name '(default)' -Value $command
  Write-Status 'ok' @{ appId = $shortcut }
  exit 0
}

# ---- send -------------------------------------------------------------------

$shortcut = Find-Shortcut
if (-not $shortcut) { Write-Status 'error' @{ detail = 'no DeepSeek-Harness shortcut to raise the toast as' }; exit 1 }

# The header name comes from the AppUserModelId entry, not from the toast XML:
# Windows keys the display name by AUMID, and an unpackaged app's AUMID is this
# shortcut path. A fresh install, or an app update that rewrites the shortcut,
# leaves the entry missing, which makes the header fall back to the raw path.
# It is therefore (re)written before every send: values are left alone when
# already correct, and a failure here must not stop the toast.
$displayName = 'DeepSeek-Harness'
$icon = Find-Icon $shortcut
try {
  $aumidRoot = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\AppUserModelId')
  # The AUMID contains backslashes and a colon, which the PowerShell provider
  # cannot express below a root key, so the .NET API writes the name verbatim.
  $aumidKey = $aumidRoot.CreateSubKey($shortcut)
  if ($aumidKey.GetValue('DisplayName') -ne $displayName) {
    $aumidKey.SetValue('DisplayName', $displayName, [Microsoft.Win32.RegistryValueKind]::String)
  }
  if ($icon -and $aumidKey.GetValue('IconUri') -ne $icon) {
    $aumidKey.SetValue('IconUri', $icon, [Microsoft.Win32.RegistryValueKind]::String)
  }
  $aumidKey.Close()
  $aumidRoot.Close()
} catch {
  # A missing entry only costs the header its friendly name.
}

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]

$escape = { param($text) [System.Security.SecurityElement]::Escape([string]$text) }

# The displayName on the binding is a second line of defence for hosts that
# read it; the AppUserModelId entry above is what actually names the toast.
$image = if ($Image) { "<image placement=`"appLogoOverride`" src=`"$(& $escape $Image)`"/>" } else { '' }
$header = if ($icon) { "<image id=`"1`" src=`"$(& $escape $icon)`"/>" } else { '' }

$xml = @"
<toast activationType="protocol" launch="$(& $escape $Activate)">
  <visual>
    <binding template="ToastGeneric" displayName="$(& $escape $displayName)">
      $header
      <text>$(& $escape $Title)</text>
      <text>$(& $escape $Body)</text>
      $image
    </binding>
  </visual>
  <actions>
    <action content="打开 DeepSeek-Harness" activationType="protocol" arguments="$(& $escape $Activate)" />
  </actions>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>
"@

try {
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  $toast.Tag = 'dsh-notify'
  $toast.Group = 'dsh'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($shortcut).Show($toast)
  Write-Status 'sent' @{ appId = $shortcut; icon = $icon }
  exit 0
} catch {
  Write-Status 'error' @{ detail = $_.Exception.Message }
  exit 1
}
