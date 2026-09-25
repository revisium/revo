#Requires -PSEdition Core
#Requires -Version 7.0

param(
  [Parameter()]
  [ValidateSet('original-success', 'direct-success', 'direct-throws', 'formatter-throws', 'missing-exit', 'wrong-exit-type', 'nonzero-exit', 'runtime-mismatch')]
  [string]$ChildCase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identityScript = Join-Path $PSScriptRoot 'windows-identity-run.ps1'
$requiredFunctions = @('Fail-Preflight', 'Write-NodeDirectProbeReceipt', 'Assert-NodeRuntimeProbe')

function Assert-BranchTest([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "WINDOWS_NODE_BRANCH_TEST_FAILED: $Message" }
}

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($identityScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'WINDOWS_NODE_BRANCH_TEST_FAILED: production script parse failed' }
$definitions = $ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      $requiredFunctions -contains $node.Name
  }, $true)
$found = @{}
foreach ($definition in $definitions) { $found[$definition.Name] = $definition.Extent.Text }
foreach ($name in $requiredFunctions) {
  if (-not $found.ContainsKey($name)) { throw "WINDOWS_NODE_BRANCH_TEST_FAILED: missing production function $name" }
}
foreach ($name in $requiredFunctions) { Invoke-Expression $found[$name] }
$identitySource = [IO.File]::ReadAllText($identityScript)
$assertCallIndex = $identitySource.IndexOf('$nodeInfo = Assert-NodeRuntimeProbe', [StringComparison]::Ordinal)
$npmStageIndex = $identitySource.IndexOf("`$preflightStage = 'NPM_INVOKE'", [StringComparison]::Ordinal)
$directCalls = [regex]::Matches($identitySource, 'WindowsHarnessNative\]::ProbeNodeRuntimeDirect').Count
Assert-BranchTest ($assertCallIndex -ge 0 -and $npmStageIndex -gt $assertCallIndex) 'production does not validate the saved Node result before npm'
Assert-BranchTest ($found['Assert-NodeRuntimeProbe'].Contains('ProbeNodeRuntimeDirect') -and $directCalls -eq 1) 'production direct diagnostic is not confined to the decision function'
Write-Output 'WINDOWS_NODE_BRANCH_TEST case=production-wiring result=PASS'

function Invoke-BranchChild([string]$CaseName) {
  if ($CaseName -eq 'formatter-throws') {
    Remove-Item Function:\Write-NodeDirectProbeReceipt -ErrorAction Stop
    function Write-NodeDirectProbeReceipt([object]$Probe) {
      throw 'SENTINEL_FORMATTER_ERROR'
    }
  }

  $invocationSucceeded = $CaseName -eq 'original-success'
  $exitPresent = $true
  $exitType = 'int32'
  $exitCode = [int32]0
  $output = @('v26.8.2|win32|x64')
  switch ($CaseName) {
    'missing-exit' { $exitPresent = $false; $exitType = 'none'; $exitCode = $null }
    'wrong-exit-type' { $exitType = 'other'; $exitCode = '0' }
    'nonzero-exit' { $invocationSucceeded = $true; $exitCode = [int32]4 }
    'runtime-mismatch' { $invocationSucceeded = $true; $output = @('v27.0.0|win32|x64') }
  }

  $directProbe = {
    param($Executable, $WorkingDirectory, $ExpectedRuntime)
    [Console]::Out.WriteLine('TEST_DIRECT_CALL')
    if ($CaseName -eq 'original-success') { throw 'SENTINEL_DIRECT_SHOULD_NOT_RUN' }
    if ($CaseName -eq 'direct-throws') { throw 'SENTINEL_DIRECT_EXCEPTION' }
    return [pscustomobject]@{
      StartAttempted = $true
      Started = $true
      Stage = 'cleanup-wait'
      FailureCode = 'none'
      StartExceptionKind = 'none'
      StartHResult = $null
      StartNativeErrorCode = $null
      ExitCode = [int32]0
      ExitObserved = $true
      TimedOut = $false
      KillAttempted = $false
      KillRequestSucceeded = $false
      KillFailureKind = 'none'
      KillHResult = $null
      KillNativeErrorCode = $null
      StandardOutputBytes = 18
      StandardOutputTruncated = $false
      StandardOutputEof = $true
      StandardOutputReadFailureKind = 'none'
      StandardErrorBytes = 0
      StandardErrorTruncated = $false
      StandardErrorEof = $true
      StandardErrorReadFailureKind = 'none'
      StandardInputCloseFailureKind = 'none'
      RuntimeMatch = $true
      CleanupConfirmed = $true
      ElapsedMilliseconds = 1
      ExceptionPhase = 'none'
      ExceptionKind = 'none'
      ExceptionHResult = $null
      ExceptionNativeErrorCode = $null
      CleanupFailureCode = 'none'
      DisposeFailureKind = 'none'
    }
  }.GetNewClosure()

  $arguments = @{
    InvokeSucceeded = $invocationSucceeded
    ExitPresent = $exitPresent
    ExitType = $exitType
    ExitCode = $exitCode
    Output = $output
    Executable = '/fixture/node'
    WorkingDirectory = '/fixture'
    ExpectedRuntime = 'v26.8.2|win32|x64'
    DirectProbe = $directProbe
  }
  $runtime = Assert-NodeRuntimeProbe @arguments
  [Console]::Out.WriteLine("RUNTIME=$runtime")
  [Console]::Out.WriteLine('NPM_REACHED')
  [Console]::Out.WriteLine('BUILD_REACHED')
}

function Invoke-ChildProcess([string]$CaseName) {
  $pwsh = (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $start = [Diagnostics.ProcessStartInfo]::new($pwsh)
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.ArgumentList.Add('-NoLogo')
  $start.ArgumentList.Add('-NoProfile')
  $start.ArgumentList.Add('-File')
  $start.ArgumentList.Add($PSCommandPath)
  $start.ArgumentList.Add('-ChildCase')
  $start.ArgumentList.Add($CaseName)
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'WINDOWS_NODE_BRANCH_TEST_FAILED: child process did not start' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(20000)) {
    try { $process.Kill() } catch {}
    throw 'WINDOWS_NODE_BRANCH_TEST_FAILED: child process timed out'
  }
  [pscustomobject]@{
    ExitCode = $process.ExitCode
    Output = $stdoutTask.GetAwaiter().GetResult() + $stderrTask.GetAwaiter().GetResult()
  }
  $process.Dispose()
}

if (-not [string]::IsNullOrEmpty($ChildCase)) {
  Invoke-BranchChild $ChildCase
  exit 0
}

$failingCases = @('direct-success', 'direct-throws', 'formatter-throws', 'missing-exit', 'wrong-exit-type', 'nonzero-exit', 'runtime-mismatch')
foreach ($caseName in $failingCases) {
  $result = Invoke-ChildProcess $caseName
  Assert-BranchTest ($result.ExitCode -eq 90) "$caseName did not preserve exit 90"
  Assert-BranchTest (-not $result.Output.Contains('NPM_REACHED') -and -not $result.Output.Contains('BUILD_REACHED')) "$caseName reached npm/build"
  Assert-BranchTest (([regex]::Matches($result.Output, 'TEST_DIRECT_CALL')).Count -eq 1) "$caseName did not invoke the direct probe exactly once"
  if ($caseName -eq 'direct-success' -or $caseName -in @('missing-exit', 'wrong-exit-type', 'nonzero-exit', 'runtime-mismatch')) {
    Assert-BranchTest ($result.Output.Contains('NODE_DIRECT_PROBE') -and $result.Output.Contains('failure=none')) "$caseName did not format a successful direct receipt"
    Assert-BranchTest (-not $result.Output.Contains('failure=diagnostic-unavailable')) "$caseName unexpectedly used the diagnostic fallback"
  } else {
    Assert-BranchTest ($result.Output.Contains('failure=diagnostic-unavailable')) "$caseName did not emit the sanitized diagnostic fallback"
  }
  if ($caseName -eq 'direct-throws' -or $caseName -eq 'formatter-throws') {
    Assert-BranchTest (-not $result.Output.Contains('SENTINEL_')) "$caseName leaked exception text"
  }
  Write-Output "WINDOWS_NODE_BRANCH_TEST case=$caseName result=PASS"
}

$success = Invoke-ChildProcess 'original-success'
Assert-BranchTest ($success.ExitCode -eq 0) 'original success did not continue normally'
Assert-BranchTest ($success.Output.Contains('NPM_REACHED') -and $success.Output.Contains('BUILD_REACHED')) 'original success did not reach downstream stage markers'
Assert-BranchTest (-not $success.Output.Contains('TEST_DIRECT_CALL')) 'original success invoked the direct probe'
Assert-BranchTest (-not $success.Output.Contains('NODE_DIRECT_PROBE')) 'original success emitted a diagnostic receipt'
Write-Output 'WINDOWS_NODE_BRANCH_TEST case=original-success result=PASS'
Write-Output 'WINDOWS_NODE_BRANCH_TESTS=PASS'
