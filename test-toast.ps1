# Toast payload verification. ASCII only on purpose: Windows PowerShell 5.1
# reads a BOM-less .ps1 in the system code page, so any non-ASCII literal in a
# probe file risks the very mojibake this suite is checking for.
#
# The helper script itself (notify.ps1) DOES keep a UTF-8 BOM, and the
# Chinese label it contains is verified below.
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

$root = $PSScriptRoot
$script = Join-Path $root 'notify.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek-Harness.lnk'

$results = @()
function Check($name, $ok, $detail) {
  $script:results += [pscustomobject]@{ name = $name; ok = [bool]$ok; detail = $detail }
}

# --- source guards --------------------------------------------------------
$bytes = [System.IO.File]::ReadAllBytes($script)
$hasBom = ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
Check 'notify.ps1 keeps a UTF-8 BOM' $hasBom 'a BOM-less file makes PowerShell 5.1 decode the Chinese label as GBK'

# The file must hold the correct label bytes even if the console cannot show them.
$text = [System.IO.File]::ReadAllText($script, [System.Text.Encoding]::UTF8)
$labelOk = $text.Contains([char]0x6253 + [char]0x5F00 + ' DeepSeek-Harness')   # U+6253 U+5F00
Check 'action label literal is intact on disk' $labelOk ''

# displayName must sit on <binding>, not <toast>.
$onBinding = $text -match 'binding template="ToastGeneric" displayName='
$onToast = $text -match '<toast[^>]*displayName='
Check 'displayName is on the binding' $onBinding ''
Check 'displayName is not on the toast element' (-not $onToast) ''

# The send path must (re)write the AppUserModelId entry, since that — not the
# toast XML — is what names the toast in the header.
Check 'send path registers the AUMID' ($text.Contains('AppUserModelId')) 'the header falls back to the .lnk path without it'

# --- send and inspect -----------------------------------------------------
$stamp = Get-Date -Format 'HHmmss'
$title = "DSH probe $stamp"
$raw = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Mode send -Title $title -Body 'payload verification' -Activate 'dsh://notify'
$sent = $raw | ConvertFrom-Json
Check 'helper reports sent' ($sent.state -eq 'sent') $raw
Check 'helper resolved the shortcut' ([bool]$sent.appId) $raw
Check 'helper resolved an icon' ([bool]$sent.icon) $raw

Start-Sleep -Milliseconds 1500

# Read the payload back. History coverage varies by Windows build, so a missing
# entry is reported rather than failed: the toast still shows live.
$xmlText = $null
foreach ($entry in $history.GetHistory($shortcut)) {
  try {
    if ($entry.Notification -and $entry.Notification.Content) {
      $candidate = $entry.Notification.Content.GetXml()
      if ($candidate -and $candidate.Contains($title)) { $xmlText = $candidate; break }
    }
  } catch { }
}

if ($xmlText) {
  [xml]$doc = $xmlText
  $binding = $doc.toast.visual.binding | Where-Object { $_.template -eq 'ToastGeneric' } | Select-Object -First 1
  $name = $binding.displayName
  Check 'read back: displayName is DeepSeek-Harness' ($name -eq 'DeepSeek-Harness') "got '$name'"
  $action = $doc.toast.actions.action | Select-Object -First 1
  $wantLabel = [char]0x6253 + [char]0x5F00 + ' DeepSeek-Harness'
  Check 'read back: action label has no mojibake' ($action.content -eq $wantLabel) "got '$($action.content)'"
  Check 'read back: launch is dsh://notify' ($doc.toast.launch -eq 'dsh://notify') "got '$($doc.toast.launch)'"
} else {
  Write-Output 'NOTE: the toast was not readable from history on this build; payload checks skipped.'
}

$failed = @($results | Where-Object { -not $_.ok })
foreach ($r in $results) {
  $mark = if ($r.ok) { 'PASS' } else { 'FAIL' }
  $suffix = if ($r.ok -or -not $r.detail) { '' } else { "  ($($r.detail))" }
  Write-Output ("{0}  {1}{2}" -f $mark, $r.name, $suffix)
}
Write-Output ("`n{0}/{1} passed" -f ($results.Count - $failed.Count), $results.Count)
if ($failed.Count -gt 0) { exit 1 }
