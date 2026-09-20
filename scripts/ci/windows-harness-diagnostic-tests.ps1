#Requires -PSEdition Core
#Requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$harnessScript = Join-Path $PSScriptRoot 'windows-nonadmin.ps1'
$requiredFunctions = @(
  'Copy-FixtureEnvironment',
  'Test-FixtureEnvironmentEqual',
  'Get-FixtureEnvironmentDelta',
  'Test-WindowsNodeExitEvidence',
  'ConvertFrom-WindowsNodeDiagnosticReceipt',
  'Test-WindowsNodeDiagnosticSupervision',
  'Invoke-WindowsNodeInvocationDiagnostics',
  'New-WindowsNodeDiagnosticBootstrap',
  'Get-WindowsNodeDiagnosticGate',
  'Invoke-WindowsNodeDiagnosticsFailClosed'
)

function Assert-DiagnosticTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "WINDOWS_HARNESS_DIAGNOSTIC_TEST_FAILED: $Message" }
}

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($harnessScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'WINDOWS_HARNESS_DIAGNOSTIC_TEST_FAILED: harness parse failed' }
$definitions = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $requiredFunctions -contains $node.Name
  }, $true)
$found = @{}
foreach ($definition in $definitions) { $found[$definition.Name] = $definition.Extent.Text }
foreach ($name in $requiredFunctions) {
  if (-not $found.ContainsKey($name)) { throw "WINDOWS_HARNESS_DIAGNOSTIC_TEST_FAILED: missing function $name" }
  Invoke-Expression $found[$name]
}
if ($IsWindows -and $null -eq ('WindowsHarnessNative' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-harness-native.cs') -ErrorAction Stop
}
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=production-function-extraction result=PASS'

function New-TestNodeReceipt(
  [string]$Mode,
  [string]$Case,
  [bool]$Match,
  [bool]$DirectCleanup = $true
) {
  $afterPresent = $false
  $afterType = 'none'
  $afterCode = 'none'
  $invokeSucceeded = $false
  $outputCount = 0
  $runtimeMatch = $false
  $directFailure = 'not-run'
  $directStarted = $false
  $directExitObserved = $false
  $directExitCode = 'none'
  $directStdoutEof = $false
  $directStderrEof = $false
  $directCleanupConfirmed = $false
  $directStdoutBytes = [long]0
  $directStderrBytes = [long]0
  if ($Mode -in @('runtime-null', 'runtime-file')) {
    $invokeSucceeded = $Match
    $outputCount = if ($Match) { 1 } else { 0 }
    $runtimeMatch = $Match
    if ($Match) { $afterPresent = $true; $afterType = 'int32'; $afterCode = '0' }
  } elseif ($Mode -eq 'exit17') {
    $invokeSucceeded = -not $Match
    $runtimeMatch = $Match
    if ($Match) { $afterPresent = $true; $afterType = 'int32'; $afterCode = '17' }
  } elseif ($Mode -eq 'direct') {
    $runtimeMatch = $Match
    $directStarted = $true
    $directExitObserved = $true
    $directExitCode = '0'
    $directStdoutEof = $true
    $directStderrEof = $true
    $directCleanupConfirmed = $DirectCleanup
    $directStdoutBytes = [long]18
    $directFailure = if ($Match) { 'none' } else { 'runtime-output-mismatch' }
  }
  return [ordered]@{
    schemaVersion = [long]1
    mode = $Mode
    measurement = if ($Match) { 'match' } else { 'mismatch' }
    exceptionKind = 'none'
    identityMatch = $true
    profileMatch = $true
    cwdMatch = $true
    executableMatch = $true
    powershellVersion = '7.6.5'
    runtimeVersion = '10.0.11'
    pathextPresent = $Case -in @('B', 'E')
    pathextHasExe = $Case -in @('B', 'E')
    pathextHasCmd = $false
    pathextExactExe = $Case -in @('B', 'E')
    argumentPassing = 'Windows'
    nativeErrorPreference = 'false'
    lastExitBeforePresent = $false
    lastExitBeforeType = 'none'
    lastExitBeforeCode = 'none'
    invokeSucceeded = $invokeSucceeded
    outputCount = $outputCount
    runtimeMatch = $runtimeMatch
    lastExitAfterPresent = $afterPresent
    lastExitAfterType = $afterType
    lastExitAfterCode = $afterCode
    stderrBytes = [long]0
    stderrReadSucceeded = $true
    stderrTruncated = $false
    stderrCleanupConfirmed = $true
    directStarted = $directStarted
    directExitObserved = $directExitObserved
    directExitCode = $directExitCode
    directStdoutBytes = $directStdoutBytes
    directStderrBytes = $directStderrBytes
    directStdoutEof = $directStdoutEof
    directStderrEof = $directStderrEof
    directCleanupConfirmed = $directCleanupConfirmed
    directFailure = $directFailure
  }
}

function New-TestRunResult([object]$Receipt, [int]$ExitCode) {
  $json = ConvertTo-Json -InputObject $Receipt -Compress -Depth 4
  return [pscustomobject]@{
    StandardOutput = "RVW_NODE_DIAGNOSTIC_READY`nWINDOWS_NODE_DIAGNOSTIC_RECEIPT=$json`n"
    StandardError = ''
    ExitCode = $ExitCode
  }
}

$baseEnvironment = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
$baseEnvironment['SystemRoot'] = 'C:\Windows'
$baseEnvironment['Path'] = 'C:\Windows\System32;C:\node'
$baseEnvironment['REVO_NODE_EXE'] = 'C:\node\node.exe'
$baselineCopy = Copy-FixtureEnvironment $baseEnvironment
$expectedBaselineCopy = Copy-FixtureEnvironment $baseEnvironment
Assert-DiagnosticTest (Test-FixtureEnvironmentEqual $baselineCopy $expectedBaselineCopy) 'copy/equality did not accept equivalent generic dictionaries'
$pathextCopy = Copy-FixtureEnvironment $baseEnvironment
$pathextCopy['PATHEXT'] = '.EXE'
Assert-DiagnosticTest ((Get-FixtureEnvironmentDelta $baselineCopy $pathextCopy $true) -ceq 'pathext-only') 'PATHEXT-only delta was not recognized'
Assert-DiagnosticTest ((Get-FixtureEnvironmentDelta $baselineCopy $pathextCopy $false) -ceq 'invalid') 'unexpected PATHEXT change was accepted'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=environment-dictionary-and-delta result=PASS'

function Write-TestZipArchive([string]$Path, [string[]]$EntryNames, [byte[]]$Bytes) {
  $fileStream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $archive = $null
  try {
    $archive = [IO.Compression.ZipArchive]::new($fileStream, [IO.Compression.ZipArchiveMode]::Create, $true)
    foreach ($name in $EntryNames) {
      $entry = $archive.CreateEntry($name)
      $entryStream = $entry.Open()
      try { $entryStream.Write($Bytes, 0, $Bytes.Length) } finally { $entryStream.Dispose() }
    }
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    $fileStream.Dispose()
  }
}

$bootstrapTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('revo-node-diagnostic-test-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $bootstrapTestRoot -ErrorAction Stop)
try {
  $entryBytes = [Text.UTF8Encoding]::new($false).GetBytes("# diagnostic bootstrap test`n")
  $expectedEntryHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($entryBytes)).ToLowerInvariant()
  $validArchivePath = Join-Path $bootstrapTestRoot 'valid.zip'
  $validBootstrap = Join-Path $bootstrapTestRoot 'valid-bootstrap'
  [void](New-Item -ItemType Directory -Path $validBootstrap)
  Write-TestZipArchive $validArchivePath @('scripts/ci/windows-node-invocation-diagnostic.ps1') $entryBytes
  $validArchiveHash = (Get-FileHash -LiteralPath $validArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $validBootstrapResult = New-WindowsNodeDiagnosticBootstrap $validArchivePath $validArchiveHash $validBootstrap
  Assert-DiagnosticTest ($validBootstrapResult.Ready -and $validBootstrapResult.Reason -eq 'none' -and $validBootstrapResult.ScriptSha256 -ceq $expectedEntryHash) 'valid archive entry was not extracted and hashed'
  Assert-DiagnosticTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($validBootstrapResult.Path)) -ceq [Convert]::ToBase64String($entryBytes)) 'bootstrap copy did not preserve the exact archive bytes'

  $hashMismatchBootstrap = Join-Path $bootstrapTestRoot 'hash-mismatch-bootstrap'
  [void](New-Item -ItemType Directory -Path $hashMismatchBootstrap)
  $hashMismatch = New-WindowsNodeDiagnosticBootstrap $validArchivePath ('0' * 64) $hashMismatchBootstrap
  Assert-DiagnosticTest (-not $hashMismatch.Ready -and $hashMismatch.Reason -eq 'archive-hash-mismatch') 'archive hash mismatch was accepted'

  $missingArchivePath = Join-Path $bootstrapTestRoot 'missing.zip'
  $missingBootstrap = Join-Path $bootstrapTestRoot 'missing-bootstrap'
  [void](New-Item -ItemType Directory -Path $missingBootstrap)
  Write-TestZipArchive $missingArchivePath @('other/file.txt') $entryBytes
  $missingArchiveHash = (Get-FileHash -LiteralPath $missingArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $missingEntry = New-WindowsNodeDiagnosticBootstrap $missingArchivePath $missingArchiveHash $missingBootstrap
  Assert-DiagnosticTest (-not $missingEntry.Ready -and $missingEntry.Reason -eq 'entry-missing') 'missing archive entry was accepted'

  $duplicateArchivePath = Join-Path $bootstrapTestRoot 'duplicate.zip'
  $duplicateBootstrap = Join-Path $bootstrapTestRoot 'duplicate-bootstrap'
  [void](New-Item -ItemType Directory -Path $duplicateBootstrap)
  Write-TestZipArchive $duplicateArchivePath @(
    'scripts/ci/windows-node-invocation-diagnostic.ps1',
    'scripts/ci/windows-node-invocation-diagnostic.ps1'
  ) $entryBytes
  $duplicateArchiveHash = (Get-FileHash -LiteralPath $duplicateArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $duplicateEntry = New-WindowsNodeDiagnosticBootstrap $duplicateArchivePath $duplicateArchiveHash $duplicateBootstrap
  Assert-DiagnosticTest (-not $duplicateEntry.Ready -and $duplicateEntry.Reason -eq 'entry-duplicate') 'duplicate archive entries were accepted'

  $corruptArchivePath = Join-Path $bootstrapTestRoot 'corrupt.zip'
  $corruptBootstrap = Join-Path $bootstrapTestRoot 'corrupt-bootstrap'
  [void](New-Item -ItemType Directory -Path $corruptBootstrap)
  [IO.File]::WriteAllBytes($corruptArchivePath, [Text.Encoding]::ASCII.GetBytes('not-a-zip'))
  $corruptArchiveHash = (Get-FileHash -LiteralPath $corruptArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $corruptArchive = New-WindowsNodeDiagnosticBootstrap $corruptArchivePath $corruptArchiveHash $corruptBootstrap
  Assert-DiagnosticTest (-not $corruptArchive.Ready -and $corruptArchive.Reason -eq 'archive-invalid') 'corrupt archive was accepted'

  $existingBootstrap = Join-Path $bootstrapTestRoot 'existing-bootstrap'
  [void](New-Item -ItemType Directory -Path $existingBootstrap)
  $existingDestination = Join-Path $existingBootstrap 'windows-node-invocation-diagnostic.ps1'
  $existingBytes = [Text.Encoding]::ASCII.GetBytes('preserve-existing')
  [IO.File]::WriteAllBytes($existingDestination, $existingBytes)
  $existing = New-WindowsNodeDiagnosticBootstrap $validArchivePath $validArchiveHash $existingBootstrap
  Assert-DiagnosticTest (-not $existing.Ready -and $existing.Reason -eq 'destination-exists') 'existing bootstrap destination was overwritten'
  Assert-DiagnosticTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($existingDestination)) -ceq [Convert]::ToBase64String($existingBytes)) 'existing destination content changed'
  Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=archive-bootstrap-provenance result=PASS'
} finally {
  Remove-Item -LiteralPath $bootstrapTestRoot -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $bootstrapTestRoot) { throw 'WINDOWS_HARNESS_DIAGNOSTIC_TEST_FAILED: archive fixture cleanup unconfirmed' }
}

$validB = New-TestRunResult (New-TestNodeReceipt 'runtime-null' 'B' $true) 0
$parsedB = ConvertFrom-WindowsNodeDiagnosticReceipt $validB 'runtime-null' 'B'
Assert-DiagnosticTest ($parsedB.Valid -and $parsedB.Receipt.schemaVersion -eq 1) 'valid Int64 JSON schema version was rejected'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=json-roundtrip-int64 result=PASS'

$contradictoryReceipt = New-TestNodeReceipt 'runtime-null' 'B' $true
$contradictoryReceipt.lastExitAfterCode = '17'
$contradictory = ConvertFrom-WindowsNodeDiagnosticReceipt (New-TestRunResult $contradictoryReceipt 0) 'runtime-null' 'B'
Assert-DiagnosticTest (-not $contradictory.Valid) 'contradictory successful runtime receipt was accepted'

$malformed = [pscustomobject]@{
  StandardOutput = "RVW_NODE_DIAGNOSTIC_READY`nWINDOWS_NODE_DIAGNOSTIC_RECEIPT={malformed}`n"
  StandardError = ''
  ExitCode = 90
}
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt $malformed 'runtime-null' 'A').Valid) 'malformed JSON escaped validation'

$duplicate = [pscustomobject]@{
  StandardOutput = $validB.StandardOutput + ($validB.StandardOutput -split "`n" | Where-Object { $_ -like 'WINDOWS_NODE_DIAGNOSTIC_RECEIPT=*' })[0] + "`n"
  StandardError = ''
  ExitCode = 0
}
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt $duplicate 'runtime-null' 'B').Valid) 'duplicate receipt line was accepted'

$duplicatePropertyOutput = [regex]::Replace(
  $validB.StandardOutput,
  '"schemaVersion":\s*1',
  '"schemaVersion":9,"schemaVersion":1',
  [Text.RegularExpressions.RegexOptions]::CultureInvariant
)
$duplicatePropertyResult = [pscustomobject]@{ StandardOutput = $duplicatePropertyOutput; StandardError = ''; ExitCode = [int]0 }
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt $duplicatePropertyResult 'runtime-null' 'B').Valid) 'duplicate JSON property name was accepted'

$newlineReceipt = New-TestNodeReceipt 'runtime-null' 'B' $true
$newlineReceipt.powershellVersion = "7.6.5`nSENTINEL"
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt (New-TestRunResult $newlineReceipt 0) 'runtime-null' 'B').Valid) 'newline-bearing version field was accepted'

$unsafeDirectReceipt = New-TestNodeReceipt 'direct' 'D' $true $false
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt (New-TestRunResult $unsafeDirectReceipt 0) 'direct' 'D').Valid) 'direct probe without confirmed cleanup was accepted'
$oversizedDirectReceipt = New-TestNodeReceipt 'direct' 'D' $true
$oversizedDirectReceipt.directExitCode = '2147483648'
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt (New-TestRunResult $oversizedDirectReceipt 0) 'direct' 'D').Valid) 'out-of-range direct exit code was accepted'
$sentinelOutsideDirect = New-TestNodeReceipt 'runtime-null' 'B' $true
$sentinelOutsideDirect.directFailure = 'SENTINEL_LOG_FIELD'
Assert-DiagnosticTest (-not (ConvertFrom-WindowsNodeDiagnosticReceipt (New-TestRunResult $sentinelOutsideDirect 0) 'runtime-null' 'B').Valid) 'non-D direct failure field was accepted'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=receipt-rejects-invalid-and-contradictory result=PASS'

$expectedSid = 'S-1-5-21-1-2-3-1001'
$expectedProfile = if ($IsWindows) {
  Join-Path ([IO.Path]::GetFullPath($env:TEMP)) 'revo-diagnostic-profile'
} else {
  '/fixture/profile'
}
$fakeToken = [pscustomobject]@{
  Sid = $expectedSid
  ProfilePath = $expectedProfile
  IntegritySid = 'S-1-16-8192'
  IsElevated = $false
  ElevationType = 1
  HasAdministratorsSid = $false
  ProfileHiveLoaded = $true
}
$baselineFailureMarker = 'WINDOWS_IDENTITY_PREFLIGHT_FAILED: Node runtime probe failed'
$fakeBaseline = [pscustomobject]@{
  ExitCode = [int]90
  TimedOut = $false
  CleanupConfirmed = $true
  FailureCode = $null
  CleanupFailureCode = $null
  ExitObserved = $true
  GoAttempted = $true
  GoSent = $true
  EnvironmentValidated = $true
  Token = $fakeToken
  StandardOutput = ''
  StandardError = "$baselineFailureMarker`r`n"
}
if ($IsWindows) {
  $realToken = [WindowsHarnessTokenReport]::new()
  $realToken.Sid = $expectedSid
  $realToken.ProfilePath = $expectedProfile
  $realToken.IntegritySid = 'S-1-16-8192'
  $realToken.IsElevated = $false
  $realToken.ElevationType = 1
  $realToken.HasAdministratorsSid = $false
  $realToken.ProfileHiveLoaded = $true
  $fakeBaseline = [WindowsHarnessRunResult]::new()
  $fakeBaseline.ExitCode = 90
  $fakeBaseline.TimedOut = $false
  $fakeBaseline.CleanupConfirmed = $true
  $fakeBaseline.FailureCode = $null
  $fakeBaseline.CleanupFailureCode = $null
  $fakeBaseline.ExitObserved = $true
  $fakeBaseline.GoAttempted = $true
  $fakeBaseline.GoSent = $true
  $fakeBaseline.EnvironmentValidated = $true
  $fakeBaseline.Token = $realToken
  $fakeBaseline.StandardOutput = ''
  $fakeBaseline.StandardError = "$baselineFailureMarker`r`n"
  Assert-DiagnosticTest (Test-WindowsNodeDiagnosticSupervision $fakeBaseline $expectedSid $expectedProfile) 'actual C# RunAsUser result schema was rejected'
  Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=real-csharp-supervisor-contract result=PASS'
}
$gate = Get-WindowsNodeDiagnosticGate $fakeBaseline $true $expectedSid $expectedProfile
Assert-DiagnosticTest ($gate.TargetFailure -and $gate.ShouldRun -and $gate.Reason -eq 'none') 'exact baseline Node failure was not selected'
$nearMissBaseline = [pscustomobject]@{
  ExitCode = [int]90; TimedOut = $false; CleanupConfirmed = $true; FailureCode = $null; CleanupFailureCode = $null
  ExitObserved = $true; GoAttempted = $true; GoSent = $true; EnvironmentValidated = $true; Token = $fakeToken
  StandardOutput = ''; StandardError = "$baselineFailureMarker extra`n"
}
Assert-DiagnosticTest (-not (Get-WindowsNodeDiagnosticGate $nearMissBaseline $true $expectedSid $expectedProfile).ShouldRun) 'near-match marker was accepted'
$wrongExitBaseline = [pscustomobject]@{
  ExitCode = [int]89; TimedOut = $false; CleanupConfirmed = $true; FailureCode = $null; CleanupFailureCode = $null
  ExitObserved = $true; GoAttempted = $true; GoSent = $true; EnvironmentValidated = $true; Token = $fakeToken
  StandardOutput = ''; StandardError = "$baselineFailureMarker`n"
}
Assert-DiagnosticTest (-not (Get-WindowsNodeDiagnosticGate $wrongExitBaseline $true $expectedSid $expectedProfile).TargetFailure) 'non-90 baseline exit was accepted'
$unverifiedGate = Get-WindowsNodeDiagnosticGate $fakeBaseline $false $expectedSid $expectedProfile
Assert-DiagnosticTest ($unverifiedGate.TargetFailure -and -not $unverifiedGate.ShouldRun -and $unverifiedGate.Reason -eq 'diagnostic-bootstrap-unverified') 'unverified bootstrap did not block diagnostics'
$successfulAttempt = Invoke-WindowsNodeDiagnosticsFailClosed 90 $gate { [pscustomobject]@{ Complete = $true; RetentionRequired = $false } }
Assert-DiagnosticTest ($successfulAttempt.ExitCode -eq 90 -and $successfulAttempt.Complete -and -not $successfulAttempt.RetentionRequired) 'successful diagnostics changed baseline exit 90 or retained unnecessarily'
$throwingAttempt = Invoke-WindowsNodeDiagnosticsFailClosed 90 $gate { throw 'SENTINEL_DIAGNOSTIC_EXCEPTION' }
Assert-DiagnosticTest ($throwingAttempt.ExitCode -eq 90 -and -not $throwingAttempt.Complete -and $throwingAttempt.RetentionRequired -and $throwingAttempt.Reason -eq 'diagnostic-exception') 'runner exception changed exit 90 or did not retain'
$invalidResultAttempt = Invoke-WindowsNodeDiagnosticsFailClosed 90 $gate { [pscustomobject]@{ Complete = $false; RetentionRequired = $true } }
Assert-DiagnosticTest ($invalidResultAttempt.ExitCode -eq 90 -and -not $invalidResultAttempt.Complete -and $invalidResultAttempt.RetentionRequired) 'invalid/parser result changed exit 90 or did not retain'
$invokerCalls = 0
$provenanceFailureAttempt = Invoke-WindowsNodeDiagnosticsFailClosed 90 $unverifiedGate { $invokerCalls++; [pscustomobject]@{ Complete = $true; RetentionRequired = $false } }
Assert-DiagnosticTest ($provenanceFailureAttempt.ExitCode -eq 90 -and $provenanceFailureAttempt.RetentionRequired -and $invokerCalls -eq 0) 'provenance failure ran diagnostics or changed exit 90'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=baseline-exit-and-retention-invariant result=PASS'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=exact-baseline-gate result=PASS'

$callState = [pscustomobject]@{ Count = 0; Calls = [System.Collections.Generic.List[object]]::new(); MutateFirst = $false; ThrowFirst = $false; LastResult = $null }
$caseNames = @('A', 'B', 'A2', 'C', 'D', 'E')
$caseMatches = @{ A = $false; B = $true; A2 = $false; C = $false; D = $true; E = $true }
$runner = {
  param($Executable, $Arguments, $WorkingDirectory, $Environment, $ReadySeconds, $ExecutionSeconds, $CleanupSeconds)
  $callState.Count++
  $caseName = $caseNames[$callState.Count - 1]
  $callState.Calls.Add([pscustomobject]@{
      Executable = $Executable
      Arguments = @($Arguments)
      WorkingDirectory = $WorkingDirectory
      Environment = Copy-FixtureEnvironment $Environment
      ReadySeconds = $ReadySeconds
      ExecutionSeconds = $ExecutionSeconds
      CleanupSeconds = $CleanupSeconds
    })
  if ($callState.ThrowFirst -and $callState.Count -eq 1) { throw 'SENTINEL_RUNNER_EXCEPTION' }
  $exitCode = if ($caseMatches[$caseName]) { 0 } else { 90 }
  $result = New-TestRunResult (New-TestNodeReceipt $Arguments[-1] $caseName $caseMatches[$caseName]) $exitCode
  if ($callState.MutateFirst -and $callState.Count -eq 1) { $Environment['INJECTED'] = 'mutation' }
  $supervisedResult = [pscustomobject]@{
    FailureCode = ''
    CleanupFailureCode = ''
    ExitObserved = $true
    GoAttempted = $true
    GoSent = $true
    TimedOut = $false
    CleanupConfirmed = $true
    EnvironmentValidated = $true
    Token = $fakeToken
    StandardOutput = $result.StandardOutput
    StandardError = $result.StandardError
    ExitCode = $result.ExitCode
  }
  $callState.LastResult = $supervisedResult
  return $supervisedResult
}.GetNewClosure()

$diagnosticPath = Join-Path $PSScriptRoot 'windows-node-invocation-diagnostic.ps1'
$diagnosticOutput = @(Invoke-WindowsNodeInvocationDiagnostics `
    -BaseEnvironment $baseEnvironment `
    -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe' `
    -DiagnosticScriptPath $diagnosticPath `
    -WorkingDirectory 'C:\fixture\workspace' `
    -ExpectedSid $expectedSid `
    -ExpectedProfile $expectedProfile `
    -Runner $runner `
    -SourceSha ('a' * 40) `
    -TreeSha ('b' * 40) `
    -ArchiveSha256 ('c' * 64) `
    -DiagnosticScriptHashMatch $true `
    -RunId '123456' `
    -RunAttempt '1')
Assert-DiagnosticTest ($diagnosticOutput.Count -eq 1 -and $diagnosticOutput[0] -is [pscustomobject]) 'orchestrator leaked output strings alongside its result object'
Assert-DiagnosticTest (Test-WindowsNodeDiagnosticSupervision $callState.LastResult $expectedSid $expectedProfile) ("fake runner result failed supervisor validation: callCount=$($callState.Count) result=" + (ConvertTo-Json -InputObject $callState.LastResult -Compress -Depth 4))
$diagnosticResult = $diagnosticOutput[0]
Assert-DiagnosticTest ($diagnosticResult.Complete -and -not $diagnosticResult.RetentionRequired -and $diagnosticResult.Cases.Count -eq 6) 'valid six-case experiment did not complete'
Assert-DiagnosticTest ($callState.Count -eq 6) 'not all six experiments were run'
Assert-DiagnosticTest ((Test-FixtureEnvironmentEqual $baseEnvironment $expectedBaselineCopy)) 'orchestrator mutated its baseline environment'
$argA = ConvertTo-Json -InputObject $callState.Calls[0].Arguments -Compress
$argB = ConvertTo-Json -InputObject $callState.Calls[1].Arguments -Compress
$argA2 = ConvertTo-Json -InputObject $callState.Calls[2].Arguments -Compress
Assert-DiagnosticTest ($argA -ceq $argB -and $argA -ceq $argA2) 'A/B/A2 did not use identical argv'
Assert-DiagnosticTest ($callState.Calls[0].Environment.ContainsKey('PATHEXT') -eq $false -and
  $callState.Calls[1].Environment.ContainsKey('PATHEXT') -and
  $callState.Calls[2].Environment.ContainsKey('PATHEXT') -eq $false) 'A/B/A2 environment delta was not isolated'
foreach ($call in $callState.Calls) {
  Assert-DiagnosticTest ($call.ReadySeconds -eq 30 -and $call.ExecutionSeconds -eq 30 -and $call.CleanupSeconds -eq 15) 'supervised timeouts changed'
  Assert-DiagnosticTest ($call.WorkingDirectory -ceq 'C:\fixture\workspace' -and $call.Executable -ceq 'C:\Program Files\PowerShell\7\pwsh.exe') 'runner contract lost executable or cwd'
}
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=ab-a2-and-single-result result=PASS'

$callState.Count = 0
$callState.Calls.Clear()
$callState.LastResult = $null
$caseMatches.B = $false
$bMismatchOutput = @(Invoke-WindowsNodeInvocationDiagnostics `
    -BaseEnvironment $baseEnvironment `
    -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe' `
    -DiagnosticScriptPath $diagnosticPath `
    -WorkingDirectory 'C:\fixture\workspace' `
    -ExpectedSid $expectedSid `
    -ExpectedProfile $expectedProfile `
    -Runner $runner `
    -SourceSha ('a' * 40) `
    -TreeSha ('b' * 40) `
    -ArchiveSha256 ('c' * 64) `
    -DiagnosticScriptHashMatch $true `
    -RunId '123456' `
    -RunAttempt '1')
Assert-DiagnosticTest ($bMismatchOutput.Count -eq 1 -and $bMismatchOutput[0].Complete) 'B mismatch did not produce a complete bounded experiment'
Assert-DiagnosticTest ($callState.Count -eq 5 -and $bMismatchOutput[0].Cases[5].Measurement -eq 'skipped' -and $bMismatchOutput[0].Cases[5].Supervision -eq 'not-run') 'E was not skipped after B mismatch'
$caseMatches.B = $true
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=b-mismatch-skips-e result=PASS'

$callState.Count = 0
$callState.Calls.Clear()
$callState.MutateFirst = $true
$mutationOutput = @(Invoke-WindowsNodeInvocationDiagnostics `
    -BaseEnvironment $baseEnvironment `
    -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe' `
    -DiagnosticScriptPath $diagnosticPath `
    -WorkingDirectory 'C:\fixture\workspace' `
    -ExpectedSid $expectedSid `
    -ExpectedProfile $expectedProfile `
    -Runner $runner `
    -SourceSha ('a' * 40) `
    -TreeSha ('b' * 40) `
    -ArchiveSha256 ('c' * 64) `
    -DiagnosticScriptHashMatch $true `
    -RunId '123456' `
    -RunAttempt '1')
Assert-DiagnosticTest ($mutationOutput.Count -eq 1 -and -not $mutationOutput[0].Complete -and $mutationOutput[0].StopReason -eq 'receipt-invalid') 'candidate environment mutation was not rejected'
Assert-DiagnosticTest ($callState.Count -eq 1) 'environment mutation did not stop subsequent cases'
Assert-DiagnosticTest (Test-FixtureEnvironmentEqual $baseEnvironment $expectedBaselineCopy) 'candidate mutation escaped into the baseline'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=candidate-mutation-fail-stop result=PASS'

$callState.Count = 0
$callState.Calls.Clear()
$callState.MutateFirst = $false
$callState.ThrowFirst = $true
$exceptionOutput = @(Invoke-WindowsNodeInvocationDiagnostics `
    -BaseEnvironment $baseEnvironment `
    -PowerShellPath 'C:\Program Files\PowerShell\7\pwsh.exe' `
    -DiagnosticScriptPath $diagnosticPath `
    -WorkingDirectory 'C:\fixture\workspace' `
    -ExpectedSid $expectedSid `
    -ExpectedProfile $expectedProfile `
    -Runner $runner `
    -SourceSha ('a' * 40) `
    -TreeSha ('b' * 40) `
    -ArchiveSha256 ('c' * 64) `
    -DiagnosticScriptHashMatch $true `
    -RunId '123456' `
    -RunAttempt '1')
Assert-DiagnosticTest ($exceptionOutput.Count -eq 1 -and -not $exceptionOutput[0].Complete -and $exceptionOutput[0].StopReason -eq 'runner-threw') 'runner exception did not fail closed'
Assert-DiagnosticTest ($callState.Count -eq 1) 'runner exception did not stop subsequent cases'
Assert-DiagnosticTest (-not ($exceptionOutput | Out-String).Contains('SENTINEL_RUNNER_EXCEPTION')) 'runner exception text leaked'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TEST case=runner-exception-fail-stop result=PASS'
Write-Output 'WINDOWS_HARNESS_DIAGNOSTIC_TESTS=PASS'
