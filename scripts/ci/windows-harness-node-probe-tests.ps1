#Requires -PSEdition Core
#Requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) {
  Write-Output 'WINDOWS_NODE_PROBE_TESTS=SKIP reason=posix-fixture-required'
  exit 0
}

Add-Type -Path (Join-Path $PSScriptRoot 'windows-harness-native.cs') -ErrorAction Stop

$expectedRuntime = 'v26.8.2|win32|x64'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('revo-node-probe-' + [Guid]::NewGuid().ToString('N'))
$workingDirectory = Join-Path $tempRoot 'probe directory with spaces'
$executable = Join-Path $workingDirectory 'node fixture'
$descendantPidPath = Join-Path $tempRoot 'descendant.pid'
$previousMode = [Environment]::GetEnvironmentVariable('REVO_PROBE_TEST_MODE')
$previousExpected = [Environment]::GetEnvironmentVariable('REVO_PROBE_TEST_EXPECTED')
$previousPidPath = [Environment]::GetEnvironmentVariable('REVO_PROBE_TEST_CHILD_PID_PATH')
$previousWorkingDirectory = [Environment]::GetEnvironmentVariable('REVO_PROBE_TEST_CWD')

function Assert-Probe([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "WINDOWS_NODE_PROBE_TEST_FAILED: $Message"
  }
}

function Invoke-Probe([string]$Mode, [string]$Path = $executable) {
  $env:REVO_PROBE_TEST_MODE = $Mode
  return [WindowsHarnessNative]::ProbeNodeRuntimeDirect(
    $Path,
    $workingDirectory,
    $expectedRuntime
  ).GetAwaiter().GetResult()
}

function Write-ProbeReceipt([string]$Name, [WindowsHarnessNodeProbeReport]$Probe) {
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
  Write-Output "WINDOWS_NODE_PROBE_RECEIPT case=$Name stage=$($Probe.Stage) failure=$($Probe.FailureCode) startAttempted=$($Probe.StartAttempted.ToString().ToLowerInvariant()) started=$($Probe.Started.ToString().ToLowerInvariant()) exceptionPhase=$($Probe.ExceptionPhase) exceptionKind=$($Probe.ExceptionKind) exceptionHResult=$exceptionHResult exceptionNativeError=$exceptionNativeError startExceptionKind=$($Probe.StartExceptionKind) startHResult=$startHResult startNativeError=$startNativeError exitObserved=$($Probe.ExitObserved.ToString().ToLowerInvariant()) exitCode=$exitCode timedOut=$($Probe.TimedOut.ToString().ToLowerInvariant()) killAttempted=$($Probe.KillAttempted.ToString().ToLowerInvariant()) killRequestSucceeded=$($Probe.KillRequestSucceeded.ToString().ToLowerInvariant()) stdoutBytes=$($Probe.StandardOutputBytes) stdoutEof=$($Probe.StandardOutputEof.ToString().ToLowerInvariant()) stdoutTruncated=$($Probe.StandardOutputTruncated.ToString().ToLowerInvariant()) stdoutReadFailure=$($Probe.StandardOutputReadFailureKind) stderrBytes=$($Probe.StandardErrorBytes) stderrEof=$($Probe.StandardErrorEof.ToString().ToLowerInvariant()) stderrTruncated=$($Probe.StandardErrorTruncated.ToString().ToLowerInvariant()) stderrReadFailure=$($Probe.StandardErrorReadFailureKind) stdinCloseFailure=$($Probe.StandardInputCloseFailureKind) disposeFailure=$($Probe.DisposeFailureKind) runtimeMatch=$($Probe.RuntimeMatch.ToString().ToLowerInvariant()) cleanupConfirmed=$($Probe.CleanupConfirmed.ToString().ToLowerInvariant()) cleanupFailure=$($Probe.CleanupFailureCode) elapsedMs=$($Probe.ElapsedMilliseconds)"
}

function Write-ProbeResult([string]$Name) {
  Write-Output "WINDOWS_NODE_PROBE_TEST name=$Name result=PASS"
}

function Decode-MountInfoField([string]$Value) {
  $builder = [Text.StringBuilder]::new()
  for ($index = 0; $index -lt $Value.Length; $index++) {
    if ($Value[$index] -ne '\') {
      [void]$builder.Append($Value[$index])
      continue
    }
    if ($index + 3 -ge $Value.Length) { return $null }
    $escape = $Value.Substring($index + 1, 3)
    $decoded = switch ($escape) {
      '040' { ' ' }
      '011' { "`t" }
      '012' { "`n" }
      '134' { '\' }
      default { return $null }
    }
    [void]$builder.Append($decoded)
    $index += 3
  }
  return $builder.ToString()
}

function Get-FixtureMountState([string[]]$MountInfo, [string]$FixturePath) {
  if (-not [IO.Path]::IsPathFullyQualified($FixturePath) -or $FixturePath.Contains([char]0)) {
    return 'unknown'
  }
  try { $normalizedFixture = [IO.Path]::GetFullPath($FixturePath) } catch { return 'unknown' }
  if ($normalizedFixture.Length -gt 1) { $normalizedFixture = $normalizedFixture.TrimEnd([char]'/') }
  $mountMatches = [Collections.Generic.List[object]]::new()
  foreach ($line in $MountInfo) {
    $fields = $line -split '\s+'
    if ($fields.Count -lt 10 -or $fields[6..($fields.Count - 1)] -notcontains '-') {
      return 'unknown'
    }
    $mountPoint = Decode-MountInfoField $fields[4]
    if ([string]::IsNullOrEmpty($mountPoint) -or -not $mountPoint.StartsWith('/', [StringComparison]::Ordinal)) {
      return 'unknown'
    }
    if ($mountPoint.Length -gt 1) { $mountPoint = $mountPoint.TrimEnd([char]'/') }
    $options = $fields[5] -split ','
    if ($options.Count -eq 0 -or $options -contains '') { return 'unknown' }
    $matchesMount = if ($mountPoint -eq '/') {
      $normalizedFixture.StartsWith('/', [StringComparison]::Ordinal)
    } else {
      [string]::Equals($normalizedFixture, $mountPoint, [StringComparison]::Ordinal) -or
        $normalizedFixture.StartsWith($mountPoint + '/', [StringComparison]::Ordinal)
    }
    if ($matchesMount) {
      $mountMatches.Add([pscustomobject]@{ Length = $mountPoint.Length; Options = $options })
    }
  }
  if ($mountMatches.Count -eq 0) { return 'unknown' }
  $deepestLength = ($mountMatches | Measure-Object -Property Length -Maximum).Maximum
  $deepest = @($mountMatches | Where-Object { $_.Length -eq $deepestLength })
  if ($deepest.Count -ne 1) { return 'unknown' }
  if ($deepest[0].Options -contains 'noexec') { return 'noexec' }
  return 'exec'
}

$rootExecutable = '24 1 0:1 / / rw - ext4 /dev/root rw'
$tempNoExec = '25 24 0:2 / /tmp rw,noexec - tmpfs tmpfs rw,noexec'
$nestedExec = '26 25 0:3 / /tmp/revo\040lab rw,exec - tmpfs tmpfs rw,exec'
Assert-Probe ((Get-FixtureMountState @($rootExecutable, $tempNoExec) '/tmp/fixture') -eq 'noexec') 'deepest noexec mount did not override executable root'
Assert-Probe ((Get-FixtureMountState @($rootExecutable, $tempNoExec, $nestedExec) '/tmp/revo lab/fixture') -eq 'exec') 'nested executable mount was not selected'
Assert-Probe ((Get-FixtureMountState @($rootExecutable, $tempNoExec) '/tmp2/fixture') -eq 'exec') 'mount matching ignored path-component boundary'
Assert-Probe ((Get-FixtureMountState @($rootExecutable, $tempNoExec, '27 25 0:4 / /tmp rw,exec - tmpfs tmpfs rw,exec') '/tmp/fixture') -eq 'unknown') 'ambiguous mount table was trusted'
Assert-Probe ((Get-FixtureMountState @('malformed') '/tmp/fixture') -eq 'unknown') 'malformed mount table was trusted'
Write-ProbeResult 'mountinfo-longest-match'

[WindowsHarnessNodeProbeReport].GetProperties() | ForEach-Object {
  Assert-Probe ($null -eq $_.GetSetMethod($true)) 'probe receipt exposes a mutable property'
}
Write-ProbeResult 'immutable-receipt-contract'

$probeStateType = [WindowsHarnessNodeProbeReport].Assembly.GetType('WindowsHarnessNodeProbeState', $true)
$probeState = [Activator]::CreateInstance($probeStateType, $true)
foreach ($field in @{
    ExitObserved = $true
    StandardOutputEof = $true
    StandardErrorEof = $true
    StandardOutputReadFailureKind = 'none'
    StandardErrorReadFailureKind = 'none'
    DisposeFailureKind = 'none'
    CleanupFailureCode = 'cleanup-deadline-exceeded'
  }.GetEnumerator()) {
  $probeStateType.GetProperty($field.Key).SetValue($probeState, $field.Value)
}
$cleanupConfirmedProperty = $probeStateType.GetProperty('CleanupConfirmed')
Assert-Probe (-not $cleanupConfirmedProperty.GetValue($probeState)) 'late EOF overrode a prior cleanup deadline failure'
$probeStateType.GetProperty('CleanupFailureCode').SetValue($probeState, 'none')
Assert-Probe ($cleanupConfirmedProperty.GetValue($probeState)) 'confirmed exit and EOF did not pass the cleanup policy'
Write-ProbeResult 'cleanup-failure-dominates-late-eof'

[void][IO.Directory]::CreateDirectory($workingDirectory)
$fixture = @'
#!/bin/sh
set -eu
if [ "$#" -ne 2 ] || [ "$1" != "-p" ] || [ "$2" != "process.version + '|' + process.platform + '|' + process.arch" ]; then
  printf '%s\n' 'SENTINEL_ARGUMENT_MISMATCH' >&2
  exit 63
fi
if [ "$PWD" != "$REVO_PROBE_TEST_CWD" ]; then
  printf '%s\n' 'SENTINEL_CWD_MISMATCH' >&2
  exit 64
fi
case "$REVO_PROBE_TEST_MODE" in
  runtime)
    printf '%s\n' "$REVO_PROBE_TEST_EXPECTED"
    ;;
  stdin-eof)
    IFS= read -r ignored || true
    printf '%s\n' "$REVO_PROBE_TEST_EXPECTED"
    ;;
  wrong-output)
    printf '%s\n' 'SENTINEL_OUTPUT_VALUE'
    ;;
  multiline)
    printf '%s\n' "$REVO_PROBE_TEST_EXPECTED"
    printf '%s\n' 'SENTINEL_EXTRA_LINE'
    ;;
  no-newline)
    printf '%s' "$REVO_PROBE_TEST_EXPECTED"
    ;;
  nonzero)
    printf '%s\n' "$REVO_PROBE_TEST_EXPECTED"
    exit 9
    ;;
  large)
    dd if=/dev/zero bs=8192 count=32 2>/dev/null &
    stdout_pid=$!
    dd if=/dev/zero bs=8192 count=32 1>&2 2>/dev/null &
    stderr_pid=$!
    wait "$stdout_pid"
    wait "$stderr_pid"
    ;;
  timeout)
    exec sleep 60
    ;;
  descendant-pipe)
    (sleep 60) &
    child_pid=$!
    printf '%s' "$child_pid" > "$REVO_PROBE_TEST_CHILD_PID_PATH"
    printf '%s\n' "$REVO_PROBE_TEST_EXPECTED"
    ;;
  *)
    exit 65
    ;;
esac
'@
[IO.File]::WriteAllText($executable, $fixture, [Text.UTF8Encoding]::new($false))
[IO.File]::SetUnixFileMode(
  $executable,
  [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute
)

$env:REVO_PROBE_TEST_EXPECTED = $expectedRuntime
$env:REVO_PROBE_TEST_CWD = $workingDirectory
$env:REVO_PROBE_TEST_CHILD_PID_PATH = $descendantPidPath
$expectedAsciiBytes = [Text.Encoding]::ASCII.GetByteCount($expectedRuntime)
$fixtureMode = [IO.File]::GetUnixFileMode($executable)
$fixtureText = [IO.File]::ReadAllText($executable, [Text.UTF8Encoding]::new($false))
$fixtureMountState = Get-FixtureMountState ([IO.File]::ReadAllLines('/proc/self/mountinfo')) $workingDirectory
Write-Output "WINDOWS_NODE_PROBE_FIXTURE expectedAscii=true expectedBytes=$expectedAsciiBytes expectedLfBytes=$($expectedAsciiBytes + 1) expectedCrLfBytes=$($expectedAsciiBytes + 2) fixtureExists=$([IO.File]::Exists($executable).ToString().ToLowerInvariant()) fixtureExecutableBit=$((($fixtureMode -band [IO.UnixFileMode]::UserExecute) -ne 0).ToString().ToLowerInvariant()) fixtureBom=$($fixtureText.StartsWith([char]0xfeff).ToString().ToLowerInvariant()) fixtureShebangValid=$($fixtureText.StartsWith("#!/bin/sh`n", [StringComparison]::Ordinal).ToString().ToLowerInvariant()) fixtureCrLf=$($fixtureText.Contains("`r`n").ToString().ToLowerInvariant()) fixtureMountState=$fixtureMountState"
Assert-Probe ($fixtureMountState -eq 'exec') 'test fixture is not located on an executable mount'

try {
  $success = Invoke-Probe 'runtime'
  Write-ProbeReceipt 'runtime' $success
  Assert-Probe ($success.Started) 'runtime fixture did not start'
  Assert-Probe ($success.Started -and $success.ExitObserved -and $success.ExitCode -eq 0) 'successful launch receipt is incomplete'
  Assert-Probe ($success.FailureCode -eq 'none' -and $success.RuntimeMatch -and $success.CleanupConfirmed) 'exact runtime output or cleanup contract failed'
  Assert-Probe ($success.StandardOutputBytes -eq $expectedRuntime.Length + 1) 'successful launch byte count is incorrect'
  Write-ProbeResult 'runtime-and-argv-cwd'

  $stdinEof = Invoke-Probe 'stdin-eof'
  Write-ProbeReceipt 'stdin-eof' $stdinEof
  Assert-Probe ($stdinEof.FailureCode -eq 'none' -and $stdinEof.RuntimeMatch) 'stdin was not closed for the child'
  Write-ProbeResult 'stdin-eof'

  $wrong = Invoke-Probe 'wrong-output'
  Write-ProbeReceipt 'wrong-output' $wrong
  $wrongReceipt = ConvertTo-Json -InputObject $wrong -Compress
  Assert-Probe ($wrong.FailureCode -eq 'runtime-output-mismatch' -and -not $wrong.RuntimeMatch) 'wrong output was accepted'
  Assert-Probe (-not $wrongReceipt.Contains('SENTINEL_OUTPUT_VALUE')) 'raw stdout leaked into the receipt'
  Write-ProbeResult 'wrong-output-redacted'

  $multiline = Invoke-Probe 'multiline'
  Write-ProbeReceipt 'multiline' $multiline
  Assert-Probe ($multiline.FailureCode -eq 'runtime-output-mismatch' -and -not $multiline.RuntimeMatch) 'multiline output was accepted'
  Write-ProbeResult 'multiline-output'

  $noNewline = Invoke-Probe 'no-newline'
  Write-ProbeReceipt 'no-newline' $noNewline
  Assert-Probe ($noNewline.FailureCode -eq 'runtime-output-mismatch' -and -not $noNewline.RuntimeMatch) 'output without its one line terminator was accepted'
  Write-ProbeResult 'line-terminator'

  $nonzero = Invoke-Probe 'nonzero'
  Write-ProbeReceipt 'nonzero' $nonzero
  Assert-Probe ($nonzero.FailureCode -eq 'exit-nonzero' -and $nonzero.ExitObserved -and $nonzero.ExitCode -eq 9) 'nonzero child exit was not preserved'
  Write-ProbeResult 'nonzero-exit'

  $large = Invoke-Probe 'large'
  Write-ProbeReceipt 'large' $large
  Assert-Probe ($large.FailureCode -eq 'runtime-output-mismatch') 'large output was not rejected'
  Assert-Probe ($large.StandardOutputTruncated -and $large.StandardErrorTruncated) 'both streams were not bounded and drained'
  Assert-Probe ($large.StandardOutputBytes -eq 262144 -and $large.StandardErrorBytes -eq 262144) 'full byte counts were not retained'
  Assert-Probe ($large.CleanupConfirmed) 'large concurrent output did not close both streams'
  Write-ProbeResult 'bounded-concurrent-streams'

  $timeout = Invoke-Probe 'timeout'
  Write-ProbeReceipt 'timeout' $timeout
  Assert-Probe ($timeout.TimedOut -and $timeout.KillAttempted) 'timeout did not request process-tree termination'
  Assert-Probe ($timeout.ExitObserved -and $timeout.CleanupConfirmed) 'timeout cleanup was not confirmed by exit and EOF'
  Assert-Probe ($timeout.FailureCode -eq 'execution-timeout') 'timeout failure was not preserved'
  Write-ProbeResult 'timeout-kill-and-confirm'

  $missingPath = Join-Path $workingDirectory 'SENTINEL_MISSING_EXECUTABLE'
  $missing = Invoke-Probe 'runtime' $missingPath
  Write-ProbeReceipt 'start-failure' $missing
  $missingReceipt = ConvertTo-Json -InputObject $missing -Compress
  Assert-Probe ($missing.StartAttempted -and -not $missing.Started -and -not $missing.ExitObserved) 'start failure receipt is invalid'
  Assert-Probe ($missing.FailureCode -eq 'start-exception') 'start exception was not classified'
  Assert-Probe ($missing.ExceptionPhase -eq 'start' -and $missing.StartExceptionKind -eq 'win32') 'start exception phase was misclassified'
  Assert-Probe (-not $missingReceipt.Contains('SENTINEL_MISSING_EXECUTABLE')) 'executable path leaked into the receipt'
  Write-ProbeResult 'start-failure-redacted'

  $descendant = Invoke-Probe 'descendant-pipe'
  Write-ProbeReceipt 'descendant-pipe' $descendant
  $descendantReceipt = ConvertTo-Json -InputObject $descendant -Compress
  Assert-Probe ($descendant.ExitObserved -and -not $descendant.StandardOutputEof) 'descendant-held pipe was treated as EOF'
  Assert-Probe (-not $descendant.CleanupConfirmed -and $descendant.FailureCode -eq 'cleanup-unconfirmed') 'unconfirmed descendant cleanup was accepted'
  Start-Sleep -Milliseconds 200
  Assert-Probe ((ConvertTo-Json -InputObject $descendant -Compress) -ceq $descendantReceipt) 'receipt changed after it was returned'
  Write-ProbeResult 'descendant-held-pipe-fail-closed'

  Write-Output 'WINDOWS_NODE_PROBE_TESTS=PASS'
}
finally {
  if (Test-Path -LiteralPath $descendantPidPath -PathType Leaf) {
    try {
      $childPid = [int][IO.File]::ReadAllText($descendantPidPath)
      $child = [Diagnostics.Process]::GetProcessById($childPid)
      try {
        $child.Kill($true)
        [void]$child.WaitForExit(3000)
      } finally {
        $child.Dispose()
      }
    } catch {
    }
  }
  [Environment]::SetEnvironmentVariable('REVO_PROBE_TEST_MODE', $previousMode)
  [Environment]::SetEnvironmentVariable('REVO_PROBE_TEST_EXPECTED', $previousExpected)
  [Environment]::SetEnvironmentVariable('REVO_PROBE_TEST_CHILD_PID_PATH', $previousPidPath)
  [Environment]::SetEnvironmentVariable('REVO_PROBE_TEST_CWD', $previousWorkingDirectory)
  if (Test-Path -LiteralPath $tempRoot -PathType Container) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
