#Requires -PSEdition Core
#Requires -Version 7.0

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Fail-Preflight([string]$Message) {
  [Console]::Error.WriteLine("WINDOWS_IDENTITY_PREFLIGHT_FAILED: $Message")
  exit 90
}

[Console]::WriteLine('RVW_HARNESS_READY')
[Console]::Out.Flush()
if ([Console]::ReadLine() -cne 'GO') {
  Fail-Preflight 'parent did not authorize fixture execution'
}

$preflightStage = 'NATIVE_HELPER'
try {
  $helper = Join-Path (Split-Path -Parent $PSCommandPath) 'windows-harness-native.cs'
  Add-Type -Path $helper -ErrorAction Stop
  $preflightStage = 'PROCESS_IDENTITY'
  $expectedSid = $env:REVO_EXPECTED_SID
  $identity = [WindowsHarnessNative]::InspectProcess($PID)
  $identityFailure = [WindowsHarnessNative]::ValidateStandardUser($identity, $expectedSid)
  if ($identityFailure) { Fail-Preflight $identityFailure }

  $preflightStage = 'PROFILE'
  $expectedProfile = $env:REVO_EXPECTED_PROFILE
  if (-not [WindowsHarnessNative]::ProfilePathsEqual($identity.ProfilePath, $expectedProfile)) {
    Fail-Preflight 'Token profile does not equal the independently created profile anchor'
  }
  if (-not [WindowsHarnessNative]::ProfilePathsEqual($env:USERPROFILE, $expectedProfile)) {
    Fail-Preflight 'USERPROFILE does not equal the independently created profile anchor'
  }

  $preflightStage = 'FIXTURE_DIRECTORIES'
  $workspace = [IO.Path]::GetFullPath($env:REVO_WORKSPACE)
  $tempDirectory = [IO.Path]::GetFullPath($env:TEMP)
  $store = [IO.Path]::GetFullPath($env:REVO_PNPM_STORE)
  foreach ($path in @($workspace, $tempDirectory, $store)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { Fail-Preflight "fixture directory missing: $path" }
    $acl = Get-Acl -LiteralPath $path
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $expectedSid) { Fail-Preflight "fixture directory owner mismatch: $path" }
    foreach ($rule in $acl.Access) {
      $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
          $ruleSid -in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545') -and
          (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Write) -ne 0 -or
           ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::Modify) -ne 0 -or
           ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne 0)) {
        Fail-Preflight "fixture directory grants broad write access: $path"
      }
    }
    $probePath = Join-Path $path ('.revo-write-probe-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probePath, 'fixture')
    [IO.File]::Delete($probePath)
  }

  $preflightStage = 'SOURCE_ARCHIVE'
  $sourceArchive = $env:REVO_SOURCE_ARCHIVE
  $actualArchiveHash = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualArchiveHash -ne $env:REVO_ARCHIVE_SHA) { Fail-Preflight 'source archive checksum mismatch' }
  Expand-Archive -LiteralPath $sourceArchive -DestinationPath $workspace -Force
  if (-not (Test-Path -LiteralPath (Join-Path $workspace 'package.json') -PathType Leaf)) {
    Fail-Preflight 'source archive did not produce a workspace root'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $workspace 'pnpm-lock.yaml') -PathType Leaf)) {
    Fail-Preflight 'source archive is missing the frozen lockfile'
  }

  $node = $env:REVO_NODE_EXE
  $npm = $env:REVO_NPM_CMD
  $expectedNodeVersion = $env:REVO_EXPECTED_NODE_VERSION
  $expectedNpmVersion = $env:REVO_EXPECTED_NPM_VERSION
  if ($expectedNodeVersion -notmatch '^v\d+\.\d+\.\d+$' -or
      $expectedNpmVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    Fail-Preflight 'invalid tool-cache runtime metadata'
  }
  $preflightStage = 'NODE_INVOKE'
  $nodeOutput = @(& $node -p "process.version + '|' + process.platform + '|' + process.arch" 2>$null)
  $preflightStage = 'NODE_RESULT'
  $nodeExit = $LASTEXITCODE
  if ($nodeExit -ne 0 -or $nodeOutput.Count -ne 1) { Fail-Preflight 'Node runtime probe failed' }
  $nodeInfo = [string]$nodeOutput[0]
  $expectedNodeInfo = "$expectedNodeVersion|win32|x64"
  if ($nodeInfo -ne $expectedNodeInfo) { Fail-Preflight 'unexpected Node runtime' }
  Write-Output 'NODE_RUNTIME versionMatch=true platformMatch=true archMatch=true exit=0'

  $preflightStage = 'NPM_INVOKE'
  $npmOutput = @(& $npm --version 2>$null)
  $preflightStage = 'NPM_RESULT'
  $npmExit = $LASTEXITCODE
  if ($npmExit -ne 0 -or $npmOutput.Count -ne 1) { Fail-Preflight 'npm runtime probe failed' }
  $npmVersion = [string]$npmOutput[0]
  if ($npmVersion -cne $expectedNpmVersion) { Fail-Preflight 'npm runtime version mismatch' }
  Write-Output 'NPM_RUNTIME versionMatch=true exit=0'
  Write-Output "WINDOWS_IDENTITY_PREFLIGHT=PASS sid=$expectedSid node=$nodeInfo npm=$npmVersion profileLoaded=$($identity.ProfileHiveLoaded)"
  Write-Output "SOURCE_PROVENANCE=PASS commit=$($env:REVO_SOURCE_SHA) tree=$($env:REVO_TREE_SHA) archiveSha256=$actualArchiveHash"

  $pnpmPrefix = Join-Path $workspace '.tools'
  $pnpmCli = Join-Path $pnpmPrefix 'node_modules/pnpm/bin/pnpm.cjs'
  $pnpmStore = $env:REVO_PNPM_STORE
  $npmCache = $env:NPM_CONFIG_CACHE
  $preflightStage = 'PNPM_SETUP'
  Push-Location $workspace
  try {
    & $npm install --global --prefix $pnpmPrefix --cache $npmCache --no-audit --no-fund 'pnpm@12.4.1'
    $stageExit = $LASTEXITCODE
    Write-Output "STANDARD_USER_STAGE npm-pnpm-setup exit=$stageExit"
    if ($stageExit -ne 0) { exit $stageExit }
    if (-not (Test-Path -LiteralPath $pnpmCli -PathType Leaf)) { Fail-Preflight 'pnpm CLI was not installed at the fixture-local prefix' }

    $pnpmVersion = (& $node $pnpmCli --version).Trim()
    $stageExit = $LASTEXITCODE
    Write-Output "STANDARD_USER_STAGE pnpm-version exit=$stageExit version=$pnpmVersion"
    if ($stageExit -ne 0) { exit $stageExit }
    if ($pnpmVersion -ne '12.4.1') { Fail-Preflight "unexpected pnpm version: $pnpmVersion" }

    & $node $pnpmCli install --frozen-lockfile --store-dir $pnpmStore
    $stageExit = $LASTEXITCODE
    Write-Output "STANDARD_USER_STAGE install exit=$stageExit"
    if ($stageExit -ne 0) { exit $stageExit }

    & $node $pnpmCli build
    $stageExit = $LASTEXITCODE
    Write-Output "STANDARD_USER_STAGE build exit=$stageExit"
    if ($stageExit -ne 0) { exit $stageExit }

    & $node $pnpmCli exec vitest run test/scenarios/windows-process-identity-native.test.ts --reporter=verbose
    $stageExit = $LASTEXITCODE
    Write-Output "STANDARD_USER_STAGE native-identity-test exit=$stageExit"
    exit $stageExit
  } finally {
    Pop-Location
  }
} catch {
  $nativeErrorCode = 'none'
  $exception = $_.Exception
  while ($null -ne $exception) {
    if ($exception -is [System.ComponentModel.Win32Exception]) {
      $nativeErrorCode = $exception.NativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture)
      break
    }
    $exception = $exception.InnerException
  }
  [Console]::Error.WriteLine("WINDOWS_IDENTITY_PREFLIGHT_FAILED: code=PREFLIGHT_EXCEPTION stage=$preflightStage nativeError=$nativeErrorCode")
  exit 90
}
