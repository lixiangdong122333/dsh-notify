# Verify the repository against the DSH plugin listing requirements.
$ErrorActionPreference = 'Continue'
$repo = 'lixiangdong122333/dsh-notify'
$results = @()
function Check($name, $ok, $detail) {
  $script:results += [pscustomobject]@{ name = $name; ok = [bool]$ok; detail = $detail }
}
function Decode-Base64Content($raw) {
  if (-not $raw) { return $null }
  $clean = ($raw -replace '\s', '')
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($clean))
}

# 1. Public repository
$info = gh api "repos/$repo" 2>$null | ConvertFrom-Json
Check 'repository is public' ($info.private -eq $false) "private=$($info.private)"
Check 'repository is reachable' ([bool]$info.full_name) "full_name=$($info.full_name)"

# 2. Topic dsh-plugin
$topics = (gh api "repos/$repo/topics" 2>$null | ConvertFrom-Json).names
Check 'topic dsh-plugin is present' ($topics -contains 'dsh-plugin') ($topics -join ', ')

# 3. README with an install command
$readmeRaw = gh api "repos/$repo/readme" --jq '.content' 2>$null
$readme = Decode-Base64Content $readmeRaw
if ($readme) {
  Check 'README has dsh plugin --profile ... add' ($readme -match 'dsh plugin --profile \w+ add') ''
  Check 'README names the npm package' ($readme -match '@cmwl1231/dsh-notify') ''
  Check 'README documents github: install' ($readme -match 'github:lixiangdong122333/dsh-notify') ''
} else {
  Check 'README exists' $false 'no README found'
}

# 4. Root package.json
$pkgRaw = gh api "repos/$repo/contents/package.json" --jq '.content' 2>$null
$pkgText = Decode-Base64Content $pkgRaw
if ($pkgText) {
  $pkg = $pkgText | ConvertFrom-Json
  Check 'root package.json exists' $true ''
  Check 'package.json has a name' ([bool]$pkg.name) "name=$($pkg.name)"
  Check 'package.json has a version' ([bool]$pkg.version) "version=$($pkg.version)"
  Check 'package.json declares dsh.bundle.patch' ([bool]$pkg.dsh.bundle.patch) "patch=$($pkg.dsh.bundle.patch)"
  Check 'patch file exists in repo' ([bool](gh api "repos/$repo/contents/cordis.patch.yml" --jq '.name' 2>$null)) ''
} else {
  Check 'root package.json exists' $false 'missing'
}

# 5. Entry module exports apply(ctx)
$idxRaw = gh api "repos/$repo/contents/index.js" --jq '.content' 2>$null
$idx = Decode-Base64Content $idxRaw
if ($idx) {
  Check 'entry exports apply()' ($idx -match 'export function apply') ''
  Check 'entry exports name' ($idx -match 'export const name') ''
} else {
  Check 'index.js exists at root' $false 'missing'
}

# 6. npm publication status (informational gate for Plugin Center only)
$npmOk = $false
try {
  $r = Invoke-WebRequest -Uri 'https://registry.npmjs.org/@cmwl1231%2Fdsh-notify' -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  $npmOk = ($r.StatusCode -eq 200)
} catch { $npmOk = $false }
Check 'npm package published (Plugin Center gate)' $npmOk 'not published yet; repo is still listable via github:'

foreach ($r in $results) {
  $mark = if ($r.ok) { 'PASS' } else { 'FAIL' }
  $suffix = if ($r.detail) { "  ($($r.detail))" } else { '' }
  Write-Output ("{0}  {1}{2}" -f $mark, $r.name, $suffix)
}
$failed = @($results | Where-Object { -not $_.ok })
Write-Output ("`n{0}/{1} passed" -f ($results.Count - $failed.Count), $results.Count)
