#Requires -PSEdition Core
#Requires -Version 7.0
#Requires -RunAsAdministrator

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Equal([string]$Actual, [string]$Expected, [string]$Label) {
  if ($Actual -cne $Expected) {
    throw "$Label mismatch: expected '$Expected', got '$Actual'"
  }
}

function Assert-NativeSuccess([string]$Stage) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Stage failed with exit code $LASTEXITCODE"
  }
}

function Assert-HarnessResultSchema($Result, [string]$Label) {
  if ($null -eq $Result) {
    throw "$Label returned no harness result."
  }
  $required = @('FailureCode', 'CleanupFailureCode', 'ExitObserved', 'GoAttempted', 'GoSent')
  $properties = @($Result.PSObject.Properties.Name)
  if ($required | Where-Object { $_ -notin $properties }) {
    throw "$Label result schema is incomplete."
  }
}

function Assert-HarnessExecution($Result, [string]$Label) {
  Assert-HarnessResultSchema $Result $Label
  if ($Result.FailureCode -or $Result.CleanupFailureCode -or
      -not $Result.ExitObserved -or $Result.TimedOut -or
      -not $Result.GoAttempted -or -not $Result.GoSent -or
      -not $Result.CleanupConfirmed) {
    throw "$Label did not preserve supervisor, child-exit, GO, and cleanup evidence."
  }
}

function Assert-HarnessSuccess($Result, [int]$ExpectedExitCode, [string]$Label) {
  Assert-HarnessExecution $Result $Label
  if ($Result.ExitCode -ne $ExpectedExitCode) {
    throw "$Label returned child exit $($Result.ExitCode), expected $ExpectedExitCode."
  }
}

function ConvertTo-HarnessDiagnosticCode($Value, [string[]]$AllowedCodes) {
  if ([string]::IsNullOrEmpty([string]$Value)) {
    return 'none'
  }
  if ($AllowedCodes -ccontains [string]$Value) {
    return [string]$Value
  }
  return 'unknown'
}

function ConvertTo-HarnessDiagnosticBoolean($Value) {
  return ([bool]$Value).ToString().ToLowerInvariant()
}

function Format-DescendantHarnessDiagnostic($Result, [bool]$AckExists, [long]$ElapsedMs) {
  $failureCodes = @(
    'DESCENDANTS_REMAINED', 'EARLY_EXIT', 'EXECUTION_TIMEOUT', 'GO_WRITE_FAILED',
    'JOB_CONFIGURATION_FAILED', 'PROCESS_START_FAILED', 'READY_TIMEOUT',
    'SUPERVISOR_FAILURE', 'TOKEN_PREFLIGHT_FAILED'
  )
  $cleanupCodes = @(
    'JOB_HANDLE_CLOSE_FAILED', 'JOB_NOT_EMPTY', 'JOB_QUERY_FAILED',
    'JOB_TERMINATION_FAILED', 'OUTPUT_DRAIN_NOT_STARTED', 'OUTPUT_EOF_UNCONFIRMED',
    'PROCESS_EVENT_HANDLER_RELEASE_FAILED', 'PROCESS_HANDLE_RELEASE_FAILED',
    'PROCESS_INPUT_RELEASE_FAILED', 'ROOT_EXIT_QUERY_FAILED',
    'ROOT_EXIT_UNCONFIRMED', 'ROOT_TERMINATION_FAILED'
  )
  $stdout = [string]$Result.StandardOutput
  $stderr = [string]$Result.StandardError
  return [string]::Format(
    [Globalization.CultureInfo]::InvariantCulture,
    'control=descendant failure={0} cleanupFailure={1} exitObserved={2} exitCode={3} timedOut={4} goAttempted={5} goSent={6} cleanupConfirmed={7} stdoutMarker={8} stderrMarker={9} ackExists={10} elapsedMs={11}',
    (ConvertTo-HarnessDiagnosticCode $Result.FailureCode $failureCodes),
    (ConvertTo-HarnessDiagnosticCode $Result.CleanupFailureCode $cleanupCodes),
    (ConvertTo-HarnessDiagnosticBoolean $Result.ExitObserved),
    [int]$Result.ExitCode,
    (ConvertTo-HarnessDiagnosticBoolean $Result.TimedOut),
    (ConvertTo-HarnessDiagnosticBoolean $Result.GoAttempted),
    (ConvertTo-HarnessDiagnosticBoolean $Result.GoSent),
    (ConvertTo-HarnessDiagnosticBoolean $Result.CleanupConfirmed),
    (ConvertTo-HarnessDiagnosticBoolean $stdout.Contains('RVW_DESCENDANT_STDOUT')),
    (ConvertTo-HarnessDiagnosticBoolean $stderr.Contains('RVW_DESCENDANT_STDERR')),
    (ConvertTo-HarnessDiagnosticBoolean $AckExists),
    [long]$ElapsedMs
  )
}

function Get-DirectoryOwnerSid([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  return $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

$accountName = $null
$accountSid = $null
$fixtureRoot = $null
$securePassword = $null
$cleanupFailure = $false

try {
  if (-not $IsWindows -or [Environment]::Is64BitProcess -ne $true) {
    throw 'The Windows identity harness requires 64-bit PowerShell on Windows.'
  }
  Write-Output ("WINDOWS_HARNESS_RUNTIME=PowerShell/{0} {1}" -f
    $PSVersionTable.PSVersion.ToString(),
    [Runtime.InteropServices.RuntimeInformation]::FrameworkDescription)

  $nativeHelperPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'windows-harness-native.cs'))
  $smokeInfo = [Diagnostics.ProcessStartInfo]::new([IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe')))
  $smokeInfo.UseShellExecute = $false
  $smokeInfo.ArgumentList.Add('-NoLogo')
  $smokeInfo.ArgumentList.Add('-NoProfile')
  $smokeInfo.ArgumentList.Add('-NonInteractive')
  $smokeInfo.ArgumentList.Add('-Command')
  $smokeInfo.ArgumentList.Add("Add-Type -Path '$($nativeHelperPath.Replace("'", "''"))'")
  $smoke = [Diagnostics.Process]::Start($smokeInfo)
  if (-not $smoke.WaitForExit(30000)) {
    $smoke.Kill()
    if (-not $smoke.WaitForExit(5000)) { throw 'C# Add-Type smoke child did not terminate.' }
    throw 'C# Add-Type smoke timed out.'
  }
  $smokeExit = $smoke.ExitCode
  $smoke.Dispose()
  if ($smokeExit -ne 0) { throw "C# Add-Type smoke failed with exit code $smokeExit." }
  Write-Output 'NATIVE_HELPER_COMPILE_SMOKE=PASS'
  Add-Type -Path $nativeHelperPath -ErrorAction Stop

  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  if ($os.Caption -notlike '*Windows Server 2025*' -or $os.OSArchitecture -notlike '*64-bit*') {
    throw "Unexpected native test OS: '$($os.Caption)' / '$($os.OSArchitecture)'"
  }

  $sourceRoot = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
  $expectedHead = $env:REVO_EXPECTED_HEAD
  if ($expectedHead -notmatch '^[0-9a-f]{40}$') {
    throw 'Expected checkout SHA is invalid.'
  }
  $head = (& git -C $sourceRoot rev-parse HEAD).Trim()
  Assert-NativeSuccess 'git rev-parse HEAD'
  Assert-Equal $head $expectedHead 'Checked-out revision'
  $workingTree = @(& git -C $sourceRoot status --porcelain --untracked-files=normal)
  Assert-NativeSuccess 'git status'
  if ($workingTree.Count -ne 0) {
    throw 'The checked-out worktree is not clean.'
  }
  $tree = (& git -C $sourceRoot rev-parse 'HEAD^{tree}').Trim()
  Assert-NativeSuccess 'git rev-parse tree'

  $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
  $npmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
  $pwshPath = [IO.Path]::GetFullPath((Get-Command pwsh.exe -CommandType Application -ErrorAction Stop).Source)
  $nodeDirectory = Split-Path -Parent $nodePath
  $powershellDirectory = $PSHOME
  $windowsDirectory = $env:SystemRoot
  $systemDirectory = Join-Path $windowsDirectory 'System32'

  $runnerToken = [WindowsHarnessNative]::InspectProcess($PID)
  if (-not $runnerToken.IsElevated -or -not $runnerToken.HasAdministratorsSid) {
    throw 'Runner setup token is not an administrative token; standard-user proof cannot run.'
  }

  $randomBytes = [byte[]]::new(6)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($randomBytes)
  } finally {
    $rng.Dispose()
  }
  $suffix = [Convert]::ToHexString($randomBytes).ToLowerInvariant()
  $accountName = "rvw1_$suffix"
  if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) {
    throw 'Generated fixture account already exists; refusing to reuse it.'
  }

  $securePassword = [System.Security.SecureString]::new()
  $passwordClasses = @(
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!#$%&()*+,-./:;=?@[]^_{|}~'
  )
  $passwordAlphabet = $passwordClasses -join ''
  $passwordChars = [char[]]::new(48)
  for ($index = 0; $index -lt $passwordClasses.Count; $index++) {
    $passwordChars[$index] = $passwordClasses[$index][[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($passwordClasses[$index].Length)]
  }
  for ($index = $passwordClasses.Count; $index -lt $passwordChars.Length; $index++) {
    $passwordChars[$index] = $passwordAlphabet[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($passwordAlphabet.Length)]
  }
  for ($index = $passwordChars.Length - 1; $index -gt 0; $index--) {
    $other = [System.Security.Cryptography.RandomNumberGenerator]::GetInt32($index + 1)
    $temporary = $passwordChars[$index]
    $passwordChars[$index] = $passwordChars[$other]
    $passwordChars[$other] = $temporary
  }
  foreach ($character in $passwordChars) { $securePassword.AppendChar($character) }
  [Array]::Clear($passwordChars, 0, $passwordChars.Length)
  $securePassword.MakeReadOnly()

  $localUser = New-LocalUser -Name $accountName -Password $securePassword -AccountExpires (Get-Date).AddHours(2) -PasswordNeverExpires -UserMayNotChangePassword -Description 'Disposable Revo Windows CI identity fixture'
  $accountSid = $localUser.SID.Value
  $sidPattern = '^S-1-5-21-(?:\d+-){3}\d+$'
  if ('S-1-5-21-1-2-3-1001' -notmatch $sidPattern -or 'S-1-5-21-1-2-3' -match $sidPattern) {
    throw 'The harness SID shape control failed.'
  }
  if ($accountSid -notmatch $sidPattern) {
    throw 'New-LocalUser returned an unexpected SID.'
  }

  $administrators = @(Get-LocalGroupMember -SID ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-544'))
  if ($administrators | Where-Object { $_.SID.Value -eq $accountSid }) {
    throw 'Disposable test account unexpectedly belongs to Administrators.'
  }
  $users = @(Get-LocalGroupMember -SID ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545'))
  if (-not ($users | Where-Object { $_.SID.Value -eq $accountSid })) {
    Add-LocalGroupMember -SID ([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545') -Member $accountName
  }

  $profilePath = [WindowsHarnessNative]::CreateUserProfile($accountSid, $accountName)
  if (-not [IO.Path]::IsPathFullyQualified($profilePath) -or -not (Test-Path -LiteralPath $profilePath -PathType Container)) {
    throw 'Windows did not create a usable standard-user profile.'
  }

  $profileWithCaseChange = $profilePath.ToUpperInvariant()
  $profileWithSeparator = $profilePath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not [WindowsHarnessNative]::ProfilePathsEqual($profilePath, $profilePath) -or
      -not [WindowsHarnessNative]::ProfilePathsEqual($profilePath, $profileWithCaseChange) -or
      -not [WindowsHarnessNative]::ProfilePathsEqual($profilePath, $profileWithSeparator)) {
    throw 'Profile-path comparator rejected an equivalent path.'
  }
  $profileParent = [IO.Path]::GetDirectoryName($profilePath)
  $profileLeaf = [IO.Path]::GetFileName($profilePath)
  foreach ($invalidProfilePath in @(
      (Join-Path $profileParent ($profileLeaf + '-sibling')),
      (Join-Path $profilePath 'child'),
      'relative-profile-path',
      ''
    )) {
    if ([WindowsHarnessNative]::ProfilePathsEqual($profilePath, $invalidProfilePath)) {
      throw 'Profile-path comparator accepted a non-equal or non-absolute path.'
    }
  }
  Write-Output 'PROFILE_PATH_COMPARATOR_CONTROLS=PASS'

  $runnerTemp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $fixtureRoot = Join-Path $runnerTemp "revo-windows-identity-$suffix"
  $fixtureFullPath = [IO.Path]::GetFullPath($fixtureRoot)
  if (-not $fixtureFullPath.StartsWith($runnerTemp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture root escaped runner temporary storage.'
  }

  $bootstrap = Join-Path $fixtureRoot 'bootstrap'
  $workspace = Join-Path $fixtureRoot 'workspace'
  $tempDirectory = Join-Path $fixtureRoot 'tmp'
  $pnpmStore = Join-Path $fixtureRoot 'pnpm-store'
  $pnpmHome = Join-Path $fixtureRoot 'pnpm-home'
  $npmCache = Join-Path $fixtureRoot 'npm-cache'
  foreach ($directory in @($fixtureRoot, $bootstrap, $workspace, $tempDirectory, $pnpmStore, $pnpmHome, $npmCache)) {
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
  }

  $archivePath = Join-Path $bootstrap 'source.zip'
  & git -C $sourceRoot archive --format=zip "--output=$archivePath" HEAD
  Assert-NativeSuccess 'git archive'
  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts/ci/windows-identity-run.ps1') -Destination $bootstrap
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts/ci/windows-harness-native.cs') -Destination $bootstrap
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts/ci/windows-token-probe.ps1') -Destination $bootstrap

  [WindowsHarnessNative]::SetReadOnlyDirectorySecurity($fixtureRoot, $accountSid)
  [WindowsHarnessNative]::SetReadOnlyDirectorySecurity($bootstrap, $accountSid)

  $restorePrivilegeInitialState = [WindowsHarnessNative]::IsRestorePrivilegeEnabled()
  $missingSecurityPath = Join-Path $fixtureRoot "missing-security-control-$suffix"
  $aclApplyFailureObserved = $false
  try {
    [WindowsHarnessNative]::SetDirectorySecurity($missingSecurityPath, $accountSid, 'FullControl')
  } catch {
    $failureText = $_.Exception.ToString()
    $aclApplyFailureObserved = $failureText.Contains('DIRECTORY_ACL_APPLY_FAILED', [StringComparison]::Ordinal) -and
      -not $failureText.Contains('SE_RESTORE_PRIVILEGE_RESTORE_FAILED', [StringComparison]::Ordinal)
  }
  if (-not $aclApplyFailureObserved) {
    throw 'SeRestorePrivilege failure control did not fail specifically during ACL application.'
  }
  if ([WindowsHarnessNative]::IsRestorePrivilegeEnabled() -ne $restorePrivilegeInitialState) {
    throw 'SeRestorePrivilege state was not restored after controlled ACL-application failure.'
  }
  Write-Output 'SE_RESTORE_PRIVILEGE_FAILURE_RESTORE_PROBE=PASS'

  $expectedOwnerSids = @($accountSid, 'S-1-5-18', 'S-1-5-32-544')
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($directory in @($workspace, $tempDirectory, $pnpmStore, $pnpmHome, $npmCache)) {
    [WindowsHarnessNative]::SetDirectorySecurity($directory, $accountSid, 'FullControl')
    $acl = Get-Acl -LiteralPath $directory
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -cne $accountSid -or -not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne $expectedOwnerSids.Count) {
      throw 'User-owned fixture directory security descriptor readback failed.'
    }
    foreach ($expectedSid in $expectedOwnerSids) {
      $matchingRules = @($acl.Access | Where-Object {
        $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ceq $expectedSid
      })
      if ($matchingRules.Count -ne 1 -or
          $matchingRules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
          $matchingRules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
          $matchingRules[0].InheritanceFlags -ne $expectedInheritance -or
          $matchingRules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
          $matchingRules[0].IsInherited) {
        throw 'User-owned fixture directory ACE readback failed.'
      }
    }
    if ([WindowsHarnessNative]::IsRestorePrivilegeEnabled() -ne $restorePrivilegeInitialState) {
      throw 'SeRestorePrivilege state changed after fixture directory security setup.'
    }
  }
  Write-Output 'USER_DIRECTORY_SECURITY_READBACK=PASS'

  $runnerReport = [WindowsHarnessNative]::InspectProcess($PID)
  $runnerFailure = [WindowsHarnessNative]::ValidateStandardUser($runnerReport, $runnerReport.Sid)
  if (-not $runnerReport.IsElevated -or -not $runnerReport.HasAdministratorsSid -or
      $runnerFailure -ne 'token is elevated') {
    throw 'Harness did not reject the runner administrative token specifically for elevation.'
  }
  Write-Output 'ADMIN_TOKEN_REJECTION_PROBE=PASS'

  $administratorsGroupControl = [WindowsHarnessTokenReport]::new()
  $administratorsGroupControl.Sid = $accountSid
  $administratorsGroupControl.ProfilePath = $profilePath
  $administratorsGroupControl.IntegritySid = 'S-1-16-8192'
  $administratorsGroupControl.IsElevated = $false
  $administratorsGroupControl.ElevationType = 1
  $administratorsGroupControl.HasAdministratorsSid = $true
  $administratorsGroupControl.ProfileHiveLoaded = $true
  $administratorsGroupFailure = [WindowsHarnessNative]::ValidateStandardUser($administratorsGroupControl, $accountSid)
  if ($administratorsGroupFailure -ne 'Administrators SID is present in token') {
    throw 'Harness failed to reject an Administrators SID independently of elevation state.'
  }
  Write-Output 'ADMIN_GROUP_TOKEN_REJECTION_PROBE=PASS'

  $validTokenControl = [WindowsHarnessTokenReport]::new()
  $validTokenControl.Sid = $accountSid
  $validTokenControl.ProfilePath = $profilePath
  $validTokenControl.IntegritySid = 'S-1-16-8192'
  $validTokenControl.IsElevated = $false
  $validTokenControl.ElevationType = 1
  $validTokenControl.HasAdministratorsSid = $false
  $validTokenControl.ProfileHiveLoaded = $true
  if ($null -ne [WindowsHarnessNative]::ValidateStandardUser($validTokenControl, $accountSid)) {
    throw 'Harness rejected a valid synthetic standard-user token.'
  }
  if ([WindowsHarnessNative]::ValidateStandardUser($validTokenControl, 'S-1-5-21-1-2-3-1002') -ne 'user SID mismatch') {
    throw 'Harness failed to reject a token with the wrong expected SID.'
  }
  Write-Output 'STANDARD_USER_TOKEN_VALIDATION_CONTROLS=PASS'

  foreach ($elevationType in @(0, 2, 3)) {
    $elevationControl = [WindowsHarnessTokenReport]::new()
    $elevationControl.Sid = $accountSid
    $elevationControl.ProfilePath = $profilePath
    $elevationControl.IntegritySid = 'S-1-16-8192'
    $elevationControl.IsElevated = $false
    $elevationControl.ElevationType = $elevationType
    $elevationControl.HasAdministratorsSid = $false
    $elevationControl.ProfileHiveLoaded = $true
    if ([WindowsHarnessNative]::ValidateStandardUser($elevationControl, $accountSid) -ne 'token elevation type is not default') {
      throw "Harness accepted unexpected standard-user token elevation type $elevationType."
    }
  }
  Write-Output 'TOKEN_ELEVATION_TYPE_CONTROLS=PASS'

  $pathValue = @(
    $nodeDirectory,
    $powershellDirectory,
    $systemDirectory,
    $windowsDirectory,
    (Join-Path $env:ProgramFiles 'Git/cmd')
  ) -join ';'
  $environment = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  $environment['SystemRoot'] = $windowsDirectory
  $environment['WINDIR'] = $windowsDirectory
  $environment['SystemDrive'] = $env:SystemDrive
  $environment['ComSpec'] = Join-Path $systemDirectory 'cmd.exe'
  $environment['Path'] = $pathValue
  $environment['PSModulePath'] = Join-Path $powershellDirectory 'Modules'
  $environment['USERPROFILE'] = $profilePath
  $environment['HOME'] = $profilePath
  $environment['HOMEDRIVE'] = [IO.Path]::GetPathRoot($profilePath).TrimEnd('\')
  $environment['HOMEPATH'] = $profilePath.Substring($environment['HOMEDRIVE'].Length)
  $environment['APPDATA'] = Join-Path $profilePath 'AppData/Roaming'
  $environment['LOCALAPPDATA'] = Join-Path $profilePath 'AppData/Local'
  $environment['ProgramData'] = $env:ProgramData
  $environment['ProgramFiles'] = $env:ProgramFiles
  if (${env:ProgramFiles(x86)}) { $environment['ProgramFiles(x86)'] = ${env:ProgramFiles(x86)} }
  $environment['TEMP'] = $tempDirectory
  $environment['TMP'] = $tempDirectory
  $environment['PNPM_HOME'] = $pnpmHome
  $environment['NPM_CONFIG_CACHE'] = $npmCache
  $environment['REVO_EXPECTED_SID'] = $accountSid
  $environment['REVO_EXPECTED_PROFILE'] = $profilePath
  $environment['REVO_SOURCE_ARCHIVE'] = $archivePath
  $environment['REVO_SOURCE_SHA'] = $head
  $environment['REVO_TREE_SHA'] = $tree
  $environment['REVO_ARCHIVE_SHA'] = $archiveHash
  $environment['REVO_FIXTURE_ROOT'] = $fixtureRoot
  $environment['REVO_WORKSPACE'] = $workspace
  $environment['REVO_PNPM_STORE'] = $pnpmStore
  $environment['REVO_NODE_EXE'] = $nodePath
  $environment['REVO_NPM_CMD'] = $npmPath
  $environment['REVO_PWSH_EXE'] = $pwshPath
  $environment['REVO_TOKEN_PROBE_SCRIPT'] = Join-Path $bootstrap 'windows-token-probe.ps1'
  $environment['REVO_RUN_ID'] = $env:GITHUB_RUN_ID
  $environment['REVO_RUN_ATTEMPT'] = $env:GITHUB_RUN_ATTEMPT
  $environment['CI'] = 'true'

  $probePrefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command')
  $exitZero = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; exit 0'
  $zeroResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitZero), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  Assert-HarnessSuccess $zeroResult 0 'Harness exit-code control for child exit 0'
  if ($null -eq $zeroResult.Token) { throw 'Successful harness result did not include token evidence.' }
  if ($zeroResult.Token.Sid -cne $accountSid -or
      -not $zeroResult.Token.ProfileHiveLoaded -or
      -not [WindowsHarnessNative]::ProfilePathsEqual($zeroResult.Token.ProfilePath, $profilePath)) {
    throw 'Harness did not confirm the standard user SID, loaded hive, and anchored profile path.'
  }
  Write-Output 'CHILD_EXIT_CODE_0_PROBE=PASS'
  Write-Output 'STANDARD_USER_LOADED_PROFILE_PROBE=PASS'

  $earlyExitCommand = '[Console]::WriteLine("RVW_EARLY_EXIT_FIXTURE"); [Console]::Out.Flush(); exit 17'
  $earlyExitResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    ($probePrefix + $earlyExitCommand),
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $accountSid,
    'RVW_HARNESS_READY',
    30
  )
  Assert-HarnessResultSchema $earlyExitResult 'A1 early-exit control'
  if ($earlyExitResult.FailureCode -ne 'EARLY_EXIT' -or
      $earlyExitResult.CleanupFailureCode -or
      -not $earlyExitResult.ExitObserved -or
      $earlyExitResult.ExitCode -ne 17 -or
      $earlyExitResult.TimedOut -or
      $earlyExitResult.GoAttempted -or
      $earlyExitResult.GoSent -or
      -not $earlyExitResult.CleanupConfirmed) {
    throw 'A1 early-exit control did not preserve the expected outcome, exit code, handshake state, and cleanup evidence.'
  }
  Write-Output 'CHILD_EARLY_EXIT_BEFORE_READY_PROBE=PASS'

  $exitSeventeen = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; exit 17'
  $seventeenResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitSeventeen), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  Assert-HarnessSuccess $seventeenResult 17 'Harness exit-code control for child exit 17'
  Write-Output 'CHILD_EXIT_CODE_17_PROBE=PASS'

  $noReadyCommand = 'Start-Sleep -Seconds 60'
  $noReadyResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    ($probePrefix + $noReadyCommand),
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $accountSid,
    'RVW_HARNESS_READY',
    3,
    30,
    10
  )
  Assert-HarnessResultSchema $noReadyResult 'Ready-timeout control'
  if ($noReadyResult.FailureCode -ne 'READY_TIMEOUT' -or
      $noReadyResult.CleanupFailureCode -or
      -not $noReadyResult.ExitObserved -or
      $noReadyResult.ExitCode -eq -1 -or
      -not $noReadyResult.TimedOut -or
      $noReadyResult.GoAttempted -or
      $noReadyResult.GoSent -or
      -not $noReadyResult.CleanupConfirmed) {
    throw 'Ready-timeout control did not preserve timeout, handshake, exit, and cleanup evidence.'
  }
  Write-Output 'READY_TIMEOUT_PROBE=PASS'

  $timeoutCommand = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; Start-Sleep -Seconds 60'
  $timeoutResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $timeoutCommand), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 3)
  Assert-HarnessResultSchema $timeoutResult 'Execution-timeout control'
  if ($timeoutResult.FailureCode -ne 'EXECUTION_TIMEOUT' -or
      $timeoutResult.CleanupFailureCode -or
      -not $timeoutResult.ExitObserved -or
      $timeoutResult.ExitCode -eq -1 -or
      -not $timeoutResult.TimedOut -or
      -not $timeoutResult.GoAttempted -or
      -not $timeoutResult.GoSent -or
      -not $timeoutResult.CleanupConfirmed) {
    throw 'Execution-timeout control did not preserve timeout, GO, exit, and cleanup evidence.'
  }
  Write-Output 'EXECUTION_TIMEOUT_PROBE=PASS'

  $environment['REVO_DESCENDANT_ACK'] = Join-Path $tempDirectory ('revo-descendant-ack-' + [Guid]::NewGuid().ToString('N') + '.txt')
  if (Test-Path -LiteralPath $environment['REVO_DESCENDANT_ACK']) {
    throw 'Generated descendant acknowledgement path already exists.'
  }
  $descendantCommand = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; $childInfo = [Diagnostics.ProcessStartInfo]::new($env:REVO_PWSH_EXE); $childInfo.UseShellExecute = $false; $childInfo.CreateNoWindow = $true; $childInfo.ArgumentList.Add("-NoLogo"); $childInfo.ArgumentList.Add("-NoProfile"); $childInfo.ArgumentList.Add("-NonInteractive"); $childInfo.ArgumentList.Add("-Command"); $childInfo.ArgumentList.Add("[Console]::Out.WriteLine(''RVW_DESCENDANT_STDOUT''); [Console]::Out.Flush(); [Console]::Error.WriteLine(''RVW_DESCENDANT_STDERR''); [Console]::Error.Flush(); [IO.File]::WriteAllText(`$env:REVO_DESCENDANT_ACK, ''ready''); Start-Sleep -Seconds 120"); $child = [Diagnostics.Process]::Start($childInfo); if ($null -eq $child) { exit 91 }; $wait = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path -LiteralPath $env:REVO_DESCENDANT_ACK -PathType Leaf) -and $wait.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }; if (-not (Test-Path -LiteralPath $env:REVO_DESCENDANT_ACK -PathType Leaf)) { exit 92 }; exit 0'
  $descendantWatch = [Diagnostics.Stopwatch]::StartNew()
  $descendantResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    ($probePrefix + $descendantCommand),
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $accountSid,
    'RVW_HARNESS_READY',
    30,
    10,
    15
  )
  $descendantWatch.Stop()
  Assert-HarnessResultSchema $descendantResult 'Descendant-held-pipe control'
  $descendantAckExists = Test-Path -LiteralPath $environment['REVO_DESCENDANT_ACK'] -PathType Leaf
  Write-Output (Format-DescendantHarnessDiagnostic $descendantResult $descendantAckExists $descendantWatch.ElapsedMilliseconds)
  if ($descendantResult.FailureCode -ne 'DESCENDANTS_REMAINED' -or
      $descendantResult.CleanupFailureCode -or
      -not $descendantResult.ExitObserved -or
      $descendantResult.ExitCode -ne 0 -or
      $descendantResult.TimedOut -or
      -not $descendantResult.GoAttempted -or
      -not $descendantResult.GoSent -or
      -not $descendantResult.CleanupConfirmed -or
      -not $descendantResult.StandardOutput.Contains('RVW_DESCENDANT_STDOUT') -or
      -not $descendantResult.StandardError.Contains('RVW_DESCENDANT_STDERR') -or
      $descendantWatch.ElapsedMilliseconds -gt 60000) {
    throw 'Descendant-held-pipe control did not prove inherited output, detect the descendant, and bound cleanup.'
  }
  Write-Output 'DESCENDANTS_HELD_PIPE_CLEANUP_PROBE=PASS'

  $missingExecutable = Join-Path $fixtureRoot 'missing-harness-child.exe'
  $startFailureResult = [WindowsHarnessNative]::RunAsUser(
    $missingExecutable,
    @(),
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $accountSid,
    'RVW_HARNESS_READY',
    30
  )
  Assert-HarnessResultSchema $startFailureResult 'Process-start failure control'
  if ($startFailureResult.FailureCode -ne 'PROCESS_START_FAILED' -or
      $startFailureResult.CleanupFailureCode -or
      $startFailureResult.ExitObserved -or
      $startFailureResult.ExitCode -ne -1 -or
      $startFailureResult.TimedOut -or
      $startFailureResult.GoAttempted -or
      $startFailureResult.GoSent -or
      -not $startFailureResult.CleanupConfirmed) {
    throw 'Process-start failure control did not preserve failure and handle-release evidence.'
  }
  Write-Output 'PROCESS_START_FAILURE_PROBE=PASS'

  $wrongSid = 'S-1-5-21-1-2-3-98765'
  $tokenFailureResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    ($probePrefix + $exitZero),
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $wrongSid,
    'RVW_HARNESS_READY',
    30
  )
  Assert-HarnessResultSchema $tokenFailureResult 'Token-preflight failure control'
  if ($tokenFailureResult.FailureCode -ne 'TOKEN_PREFLIGHT_FAILED' -or
      $tokenFailureResult.CleanupFailureCode -or
      -not $tokenFailureResult.ExitObserved -or
      $tokenFailureResult.TimedOut -or
      $tokenFailureResult.GoAttempted -or
      $tokenFailureResult.GoSent -or
      -not $tokenFailureResult.CleanupConfirmed) {
    throw 'Token-preflight failure control did not refuse GO and confirm cleanup.'
  }
  Write-Output 'TOKEN_PREFLIGHT_FAILURE_PROBE=PASS'

  $runArguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    (Join-Path $bootstrap 'windows-identity-run.ps1')
  )
  $nativeResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    $runArguments,
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $environment,
    $accountSid,
    'RVW_HARNESS_READY',
    1800
  )
  Write-Output "WINDOWS_NATIVE_TARGET os=$($os.Caption) arch=x64 node=26.8.2 source=$head tree=$tree"
  Write-Output "WINDOWS_NATIVE_CHILD_EXIT=$($nativeResult.ExitCode) timedOut=$($nativeResult.TimedOut) cleanupConfirmed=$($nativeResult.CleanupConfirmed)"
  Write-Output "WINDOWS_NATIVE_SUPERVISOR_FAILURE=$($nativeResult.FailureCode) cleanupFailure=$($nativeResult.CleanupFailureCode) exitObserved=$($nativeResult.ExitObserved) goAttempted=$($nativeResult.GoAttempted) goSent=$($nativeResult.GoSent)"
  if ($nativeResult.StandardOutput) { Write-Output $nativeResult.StandardOutput }
  if ($nativeResult.StandardError) { Write-Output $nativeResult.StandardError }
  Assert-HarnessExecution $nativeResult 'Windows native identity child'
  if ($null -eq $nativeResult.Token) {
    throw 'Windows native identity child did not provide token evidence.'
  }
  Write-Output "STANDARD_USER_TOKEN=PASS sid=$($nativeResult.Token.Sid) elevated=$($nativeResult.Token.IsElevated) adminGroup=$($nativeResult.Token.HasAdministratorsSid) integrity=$($nativeResult.Token.IntegritySid) profileLoaded=$($nativeResult.Token.ProfileHiveLoaded)"
  if ($nativeResult.ExitCode -ne 0) {
    exit $nativeResult.ExitCode
  }
} finally {
  if ($securePassword) {
    $securePassword.Dispose()
  }

  if ($accountSid) {
    $remainingProcesses = @(
      Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue
        if ($owner.Sid -eq $accountSid) { $_ }
      }
    )
    if ($remainingProcesses.Count -gt 0) {
      Write-Error 'Fixture-owned processes remain; leaving account and files for disposal with the hosted runner.'
      $cleanupFailure = $true
    } else {
      if ($accountName -and (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue)) {
        Remove-LocalUser -Name $accountName -ErrorAction Stop
      }
      if ($accountName -and (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue)) {
        Write-Error 'Disposable local account removal was not confirmed.'
        $cleanupFailure = $true
      }
      if ($fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)) {
        $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
        if ($resolvedFixture.StartsWith([IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedFixture) -like 'revo-windows-identity-*') {
          Remove-Item -LiteralPath $resolvedFixture -Recurse -Force -ErrorAction Stop
        } else {
          Write-Error 'Refusing to remove a fixture path outside the unique runner temporary root.'
          $cleanupFailure = $true
        }
      }
    }
  }
}

if ($cleanupFailure) {
  exit 1
}
