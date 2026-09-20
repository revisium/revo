#Requires -PSEdition Core
#Requires -Version 7.0

param(
  [Parameter(Mandatory)]
  [ValidateSet('runtime-null', 'runtime-file', 'direct', 'exit17')]
  [string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

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

function Get-SafeInvocationErrorKind([System.Management.Automation.ErrorRecord]$Record) {
  $identifier = [string]$Record.FullyQualifiedErrorId
  if ($identifier -match 'CommandNotFound') { return 'command-not-found' }
  if ($identifier -match 'NativeCommand') { return 'native-command' }
  $exception = $Record.Exception
  $level = 0
  while ($null -ne $exception -and $level -lt 4) {
    if ($exception -is [UnauthorizedAccessException]) { return 'access-denied' }
    if ($exception -is [IO.IOException]) { return 'io' }
    if ($exception -is [InvalidOperationException]) { return 'invalid-operation' }
    $exception = $exception.InnerException
    $level++
  }
  return 'other'
}

function Test-SameWindowsPath([string]$Left, [string]$Right) {
  try {
    $leftFull = [IO.Path]::GetFullPath($Left).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $rightFull = [IO.Path]::GetFullPath($Right).TrimEnd([IO.Path]::DirectorySeparatorChar)
    return [string]::Equals($leftFull, $rightFull, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Emit-Receipt($Receipt, [int]$ExitCode) {
  $json = ConvertTo-Json -InputObject $Receipt -Compress -Depth 4
  if ($json.Length -gt 8192) {
    [Console]::Error.WriteLine('WINDOWS_NODE_DIAGNOSTIC_RECEIPT_INVALID')
    exit 91
  }
  [Console]::Out.WriteLine("WINDOWS_NODE_DIAGNOSTIC_RECEIPT=$json")
  [Console]::Out.Flush()
  exit $ExitCode
}

[Console]::Out.WriteLine('RVW_NODE_DIAGNOSTIC_READY')
[Console]::Out.Flush()
if ([Console]::ReadLine() -cne 'GO') {
  [Console]::Error.WriteLine('WINDOWS_NODE_DIAGNOSTIC_NOT_AUTHORIZED')
  exit 91
}

$expectedSid = $env:REVO_EXPECTED_SID
$expectedProfile = $env:REVO_EXPECTED_PROFILE
$expectedWorkingDirectory = $env:REVO_FIXTURE_ROOT
$node = $env:REVO_NODE_EXE
$actualIdentitySid = 'none'
$identityMatch = $false
$profileMatch = $false
$cwdMatch = $false
$executableMatch = $false
try {
  $actualIdentitySid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $identityMatch = [string]::Equals($actualIdentitySid, $expectedSid, [StringComparison]::Ordinal)
  $actualProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $profileMatch = Test-SameWindowsPath $actualProfile $expectedProfile
  $cwdMatch = Test-SameWindowsPath (Get-Location).ProviderPath $expectedWorkingDirectory
  $nodeFile = Get-Item -LiteralPath $node -Force -ErrorAction Stop
  $nodeFullPath = [IO.Path]::GetFullPath($node)
  $executableMatch = $nodeFile -is [IO.FileInfo] -and
    ($nodeFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
    [string]::Equals($nodeFile.FullName, $nodeFullPath, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($nodeFullPath, $env:REVO_NODE_EXE, [StringComparison]::OrdinalIgnoreCase)
} catch {
  $identityMatch = $false
}

$pathExt = [Environment]::GetEnvironmentVariable('PATHEXT', [EnvironmentVariableTarget]::Process)
$extensions = @()
if ($null -ne $pathExt) {
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

$before = Get-LastExitCodeEvidence
$invokeSucceeded = $false
$outputCount = 0
$runtimeMatch = $false
$measurement = 'exception'
$exceptionKind = 'none'
$after = [pscustomobject]@{ Present = $false; Type = 'none'; Code = 'none' }
$stderrBytes = 0L
$stderrReadSucceeded = $true
$stderrTruncated = $false
$stderrCleanupConfirmed = $true
$directStarted = $false
$directExitObserved = $false
$directExitCode = 'none'
$directStdoutBytes = 0L
$directStderrBytes = 0L
$directStdoutEof = $false
$directStderrEof = $false
$directCleanupConfirmed = $false
$directFailure = 'not-run'

if (-not $identityMatch -or -not $profileMatch -or -not $cwdMatch -or -not $executableMatch -or
    [string]::IsNullOrWhiteSpace($node) -or -not [IO.Path]::IsPathFullyQualified($node)) {
  $receipt = [pscustomobject]@{
    schemaVersion = 1; mode = $Mode; measurement = 'exception'; exceptionKind = 'invalid-operation'
    identityMatch = $identityMatch; profileMatch = $profileMatch; cwdMatch = $cwdMatch; executableMatch = $executableMatch
    powershellVersion = $PSVersionTable.PSVersion.ToString(); runtimeVersion = [Environment]::Version.ToString()
    pathextPresent = $null -ne $pathExt; pathextHasExe = $extensions -contains '.EXE'; pathextHasCmd = $extensions -contains '.CMD'
    pathextExactExe = [string]::Equals($pathExt, '.EXE', [StringComparison]::OrdinalIgnoreCase)
    argumentPassing = $argumentPassing; nativeErrorPreference = $errorPreference
    lastExitBeforePresent = $before.Present; lastExitBeforeType = $before.Type; lastExitBeforeCode = $before.Code
    invokeSucceeded = $false; outputCount = 0; runtimeMatch = $false
    lastExitAfterPresent = $false; lastExitAfterType = 'none'; lastExitAfterCode = 'none'
    stderrBytes = 0; stderrReadSucceeded = $true; stderrTruncated = $false; stderrCleanupConfirmed = $true
    directStarted = $false; directExitObserved = $false; directExitCode = 'none'
    directStdoutBytes = 0; directStderrBytes = 0; directStdoutEof = $false; directStderrEof = $false
    directCleanupConfirmed = $false; directFailure = 'not-run'
  }
  Emit-Receipt $receipt 91
}

$expectedRuntime = "$env:REVO_EXPECTED_NODE_VERSION|win32|x64"
$stderrPath = $null
try {
  switch ($Mode) {
    'runtime-null' {
      $output = @(& $node -p "process.version + '|' + process.platform + '|' + process.arch" 2>$null)
      $invokeSucceeded = $?
      $after = Get-LastExitCodeEvidence
      $outputCount = $output.Count
      $runtimeMatch = $outputCount -eq 1 -and [string]::Equals([string]$output[0], $expectedRuntime, [StringComparison]::Ordinal)
      $exitMatch = $after.Present -and $after.Type -eq 'int32' -and $after.Code -eq '0'
      $measurement = if ($invokeSucceeded -and $runtimeMatch -and $exitMatch) { 'match' } else { 'mismatch' }
    }
    'runtime-file' {
      $stderrPath = Join-Path $env:TEMP ('revo-node-diagnostic-' + [Guid]::NewGuid().ToString('N') + '.stderr')
      $output = @(& $node -p "process.version + '|' + process.platform + '|' + process.arch" 2> $stderrPath)
      $invokeSucceeded = $?
      $after = Get-LastExitCodeEvidence
      $outputCount = $output.Count
      $runtimeMatch = $outputCount -eq 1 -and [string]::Equals([string]$output[0], $expectedRuntime, [StringComparison]::Ordinal)
      $exitMatch = $after.Present -and $after.Type -eq 'int32' -and $after.Code -eq '0'
      $measurement = if ($invokeSucceeded -and $runtimeMatch -and $exitMatch) { 'match' } else { 'mismatch' }
      if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
        $stderrBytes = (Get-Item -LiteralPath $stderrPath -Force -ErrorAction Stop).Length
        $stderrTruncated = $stderrBytes -gt 4096
        $stream = [IO.File]::OpenRead($stderrPath)
        try {
          $buffer = [byte[]]::new([int][Math]::Min(4096, $stderrBytes))
          $offset = 0
          while ($offset -lt $buffer.Length) {
            $read = $stream.Read($buffer, $offset, $buffer.Length - $offset)
            if ($read -le 0) { break }
            $offset += $read
          }
          $stderrReadSucceeded = $offset -eq $buffer.Length
        } finally {
          $stream.Dispose()
        }
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction Stop
        $stderrCleanupConfirmed = -not (Test-Path -LiteralPath $stderrPath)
      } else {
        $stderrReadSucceeded = $false
      }
    }
    'exit17' {
      $output = @(& $node -e "process.exit(17)" 2>$null)
      $invokeSucceeded = $?
      $after = Get-LastExitCodeEvidence
      $outputCount = $output.Count
      $runtimeMatch = $outputCount -eq 0
      $measurement = if (-not $invokeSucceeded -and $runtimeMatch -and $after.Present -and $after.Type -eq 'int32' -and $after.Code -eq '17') { 'match' } else { 'mismatch' }
    }
    'direct' {
      Add-Type -Path (Join-Path $PSScriptRoot 'windows-harness-native.cs') -ErrorAction Stop
      $direct = [WindowsHarnessNative]::ProbeNodeRuntimeDirect(
        $node,
        (Get-Location).ProviderPath,
        $expectedRuntime
      ).GetAwaiter().GetResult()
      $directStarted = $direct.Started
      $directExitObserved = $direct.ExitObserved
      if ($null -ne $direct.ExitCode) { $directExitCode = $direct.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture) }
      $directStdoutBytes = $direct.StandardOutputBytes
      $directStderrBytes = $direct.StandardErrorBytes
      $directStdoutEof = $direct.StandardOutputEof
      $directStderrEof = $direct.StandardErrorEof
      $directCleanupConfirmed = $direct.CleanupConfirmed
      $directFailure = $direct.FailureCode
      $runtimeMatch = $direct.RuntimeMatch
      $measurement = if ($direct.Started -and $direct.ExitObserved -and $direct.ExitCode -eq 0 -and
        $direct.RuntimeMatch -and $direct.CleanupConfirmed) { 'match' } else { 'mismatch' }
    }
  }
} catch {
  $measurement = 'exception'
  $exceptionKind = Get-SafeInvocationErrorKind $_
  $after = Get-LastExitCodeEvidence
  if ($null -ne $stderrPath -and (Test-Path -LiteralPath $stderrPath -PathType Leaf)) {
    try {
      $stderrBytes = (Get-Item -LiteralPath $stderrPath -Force -ErrorAction Stop).Length
      $stderrTruncated = $stderrBytes -gt 4096
      $stream = [IO.File]::OpenRead($stderrPath)
      try {
        $buffer = [byte[]]::new([int][Math]::Min(4096, $stderrBytes))
        $offset = 0
        while ($offset -lt $buffer.Length) {
          $read = $stream.Read($buffer, $offset, $buffer.Length - $offset)
          if ($read -le 0) { break }
          $offset += $read
        }
        $stderrReadSucceeded = $offset -eq $buffer.Length
      } finally {
        $stream.Dispose()
      }
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction Stop
      $stderrCleanupConfirmed = -not (Test-Path -LiteralPath $stderrPath)
    } catch {
      $stderrCleanupConfirmed = $false
      $stderrReadSucceeded = $false
    }
  }
}

$receipt = [pscustomobject]@{
  schemaVersion = 1; mode = $Mode; measurement = $measurement; exceptionKind = $exceptionKind
  identityMatch = $identityMatch; profileMatch = $profileMatch; cwdMatch = $cwdMatch; executableMatch = $executableMatch
  powershellVersion = $PSVersionTable.PSVersion.ToString(); runtimeVersion = [Environment]::Version.ToString()
  pathextPresent = $null -ne $pathExt; pathextHasExe = $extensions -contains '.EXE'; pathextHasCmd = $extensions -contains '.CMD'
  pathextExactExe = [string]::Equals($pathExt, '.EXE', [StringComparison]::OrdinalIgnoreCase)
  argumentPassing = $argumentPassing; nativeErrorPreference = $errorPreference
  lastExitBeforePresent = $before.Present; lastExitBeforeType = $before.Type; lastExitBeforeCode = $before.Code
  invokeSucceeded = $invokeSucceeded; outputCount = $outputCount; runtimeMatch = $runtimeMatch
  lastExitAfterPresent = $after.Present; lastExitAfterType = $after.Type; lastExitAfterCode = $after.Code
  stderrBytes = $stderrBytes; stderrReadSucceeded = $stderrReadSucceeded; stderrTruncated = $stderrTruncated
  stderrCleanupConfirmed = $stderrCleanupConfirmed
  directStarted = $directStarted; directExitObserved = $directExitObserved; directExitCode = $directExitCode
  directStdoutBytes = $directStdoutBytes; directStderrBytes = $directStderrBytes
  directStdoutEof = $directStdoutEof; directStderrEof = $directStderrEof
  directCleanupConfirmed = $directCleanupConfirmed; directFailure = $directFailure
}

$receiptExit = if ($measurement -eq 'match' -and $stderrReadSucceeded -and $stderrCleanupConfirmed) { 0 } elseif ($measurement -eq 'mismatch') { 90 } else { 91 }
Emit-Receipt $receipt $receiptExit
