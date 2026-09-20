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
  Assert-Equal (Get-DirectoryOwnerSid $profilePath) $accountSid 'Profile owner SID'

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
  foreach ($directory in @($workspace, $tempDirectory, $pnpmStore, $pnpmHome, $npmCache)) {
    [WindowsHarnessNative]::SetDirectorySecurity($directory, $accountSid, 'FullControl')
  }

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
  $earlyExitCommand = '[Console]::WriteLine("RVW_EARLY_EXIT_FIXTURE"); [Console]::Out.Flush(); exit 17'
  $earlyExitResult = $null
  try {
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
  } catch [TimeoutException] {
    if ($_.Exception.Message -ceq 'Standard-user harness did not reach its ready handshake') {
      throw [InvalidOperationException]::new('A1 early-exit control failed: expected EARLY_EXIT with exit 17 and no GO; observed the current ready-handshake timeout.')
    }
    throw
  }
  if ($null -eq $earlyExitResult) {
    throw 'A1 early-exit control returned neither an outcome nor the expected RED.'
  }
  $earlyExitProperties = @($earlyExitResult.PSObject.Properties.Name)
  if (@('FailureCode', 'CleanupFailureCode', 'ExitObserved', 'GoAttempted', 'GoSent') | Where-Object { $_ -notin $earlyExitProperties }) {
    throw 'A1 early-exit result schema is incomplete; the control did not produce meaningful evidence.'
  }
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

  $exitZero = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; exit 0'
  $zeroResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitZero), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  if ($zeroResult.ExitCode -ne 0 -or $zeroResult.TimedOut -or -not $zeroResult.CleanupConfirmed) {
    throw 'Harness exit-code control for child exit 0 failed.'
  }
  Write-Output 'CHILD_EXIT_CODE_0_PROBE=PASS'

  $exitSeventeen = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; exit 17'
  $seventeenResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitSeventeen), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  if ($seventeenResult.ExitCode -ne 17 -or $seventeenResult.TimedOut -or -not $seventeenResult.CleanupConfirmed) {
    throw 'Harness exit-code control did not preserve child exit code 17.'
  }
  Write-Output 'CHILD_EXIT_CODE_17_PROBE=PASS'

  $timeoutCommand = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; Start-Sleep -Seconds 60'
  $timeoutResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $timeoutCommand), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 3)
  if (-not $timeoutResult.TimedOut -or -not $timeoutResult.CleanupConfirmed) {
    throw 'Harness timeout probe did not terminate and confirm its fixture job.'
  }
  Write-Output 'FIXTURE_JOB_TIMEOUT_PROBE=PASS'

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
  Write-Output "STANDARD_USER_TOKEN=PASS sid=$($nativeResult.Token.Sid) elevated=$($nativeResult.Token.IsElevated) adminGroup=$($nativeResult.Token.HasAdministratorsSid) integrity=$($nativeResult.Token.IntegritySid) profileLoaded=$($nativeResult.Token.ProfileHiveLoaded)"
  Write-Output "WINDOWS_NATIVE_CHILD_EXIT=$($nativeResult.ExitCode) timedOut=$($nativeResult.TimedOut) cleanupConfirmed=$($nativeResult.CleanupConfirmed)"
  if ($nativeResult.StandardOutput) { Write-Output $nativeResult.StandardOutput }
  if ($nativeResult.StandardError) { Write-Output $nativeResult.StandardError }
  if ($nativeResult.TimedOut -or -not $nativeResult.CleanupConfirmed) {
    throw 'Windows native identity child timed out or fixture cleanup was not confirmed.'
  }
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
