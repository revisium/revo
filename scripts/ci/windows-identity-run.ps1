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

function Get-LastExitCodeEvidence {
  $variable = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
  if ($null -eq $variable) {
    return [pscustomobject]@{ Present = $false; Type = 'none'; Code = 'none' }
  }
  if ($variable.Value -is [int32]) {
    return [pscustomobject]@{
      Present = $true
      Type = 'int32'
      Code = $variable.Value.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
  }
  return [pscustomobject]@{ Present = $true; Type = 'other'; Code = 'none' }
}

function Get-NodeInvocationEnvironmentEvidence {
  $processEnvironment = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process)
  $pathExtPresent = $processEnvironment.Contains('PATHEXT')
  $pathExt = if ($pathExtPresent) { [string]$processEnvironment['PATHEXT'] } else { $null }
  $pathExtState = if (-not $pathExtPresent) { 'absent' } elseif ($pathExt.Length -eq 0) { 'empty' } else { 'nonempty' }
  $pathExtLength = if ($null -eq $pathExt) { 0 } else { $pathExt.Length }
  $extensions = @()
  if ($pathExtPresent -and $pathExt.Length -gt 0) {
    $extensions = @($pathExt -split ';' | ForEach-Object { $_.Trim().ToUpperInvariant() })
  }
  $argumentPassing = 'unknown'
  $argumentPassingVariable = Get-Variable -Name PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue
  if ($null -ne $argumentPassingVariable) {
    $candidatePassing = [string]$argumentPassingVariable.Value
    if ($candidatePassing -in @('Legacy', 'Standard', 'Windows')) {
      $argumentPassing = $candidatePassing
    }
  }
  $errorPreference = 'unknown'
  $errorPreferenceVariable = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  if ($null -ne $errorPreferenceVariable -and $errorPreferenceVariable.Value -is [bool]) {
    $errorPreference = $errorPreferenceVariable.Value.ToString().ToLowerInvariant()
  }
  return [pscustomobject]@{
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    RuntimeVersion = [Environment]::Version.ToString()
    PathExtPresent = $pathExtPresent
    PathExtState = $pathExtState
    PathExtLength = $pathExtLength
    PathExtHasExe = $extensions -contains '.EXE'
    PathExtHasCmd = $extensions -contains '.CMD'
    PathExtExactExe = [string]::Equals($pathExt, '.EXE', [StringComparison]::OrdinalIgnoreCase)
    ArgumentPassing = $argumentPassing
    ErrorActionPreference = $errorPreference
  }
}

function Write-NodeDirectProbeReceipt([object]$Probe) {
  $exitCode = 'none'
  if ($null -ne $Probe.ExitCode) { $exitCode = $Probe.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $startHResult = 'none'
  if ($null -ne $Probe.StartHResult) { $startHResult = $Probe.StartHResult.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $startNativeError = 'none'
  if ($null -ne $Probe.StartNativeErrorCode) { $startNativeError = $Probe.StartNativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $exceptionHResult = 'none'
  if ($null -ne $Probe.ExceptionHResult) { $exceptionHResult = $Probe.ExceptionHResult.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $exceptionNativeError = 'none'
  if ($null -ne $Probe.ExceptionNativeErrorCode) { $exceptionNativeError = $Probe.ExceptionNativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $killHResult = 'none'
  if ($null -ne $Probe.KillHResult) { $killHResult = $Probe.KillHResult.ToString([Globalization.CultureInfo]::InvariantCulture) }
  $killNativeError = 'none'
  if ($null -ne $Probe.KillNativeErrorCode) { $killNativeError = $Probe.KillNativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture) }
  [Console]::Out.WriteLine("NODE_DIRECT_PROBE attempted=$($Probe.StartAttempted.ToString().ToLowerInvariant()) started=$($Probe.Started.ToString().ToLowerInvariant()) stage=$($Probe.Stage) failure=$($Probe.FailureCode) exitObserved=$($Probe.ExitObserved.ToString().ToLowerInvariant()) exitCode=$exitCode timedOut=$($Probe.TimedOut.ToString().ToLowerInvariant()) killAttempted=$($Probe.KillAttempted.ToString().ToLowerInvariant()) killRequestSucceeded=$($Probe.KillRequestSucceeded.ToString().ToLowerInvariant()) killFailure=$($Probe.KillFailureKind) killHResult=$killHResult killNativeError=$killNativeError stdoutBytes=$($Probe.StandardOutputBytes) stdoutTruncated=$($Probe.StandardOutputTruncated.ToString().ToLowerInvariant()) stdoutEof=$($Probe.StandardOutputEof.ToString().ToLowerInvariant()) stdoutReadFailure=$($Probe.StandardOutputReadFailureKind) stderrBytes=$($Probe.StandardErrorBytes) stderrTruncated=$($Probe.StandardErrorTruncated.ToString().ToLowerInvariant()) stderrEof=$($Probe.StandardErrorEof.ToString().ToLowerInvariant()) stderrReadFailure=$($Probe.StandardErrorReadFailureKind) stdinCloseFailure=$($Probe.StandardInputCloseFailureKind) disposeFailure=$($Probe.DisposeFailureKind) runtimeMatch=$($Probe.RuntimeMatch.ToString().ToLowerInvariant()) cleanupConfirmed=$($Probe.CleanupConfirmed.ToString().ToLowerInvariant()) cleanupFailure=$($Probe.CleanupFailureCode) exceptionPhase=$($Probe.ExceptionPhase) exceptionKind=$($Probe.ExceptionKind) exceptionHResult=$exceptionHResult exceptionNativeError=$exceptionNativeError startExceptionKind=$($Probe.StartExceptionKind) startHResult=$startHResult startNativeError=$startNativeError elapsedMs=$($Probe.ElapsedMilliseconds)")
}

function Assert-NodeRuntimeProbe(
  [bool]$InvokeSucceeded,
  [bool]$ExitPresent,
  [string]$ExitType,
  [AllowNull()][object]$ExitCode,
  [AllowNull()][object[]]$Output,
  [string]$Executable,
  [string]$WorkingDirectory,
  [string]$ExpectedRuntime,
  [scriptblock]$DirectProbe
) {
  $outputMatches = $false
  $runtimeInfo = ''
  if ($null -ne $Output -and $Output.Count -eq 1) {
    $runtimeInfo = [string]$Output[0]
    $outputMatches = [string]::Equals($runtimeInfo, $ExpectedRuntime, [StringComparison]::Ordinal)
  }
  $exitMatches = $ExitPresent -and $ExitType -eq 'int32' -and $ExitCode -is [int32] -and $ExitCode -eq 0
  if ($InvokeSucceeded -and $exitMatches -and $outputMatches) {
    return $runtimeInfo
  }

  try {
    if ($null -eq $DirectProbe) {
      $DirectProbe = {
        param($CandidateExecutable, $CandidateWorkingDirectory, $CandidateRuntime)
        [WindowsHarnessNative]::ProbeNodeRuntimeDirect(
          $CandidateExecutable,
          $CandidateWorkingDirectory,
          $CandidateRuntime
        ).GetAwaiter().GetResult()
      }
    }
    $probe = & $DirectProbe $Executable $WorkingDirectory $ExpectedRuntime
    if ($null -eq $probe) { throw [InvalidOperationException]::new() }
    Write-NodeDirectProbeReceipt $probe
  } catch {
    $exception = $_.Exception
    $kind = 'other'
    $hResult = 'none'
    $nativeError = 'none'
    try { $hResult = $exception.HResult.ToString([Globalization.CultureInfo]::InvariantCulture) } catch {}
    if ($exception -is [System.ComponentModel.Win32Exception]) {
      $kind = 'win32'
      try { $nativeError = $exception.NativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture) } catch {}
    } elseif ($exception -is [UnauthorizedAccessException]) {
      $kind = 'unauthorized-access'
    } elseif ($exception -is [IO.IOException]) {
      $kind = 'io-error'
    } elseif ($exception -is [ArgumentException]) {
      $kind = 'argument'
    } elseif ($exception -is [InvalidOperationException]) {
      $kind = 'invalid-operation'
    } elseif ($exception -is [System.Security.SecurityException]) {
      $kind = 'security'
    }
    [Console]::Out.WriteLine("NODE_DIRECT_PROBE attempted=true stage=diagnostic failure=diagnostic-unavailable exceptionPhase=diagnostic exceptionKind=$kind exceptionHResult=$hResult exceptionNativeError=$nativeError")
  }
  Fail-Preflight 'Node runtime probe failed'
}

function Get-PreflightErrorKind([System.Management.Automation.ErrorRecord]$Record) {
  $identifier = [string]$Record.FullyQualifiedErrorId
  if ($identifier -match 'VariableIsUndefined|VariableNotFound') { return 'variable-undefined' }
  if ($identifier -match 'PropertyNotFound') { return 'property-missing' }
  if ($identifier -match 'NativeCommand') { return 'native-command' }
  if ($identifier -match 'CommandNotFound') { return 'command-not-found' }
  return 'other'
}

function Get-PreflightExceptionDiagnostic([System.Management.Automation.ErrorRecord]$Record) {
  $category = 'unknown'
  $line = 0
  $outerHResult = 'none'
  $innerHResult = 'none'
  $nativeErrorCode = 'none'
  try { $category = $Record.CategoryInfo.Category.ToString() } catch {}
  try {
    if ($Record.InvocationInfo.ScriptLineNumber -is [int] -and $Record.InvocationInfo.ScriptLineNumber -gt 0) {
      $line = $Record.InvocationInfo.ScriptLineNumber
    }
  } catch {}

  $exception = $Record.Exception
  $level = 0
  while ($null -ne $exception -and $level -lt 4) {
    try {
      if ($level -eq 0) {
        $outerHResult = $exception.HResult.ToString([Globalization.CultureInfo]::InvariantCulture)
      } elseif ($innerHResult -eq 'none') {
        $innerHResult = $exception.HResult.ToString([Globalization.CultureInfo]::InvariantCulture)
      }
      if ($exception -is [System.ComponentModel.Win32Exception] -and $nativeErrorCode -eq 'none') {
        $nativeErrorCode = $exception.NativeErrorCode.ToString([Globalization.CultureInfo]::InvariantCulture)
      }
      $exception = $exception.InnerException
    } catch {
      break
    }
    $level++
  }

  return "category=$category errorKind=$(Get-PreflightErrorKind $Record) line=$line outerHResult=$outerHResult innerHResult=$innerHResult nativeError=$nativeErrorCode"
}

function Get-ExecutableOperandEvidence(
  [object]$Value,
  [object]$PowerShellEnvironmentValue,
  [object]$ProcessEnvironmentValue
) {
  $valueKind = 'other'
  if ($null -eq $Value) { $valueKind = 'null' }
  elseif ($Value -is [string]) { $valueKind = 'string' }
  elseif ($Value -is [array]) { $valueKind = 'array' }
  $length = 0
  $nonblank = $false
  $fullyQualified = $false
  $localDrive = $false
  $hasControl = $false
  $hasDoubleQuote = $false
  $surroundingWhitespace = $false
  $matchesPowerShellEnvironment = $false
  $matchesProcessEnvironment = $false

  if ($Value -is [string]) {
    $length = $Value.Length
    $nonblank = -not [string]::IsNullOrWhiteSpace($Value)
    $surroundingWhitespace = $Value -cne $Value.Trim()
    $hasDoubleQuote = $Value.Contains('"')
    foreach ($character in $Value.ToCharArray()) {
      if ([char]::IsControl($character)) { $hasControl = $true; break }
    }
    try { $fullyQualified = [IO.Path]::IsPathFullyQualified($Value) } catch {}
    $localDrive = $Value -match '^[A-Za-z]:\\'
    $matchesPowerShellEnvironment = $PowerShellEnvironmentValue -is [string] -and
      [string]::Equals($Value, $PowerShellEnvironmentValue, [StringComparison]::Ordinal)
    $matchesProcessEnvironment = $PowerShellEnvironmentValue -is [string] -and
      $ProcessEnvironmentValue -is [string] -and
      [string]::Equals($PowerShellEnvironmentValue, $ProcessEnvironmentValue, [StringComparison]::Ordinal)
  }

  return [pscustomobject]@{
    ValueKind = $valueKind
    Length = $length
    Nonblank = $nonblank
    FullyQualified = $fullyQualified
    LocalDrive = $localDrive
    HasControl = $hasControl
    HasDoubleQuote = $hasDoubleQuote
    SurroundingWhitespace = $surroundingWhitespace
    MatchesPowerShellEnvironment = $matchesPowerShellEnvironment
    MatchesProcessEnvironment = $matchesProcessEnvironment
    Valid = $valueKind -eq 'string' -and $nonblank -and $fullyQualified -and $localDrive -and
      -not $hasControl -and -not $hasDoubleQuote -and -not $surroundingWhitespace -and
      $matchesPowerShellEnvironment -and $matchesProcessEnvironment
  }
}

function Get-ExecutableFileFailure([System.Management.Automation.ErrorRecord]$Record) {
  $exception = $Record.Exception
  $level = 0
  while ($null -ne $exception -and $level -lt 4) {
    if ($exception -is [System.UnauthorizedAccessException]) { return 'access-denied' }
    if ($exception -is [System.IO.FileNotFoundException] -or
        $exception -is [System.Management.Automation.ItemNotFoundException]) { return 'file-not-found' }
    if ($exception -is [System.IO.DirectoryNotFoundException]) { return 'directory-not-found' }
    if ($exception -is [System.IO.IOException]) { return 'io-error' }
    $exception = $exception.InnerException
    $level++
  }
  return 'other'
}

function Get-ExecutableFileEvidence([string]$Path, [bool]$InspectPe) {
  $regularFile = $false
  $reparsePoint = $false
  $readable = $false
  $failure = 'none'
  $peValid = $false
  $peMachine = 'none'
  $peFormat = 'none'
  $peSubsystem = 'none'
  $peFailure = 'none'
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $reparsePoint = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    $regularFile = -not $item.PSIsContainer -and -not $reparsePoint
    if (-not $regularFile) {
      $failure = 'path-unsafe'
    } else {
      $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
      try { $readable = $true } finally { $file.Dispose() }
      if ($InspectPe) {
        $pe = [WindowsHarnessNative]::InspectExecutable($Path)
        $peValid = $pe.Valid
        $peMachine = $pe.Machine
        $peFormat = $pe.OptionalHeader
        $peSubsystem = $pe.Subsystem
        $peFailure = $pe.FailureCode
      }
    }
  } catch {
    $failure = Get-ExecutableFileFailure $_
  }
  return [pscustomobject]@{
    RegularFile = $regularFile
    ReparsePoint = $reparsePoint
    Readable = $readable
    Failure = $failure
    PeValid = $peValid
    PeMachine = $peMachine
    PeFormat = $peFormat
    PeSubsystem = $peSubsystem
    PeFailure = $peFailure
  }
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

  $preflightStage = 'NODE_ENV_READ'
  $nodeEnvironmentValue = $env:REVO_NODE_EXE
  $nodeProcessEnvironmentValue = [Environment]::GetEnvironmentVariable('REVO_NODE_EXE', [EnvironmentVariableTarget]::Process)
  $node = $nodeEnvironmentValue
  $npmEnvironmentValue = $env:REVO_NPM_CMD
  $npmProcessEnvironmentValue = [Environment]::GetEnvironmentVariable('REVO_NPM_CMD', [EnvironmentVariableTarget]::Process)
  $npm = $npmEnvironmentValue
  $preflightStage = 'NODE_OPERAND_VALIDATE'
  $nodeOperand = Get-ExecutableOperandEvidence $node $nodeEnvironmentValue $nodeProcessEnvironmentValue
  $npmOperand = Get-ExecutableOperandEvidence $npm $npmEnvironmentValue $npmProcessEnvironmentValue
  Write-Output "WINDOWS_EXECUTABLE_CHILD name=node kind=$($nodeOperand.ValueKind) length=$($nodeOperand.Length) nonblank=$($nodeOperand.Nonblank.ToString().ToLowerInvariant()) fullyQualified=$($nodeOperand.FullyQualified.ToString().ToLowerInvariant()) localDrive=$($nodeOperand.LocalDrive.ToString().ToLowerInvariant()) hasControl=$($nodeOperand.HasControl.ToString().ToLowerInvariant()) hasDoubleQuote=$($nodeOperand.HasDoubleQuote.ToString().ToLowerInvariant()) surroundingWhitespace=$($nodeOperand.SurroundingWhitespace.ToString().ToLowerInvariant()) matchesPowerShellEnvironment=$($nodeOperand.MatchesPowerShellEnvironment.ToString().ToLowerInvariant()) matchesProcessEnvironment=$($nodeOperand.MatchesProcessEnvironment.ToString().ToLowerInvariant())"
  Write-Output "WINDOWS_EXECUTABLE_CHILD name=npm kind=$($npmOperand.ValueKind) length=$($npmOperand.Length) nonblank=$($npmOperand.Nonblank.ToString().ToLowerInvariant()) fullyQualified=$($npmOperand.FullyQualified.ToString().ToLowerInvariant()) localDrive=$($npmOperand.LocalDrive.ToString().ToLowerInvariant()) hasControl=$($npmOperand.HasControl.ToString().ToLowerInvariant()) hasDoubleQuote=$($npmOperand.HasDoubleQuote.ToString().ToLowerInvariant()) surroundingWhitespace=$($npmOperand.SurroundingWhitespace.ToString().ToLowerInvariant()) matchesPowerShellEnvironment=$($npmOperand.MatchesPowerShellEnvironment.ToString().ToLowerInvariant()) matchesProcessEnvironment=$($npmOperand.MatchesProcessEnvironment.ToString().ToLowerInvariant())"
  if (-not $nodeOperand.Valid -or -not $npmOperand.Valid) {
    Fail-Preflight 'executable environment value failed validation'
  }

  $preflightStage = 'NODE_FILE_VALIDATE'
  $nodeFile = Get-ExecutableFileEvidence $node $true
  $npmFile = Get-ExecutableFileEvidence $npm $false
  Write-Output "WINDOWS_EXECUTABLE_FILE name=node regularFile=$($nodeFile.RegularFile.ToString().ToLowerInvariant()) reparsePoint=$($nodeFile.ReparsePoint.ToString().ToLowerInvariant()) readable=$($nodeFile.Readable.ToString().ToLowerInvariant()) peValid=$($nodeFile.PeValid.ToString().ToLowerInvariant()) peMachine=$($nodeFile.PeMachine) peFormat=$($nodeFile.PeFormat) peSubsystem=$($nodeFile.PeSubsystem) peFailure=$($nodeFile.PeFailure) failure=$($nodeFile.Failure)"
  Write-Output "WINDOWS_EXECUTABLE_FILE name=npm regularFile=$($npmFile.RegularFile.ToString().ToLowerInvariant()) reparsePoint=$($npmFile.ReparsePoint.ToString().ToLowerInvariant()) readable=$($npmFile.Readable.ToString().ToLowerInvariant()) failure=$($npmFile.Failure)"
  if ($nodeFile.Failure -ne 'none' -or -not $nodeFile.RegularFile -or $nodeFile.ReparsePoint -or -not $nodeFile.Readable -or
      -not $nodeFile.PeValid -or $nodeFile.PeMachine -ne 'amd64' -or $nodeFile.PeFormat -ne 'pe32plus' -or $nodeFile.PeSubsystem -ne 'console' -or
      $npmFile.Failure -ne 'none' -or -not $npmFile.RegularFile -or $npmFile.ReparsePoint -or -not $npmFile.Readable) {
    Fail-Preflight 'executable file failed validation'
  }

  $preflightStage = 'NODE_METADATA_VALIDATE'
  $expectedNodeVersion = $env:REVO_EXPECTED_NODE_VERSION
  $expectedNpmVersion = $env:REVO_EXPECTED_NPM_VERSION
  if ($expectedNodeVersion -notmatch '^v\d+\.\d+\.\d+$' -or
      $expectedNpmVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    Fail-Preflight 'invalid tool-cache runtime metadata'
  }
  $preflightStage = 'NODE_INVOKE'
  $nodeInvocationEnvironment = Get-NodeInvocationEnvironmentEvidence
  $nodeExitBefore = Get-LastExitCodeEvidence
  $nodeOutput = @(& $node -p "process.version + '|' + process.platform + '|' + process.arch" 2>$null)
  $nodeInvokeSucceeded = $?
  $preflightStage = 'NODE_EXIT_READ'
  $nodeExitVariable = Get-Variable -Name LASTEXITCODE -ErrorAction SilentlyContinue
  $nodeExitPresent = $null -ne $nodeExitVariable
  $nodeExitType = 'none'
  $nodeExit = $null
  if ($nodeExitPresent) {
    if ($nodeExitVariable.Value -is [int32]) {
      $nodeExitType = 'int32'
    } else {
      $nodeExitType = 'other'
    }
    $nodeExit = $nodeExitVariable.Value
  }
  $nodeExitAfter = Get-LastExitCodeEvidence
  $preflightStage = 'NODE_OUTPUT_VALIDATE'
  $nodeOutputCount = $nodeOutput.Count
  $loggedNodeExit = $nodeExitAfter.Code
  $expectedNodeInfo = "$expectedNodeVersion|win32|x64"
  $loggedNodeExitBefore = $nodeExitBefore.Code
  Write-Output "NODE_PROBE_CONTEXT powershellVersion=$($nodeInvocationEnvironment.PowerShellVersion) runtimeVersion=$($nodeInvocationEnvironment.RuntimeVersion) pathextPresent=$($nodeInvocationEnvironment.PathExtPresent.ToString().ToLowerInvariant()) pathextState=$($nodeInvocationEnvironment.PathExtState) pathextLength=$($nodeInvocationEnvironment.PathExtLength) pathextHasExe=$($nodeInvocationEnvironment.PathExtHasExe.ToString().ToLowerInvariant()) pathextHasCmd=$($nodeInvocationEnvironment.PathExtHasCmd.ToString().ToLowerInvariant()) pathextExactExe=$($nodeInvocationEnvironment.PathExtExactExe.ToString().ToLowerInvariant()) argumentPassing=$($nodeInvocationEnvironment.ArgumentPassing) nativeErrorPreference=$($nodeInvocationEnvironment.ErrorActionPreference) lastExitBeforePresent=$($nodeExitBefore.Present.ToString().ToLowerInvariant()) lastExitBeforeType=$($nodeExitBefore.Type) lastExitBeforeCode=$loggedNodeExitBefore lastExitAfterPresent=$($nodeExitAfter.Present.ToString().ToLowerInvariant()) lastExitAfterType=$($nodeExitAfter.Type) lastExitAfterCode=$loggedNodeExit"
  Write-Output "NODE_PROBE invokeSucceeded=$($nodeInvokeSucceeded.ToString().ToLowerInvariant()) exitPresent=$($nodeExitPresent.ToString().ToLowerInvariant()) exitType=$nodeExitType exitCode=$loggedNodeExit outputCount=$nodeOutputCount"
  $preflightStage = 'NODE_OUTPUT_COMPARE'
  $nodeInfo = Assert-NodeRuntimeProbe `
    -InvokeSucceeded $nodeInvokeSucceeded `
    -ExitPresent $nodeExitPresent `
    -ExitType $nodeExitType `
    -ExitCode $nodeExit `
    -Output $nodeOutput `
    -Executable $node `
    -WorkingDirectory (Get-Location).ProviderPath `
    -ExpectedRuntime $expectedNodeInfo
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
  $errorRecord = $_
  $errorDiagnostic = 'category=unknown errorKind=other line=0 outerHResult=none innerHResult=none nativeError=none'
  try {
    $errorDiagnostic = Get-PreflightExceptionDiagnostic $errorRecord
  } catch {
  }
  [Console]::Error.WriteLine("WINDOWS_IDENTITY_PREFLIGHT_FAILED: code=PREFLIGHT_EXCEPTION stage=$preflightStage $errorDiagnostic")
  exit 90
}
