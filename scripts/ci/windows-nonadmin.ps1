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
  Write-ExecutableEnvironmentReceipt $Result
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

function Write-ExecutableEnvironmentReceipt($Result) {
  $environmentFailureCodes = @('ENVIRONMENT_INPUT_INVALID', 'ENVIRONMENT_COPY_MISMATCH')
  if ($null -eq $Result -or $Result.FailureCode -notin $environmentFailureCodes) {
    return
  }
  $code = ConvertTo-HarnessDiagnosticCode $Result.FailureCode $environmentFailureCodes
  Write-Output "WINDOWS_EXECUTABLE_ENV_COPY_FAILURE code=$code nodeInputPresent=$($Result.NodeEnvironmentInputPresent.ToString().ToLowerInvariant()) nodeInputLength=$($Result.NodeEnvironmentInputLength) nodeCopiedPresent=$($Result.NodeEnvironmentCopiedPresent.ToString().ToLowerInvariant()) nodeCopyEqual=$($Result.NodeEnvironmentCopyEqual.ToString().ToLowerInvariant()) npmInputPresent=$($Result.NpmEnvironmentInputPresent.ToString().ToLowerInvariant()) npmInputLength=$($Result.NpmEnvironmentInputLength) npmCopiedPresent=$($Result.NpmEnvironmentCopiedPresent.ToString().ToLowerInvariant()) npmCopyEqual=$($Result.NpmEnvironmentCopyEqual.ToString().ToLowerInvariant()) environmentValidated=$($Result.EnvironmentValidated.ToString().ToLowerInvariant())"
}

function ConvertTo-HarnessDiagnosticBoolean($Value) {
  return ([bool]$Value).ToString().ToLowerInvariant()
}

function ConvertTo-HarnessDiagnosticInt32($Value) {
  if ($null -eq $Value) {
    return 'none'
  }
  if ($Value -isnot [int]) {
    return 'unknown'
  }
  return ([int]$Value).ToString([Globalization.CultureInfo]::InvariantCulture)
}

function Write-NewUtf8TextFile([string]$Path, [string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    if ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Get-WindowsCredentialedCommandLineBound([string]$Executable, [string[]]$Arguments) {
  if ([string]::IsNullOrEmpty($Executable)) {
    throw 'Credentialed process executable is empty.'
  }
  $values = @($Executable) + @($Arguments)
  foreach ($value in $values) {
    if ($null -eq $value -or
        $value.IndexOf([char]0) -ge 0 -or
        $value.Contains([char]34) -or
        $value.EndsWith('\', [StringComparison]::Ordinal)) {
      throw 'Credentialed process command contains an unsupported argument.'
    }
  }

  $bound = [long]1 + $Executable.Length + 2
  foreach ($argument in $Arguments) {
    $bound += [long]$argument.Length + 3
  }
  return $bound
}

function Assert-WindowsCredentialedCommandLineBound([string]$Executable, [string[]]$Arguments) {
  $bound = Get-WindowsCredentialedCommandLineBound $Executable $Arguments
  if ($bound -gt 1000) {
    throw 'Credentialed process command-length bound exceeds 1000 UTF-16 characters.'
  }
  return [pscustomobject]@{
    CommandLengthBound = $bound
    WithinLimit = $true
  }
}

function Format-DescendantHarnessDiagnostic($Result, [bool]$AckExists, [long]$ElapsedMs) {
  $failureCodes = @(
    'DESCENDANTS_REMAINED', 'EARLY_EXIT', 'ENVIRONMENT_COPY_MISMATCH', 'ENVIRONMENT_INPUT_INVALID',
    'EXECUTION_TIMEOUT', 'GO_WRITE_FAILED',
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
  $startOrigin = 'none'
  $startKind = 'none'
  $startHResult = 'none'
  $startNativeCode = 'none'
  if ($Result.FailureCode -ceq 'PROCESS_START_FAILED') {
    $startOrigin = ConvertTo-HarnessDiagnosticCode $Result.StartFailureOrigin @('exception', 'returned-false')
    if ($startOrigin -ceq 'exception') {
      $startKind = ConvertTo-HarnessDiagnosticCode $Result.StartExceptionKind @(
        'argument', 'invalid-operation', 'not-supported', 'other',
        'security', 'unauthorized-access', 'win32'
      )
      if ($startKind -ceq 'none') {
        $startKind = 'unknown'
      }
      $startHResult = ConvertTo-HarnessDiagnosticInt32 $Result.StartHResult
      if ($startKind -ceq 'win32') {
        $startNativeCode = ConvertTo-HarnessDiagnosticInt32 $Result.StartNativeErrorCode
      } elseif ($null -ne $Result.StartNativeErrorCode) {
        $startNativeCode = 'unknown'
      }
    } elseif ($startOrigin -ceq 'unknown') {
      $startKind = 'unknown'
      $startHResult = 'unknown'
      $startNativeCode = 'unknown'
    }
  }
  return [string]::Format(
    [Globalization.CultureInfo]::InvariantCulture,
    'control=descendant failure={0} cleanupFailure={1} startOrigin={2} startKind={3} startHResult={4} startNativeCode={5} exitObserved={6} exitCode={7} timedOut={8} goAttempted={9} goSent={10} cleanupConfirmed={11} stdoutMarker={12} stderrMarker={13} ackExists={14} elapsedMs={15}',
    (ConvertTo-HarnessDiagnosticCode $Result.FailureCode $failureCodes),
    (ConvertTo-HarnessDiagnosticCode $Result.CleanupFailureCode $cleanupCodes),
    $startOrigin,
    $startKind,
    $startHResult,
    $startNativeCode,
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

function New-FixtureProcessScanResult(
  [string]$State,
  [string]$Reason,
  [string]$Phase,
  [int]$ExaminedCount = 0,
  [int]$ResultCount = 0,
  [bool]$ReturnPresent = $false,
  [string]$ReturnType = 'none',
  [string]$ReturnValue = 'none',
  [bool]$SidPresent = $false,
  [string]$SidKind = 'none',
  [string]$Category = 'none',
  [string]$HResult = 'none',
  [bool]$ProcessIdPresent = $false,
  [string]$ProcessId = 'none',
  [bool]$IsHarnessProcess = $false,
  [bool]$CreationTimePresent = $false,
  [string]$CreationTime = 'none'
) {
  return [pscustomobject]@{
    State = $State
    Reason = $Reason
    Phase = $Phase
    ExaminedCount = $ExaminedCount
    ResultCount = $ResultCount
    ReturnPresent = $ReturnPresent
    ReturnType = $ReturnType
    ReturnValue = $ReturnValue
    SidPresent = $SidPresent
    SidKind = $SidKind
    Category = $Category
    HResult = $HResult
    ProcessIdPresent = $ProcessIdPresent
    ProcessId = $ProcessId
    IsHarnessProcess = $IsHarnessProcess
    CreationTimePresent = $CreationTimePresent
    CreationTime = $CreationTime
  }
}

function Get-FixtureProcessIdentityEvidence($Process) {
  $processIdPresent = $false
  $processId = 'none'
  $isHarnessProcess = $false
  $creationTimePresent = $false
  $creationTime = 'none'
  try {
    $property = $Process.PSObject.Properties['ProcessId']
    if ($null -ne $property -and ($property.Value -is [uint32] -or $property.Value -is [int32] -or $property.Value -is [int64])) {
      $value = [long]$property.Value
      if ($value -ge 0 -and $value -le [uint32]::MaxValue) {
        $processIdPresent = $true
        $processId = $value.ToString([Globalization.CultureInfo]::InvariantCulture)
        $isHarnessProcess = $value -eq [long]$PID
      }
    }
  } catch {}
  try {
    $property = $Process.PSObject.Properties['CreationDate']
    if ($null -ne $property -and $property.Value -is [DateTime]) {
      $creationTime = $property.Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
      $creationTimePresent = $true
    } elseif ($null -ne $property -and $property.Value -is [string]) {
      $parsed = [DateTime]::MinValue
      if ([DateTime]::TryParse(
          $property.Value,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::AssumeUniversal,
          [ref]$parsed
        )) {
        $creationTime = $parsed.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
        $creationTimePresent = $true
      }
    }
  } catch {}
  return [pscustomobject]@{
    ProcessIdPresent = $processIdPresent
    ProcessId = $processId
    IsHarnessProcess = $isHarnessProcess
    CreationTimePresent = $creationTimePresent
    CreationTime = $creationTime
  }
}

function Get-FixtureSafeValueType($Value) {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [uint32]) { return 'uint32' }
  if ($Value -is [int32]) { return 'int32' }
  if ($Value -is [string]) { return 'string' }
  return 'other'
}

function Get-FixtureSafeErrorMetadata([System.Management.Automation.ErrorRecord]$Record) {
  $category = 'unknown'
  $hresult = 'none'
  try { $category = $Record.CategoryInfo.Category.ToString() } catch {}
  try { $hresult = $Record.Exception.HResult.ToString([Globalization.CultureInfo]::InvariantCulture) } catch {}
  return [pscustomobject]@{ Category = $category; HResult = $hresult }
}

function Get-FixtureProcessScanResult([string]$ExpectedSid) {
  $phase = 'expected-sid'
  $examinedCount = 0
  $resultCount = 0
  try {
    if ([string]::IsNullOrWhiteSpace($ExpectedSid)) {
      return New-FixtureProcessScanResult 'unknown' 'EXPECTED_SID_INVALID' $phase
    }
    if ($IsWindows) {
      try {
        $ExpectedSid = [System.Security.Principal.SecurityIdentifier]::new($ExpectedSid).Value
      } catch {
        return New-FixtureProcessScanResult 'unknown' 'EXPECTED_SID_INVALID' $phase
      }
    } elseif ($ExpectedSid -notmatch '^S-1-\d+(?:-\d+){1,15}$') {
      return New-FixtureProcessScanResult 'unknown' 'EXPECTED_SID_INVALID' $phase
    }

    $phase = 'process-query'
    $processes = [System.Collections.Generic.List[object]]::new()
    try {
      Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
        [void]$processes.Add($_)
      }
    } catch {
      $metadata = Get-FixtureSafeErrorMetadata $_
      return New-FixtureProcessScanResult 'unknown' 'QUERY_EXCEPTION' $phase $processes.Count 0 $false 'none' 'none' $false 'none' $metadata.Category $metadata.HResult
    }

    foreach ($process in $processes) {
      if ($null -eq $process) {
        return New-FixtureProcessScanResult 'unknown' 'PROCESS_ENTRY_INVALID' 'process-entry' $examinedCount 0
      }
      $examinedCount++
      $processIdentity = Get-FixtureProcessIdentityEvidence $process
      $phase = 'owner-method'
      try {
        $ownerResults = @(Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop)
      } catch {
        $metadata = Get-FixtureSafeErrorMetadata $_
        return New-FixtureProcessScanResult 'unknown' 'METHOD_EXCEPTION' $phase $examinedCount 0 $false 'none' 'none' $false 'none' $metadata.Category $metadata.HResult
      }
      $resultCount = $ownerResults.Count
      if ($resultCount -ne 1 -or $null -eq $ownerResults[0]) {
        return New-FixtureProcessScanResult 'unknown' 'METHOD_RESULT_INVALID' $phase $examinedCount $resultCount
      }

      $phase = 'owner-result'
      $owner = $ownerResults[0]
      $returnProperty = $owner.PSObject.Properties['ReturnValue']
      $sidProperty = $owner.PSObject.Properties['Sid']
      $returnPresent = $null -ne $returnProperty
      $sidPresent = $null -ne $sidProperty
      if (-not $returnPresent) {
        return New-FixtureProcessScanResult 'unknown' 'RETURN_VALUE_MISSING' $phase $examinedCount $resultCount $false 'none' 'none' $sidPresent
      }

      $returnValue = $returnProperty.Value
      $returnType = Get-FixtureSafeValueType $returnValue
      if ($returnType -ne 'uint32' -and $returnType -ne 'int32') {
        return New-FixtureProcessScanResult 'unknown' 'RETURN_VALUE_TYPE' $phase $examinedCount $resultCount $true $returnType 'none' $sidPresent
      }
      $safeReturnValue = $returnValue.ToString([Globalization.CultureInfo]::InvariantCulture)
      if ($returnValue -ne 0) {
        return New-FixtureProcessScanResult `
          'unknown' 'METHOD_NONZERO' $phase $examinedCount $resultCount $true $returnType $safeReturnValue $sidPresent `
          -ProcessIdPresent $processIdentity.ProcessIdPresent `
          -ProcessId $processIdentity.ProcessId `
          -IsHarnessProcess $processIdentity.IsHarnessProcess `
          -CreationTimePresent $processIdentity.CreationTimePresent `
          -CreationTime $processIdentity.CreationTime
      }
      if (-not $sidPresent) {
        return New-FixtureProcessScanResult 'unknown' 'SID_MISSING' $phase $examinedCount $resultCount $true $returnType $safeReturnValue $false
      }

      $sidValue = $sidProperty.Value
      $sidKind = Get-FixtureSafeValueType $sidValue
      if ($sidKind -ne 'string' -or [string]::IsNullOrWhiteSpace($sidValue)) {
        return New-FixtureProcessScanResult 'unknown' 'SID_VALUE_INVALID' $phase $examinedCount $resultCount $true $returnType $safeReturnValue $true $sidKind
      }
      if ($IsWindows) {
        try {
          $sidValue = [System.Security.Principal.SecurityIdentifier]::new($sidValue).Value
        } catch {
          return New-FixtureProcessScanResult 'unknown' 'SID_PARSE_FAILED' $phase $examinedCount $resultCount $true $returnType $safeReturnValue $true $sidKind
        }
      } elseif ($sidValue -notmatch '^S-1-\d+(?:-\d+){1,15}$') {
        return New-FixtureProcessScanResult 'unknown' 'SID_PARSE_FAILED' $phase $examinedCount $resultCount $true $returnType $safeReturnValue $true $sidKind
      }
      if ($sidValue -ceq $ExpectedSid) {
        return New-FixtureProcessScanResult 'remaining' 'MATCHING_PROCESS' 'owner-match' $examinedCount $resultCount $true $returnType $safeReturnValue $true $sidKind
      }
    }
    return New-FixtureProcessScanResult 'clear' 'NONE' 'complete' $examinedCount $resultCount
  } catch {
    $metadata = Get-FixtureSafeErrorMetadata $_
    return New-FixtureProcessScanResult 'unknown' 'SCAN_EXCEPTION' $phase $examinedCount $resultCount $false 'none' 'none' $false 'none' $metadata.Category $metadata.HResult
  }
}

function Get-FixtureOwnerDiagnostic(
  [object]$OwnerScan,
  [string]$ExpectedSid,
  [int]$BudgetSeconds = 15,
  [scriptblock]$ProcessQuery,
  [scriptblock]$OwnerQuery
) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $selfQuery = 'unknown'
  $selfSidMatchesToken = $false
  $processIdentity = 'unknown'
  $processOwnerReturn = 'none'
  $processOwnerSidMatchesFixture = 'unknown'
  $processAfterOwnerIdentity = 'unknown'
  $targetProcessId = 'none'
  if ($null -ne $OwnerScan -and $OwnerScan.ProcessIdPresent -and $OwnerScan.ProcessId -match '^\d+$') {
    $targetProcessId = $OwnerScan.ProcessId
  }

  $invokeProcessQuery = if ($null -ne $ProcessQuery) {
    $ProcessQuery
  } else {
    { param([string]$Id) @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $Id" -OperationTimeoutSec 3 -ErrorAction Stop) }.GetNewClosure()
  }
  $invokeOwnerQuery = if ($null -ne $OwnerQuery) {
    $OwnerQuery
  } else {
    { param($Process) @(Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -OperationTimeoutSec 3 -ErrorAction Stop) }.GetNewClosure()
  }

  try {
    if ($watch.Elapsed.TotalSeconds -lt $BudgetSeconds) {
      $selfRows = @(& $invokeProcessQuery ([string]$PID))
      if ($selfRows.Count -eq 1 -and $null -ne $selfRows[0]) {
        $selfOwnerRows = @(& $invokeOwnerQuery $selfRows[0])
        if ($selfOwnerRows.Count -eq 1 -and $null -ne $selfOwnerRows[0]) {
          $returnProperty = $selfOwnerRows[0].PSObject.Properties['ReturnValue']
          $sidProperty = $selfOwnerRows[0].PSObject.Properties['Sid']
          if ($null -ne $returnProperty -and $returnProperty.Value -is [uint32] -and
              $returnProperty.Value -eq 0 -and $null -ne $sidProperty -and $sidProperty.Value -is [string]) {
            $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            $selfSidMatchesToken = [string]::Equals($sidProperty.Value, $currentSid, [StringComparison]::Ordinal)
            $selfQuery = if ($selfSidMatchesToken) { 'match' } else { 'mismatch' }
          } elseif ($null -ne $returnProperty -and ($returnProperty.Value -is [uint32] -or $returnProperty.Value -is [int32])) {
            $selfQuery = 'nonzero'
          }
        }
      }
    }

    if ($targetProcessId -ne 'none' -and $OwnerScan.CreationTimePresent -and
        $watch.Elapsed.TotalSeconds -lt $BudgetSeconds) {
      $beforeRows = @(& $invokeProcessQuery $targetProcessId)
      if ($beforeRows.Count -eq 0) {
        $processIdentity = 'gone'
      } elseif ($beforeRows.Count -eq 1 -and $null -ne $beforeRows[0]) {
        $beforeEvidence = Get-FixtureProcessIdentityEvidence $beforeRows[0]
        if (-not $beforeEvidence.CreationTimePresent) {
          $processIdentity = 'unknown'
        } elseif (-not [string]::Equals($beforeEvidence.CreationTime, $OwnerScan.CreationTime, [StringComparison]::Ordinal)) {
          $processIdentity = 'changed'
        } elseif ($watch.Elapsed.TotalSeconds -ge $BudgetSeconds) {
          $processIdentity = 'unknown'
        } else {
          $processIdentity = 'same'
          $ownerRows = @(& $invokeOwnerQuery $beforeRows[0])
          if ($ownerRows.Count -eq 1 -and $null -ne $ownerRows[0]) {
            $returnProperty = $ownerRows[0].PSObject.Properties['ReturnValue']
            $sidProperty = $ownerRows[0].PSObject.Properties['Sid']
            if ($null -ne $returnProperty -and ($returnProperty.Value -is [uint32] -or $returnProperty.Value -is [int32])) {
              $processOwnerReturn = $returnProperty.Value.ToString([Globalization.CultureInfo]::InvariantCulture)
              if ($returnProperty.Value -eq 0 -and $null -ne $sidProperty -and $sidProperty.Value -is [string]) {
                $processOwnerSidMatchesFixture = [string]::Equals($sidProperty.Value, $ExpectedSid, [StringComparison]::Ordinal).ToString().ToLowerInvariant()
              } else {
                $processOwnerSidMatchesFixture = 'unknown'
              }
            }
          }
          if ($watch.Elapsed.TotalSeconds -lt $BudgetSeconds) {
            $afterRows = @(& $invokeProcessQuery $targetProcessId)
            if ($afterRows.Count -eq 0) {
              $processAfterOwnerIdentity = 'gone'
            } elseif ($afterRows.Count -eq 1 -and $null -ne $afterRows[0]) {
              $afterEvidence = Get-FixtureProcessIdentityEvidence $afterRows[0]
              if (-not $afterEvidence.CreationTimePresent) {
                $processAfterOwnerIdentity = 'unknown'
              } elseif ([string]::Equals($afterEvidence.CreationTime, $OwnerScan.CreationTime, [StringComparison]::Ordinal)) {
                $processAfterOwnerIdentity = 'same'
              } else {
                $processAfterOwnerIdentity = 'changed'
              }
            }
          }
        }
      }
    }
  } catch {
    if ($processIdentity -eq 'unknown') { $processIdentity = 'unknown' }
    if ($selfQuery -eq 'unknown') { $selfQuery = 'unknown' }
  }

  return [pscustomobject]@{
    ProcessIdPresent = $targetProcessId -ne 'none'
    ProcessId = $targetProcessId
    IsHarnessProcess = $null -ne $OwnerScan -and [bool]$OwnerScan.IsHarnessProcess
    CreationTimePresent = $null -ne $OwnerScan -and [bool]$OwnerScan.CreationTimePresent
    ProcessIdentity = $processIdentity
    ProcessAfterOwnerIdentity = $processAfterOwnerIdentity
    SelfQuery = $selfQuery
    SelfSidMatchesToken = $selfSidMatchesToken
    ProcessOwnerReturn = $processOwnerReturn
    ProcessOwnerSidMatchesFixture = $processOwnerSidMatchesFixture
    ElapsedMilliseconds = $watch.ElapsedMilliseconds
  }
}

function Copy-FixtureEnvironment([System.Collections.IDictionary]$Environment) {
  if ($null -eq $Environment) { throw 'ENVIRONMENT_INVALID' }
  $copy = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $Environment.GetEnumerator()) {
    if ($null -eq $entry.Key -or $null -eq $entry.Value) { throw 'ENVIRONMENT_INVALID' }
    $copy[[string]$entry.Key] = [string]$entry.Value
  }
  return ,$copy
}

function Test-FixtureEnvironmentEqual(
  [System.Collections.IDictionary]$Left,
  [System.Collections.IDictionary]$Right
) {
  if ($null -eq $Left -or $null -eq $Right -or $Left.Count -ne $Right.Count) { return $false }
  foreach ($key in $Left.Keys) {
    if (-not $Right.ContainsKey([string]$key) -or
        -not [string]::Equals([string]$Left[$key], [string]$Right[[string]$key], [StringComparison]::Ordinal)) {
      return $false
    }
  }
  return $true
}

function Get-FixtureEnvironmentDelta(
  [System.Collections.IDictionary]$Baseline,
  [System.Collections.IDictionary]$Candidate,
  [bool]$AllowPathExtOnly
) {
  if (Test-FixtureEnvironmentEqual $Baseline $Candidate) { return 'none' }
  if (-not $AllowPathExtOnly -or $Baseline.ContainsKey('PATHEXT') -or
      -not $Candidate.ContainsKey('PATHEXT') -or
      -not [string]::Equals([string]$Candidate['PATHEXT'], '.EXE', [StringComparison]::OrdinalIgnoreCase) -or
      $Candidate.Count -ne ($Baseline.Count + 1)) {
    return 'invalid'
  }
  foreach ($key in $Baseline.Keys) {
    if (-not $Candidate.ContainsKey([string]$key) -or
        -not [string]::Equals([string]$Baseline[$key], [string]$Candidate[[string]$key], [StringComparison]::Ordinal)) {
      return 'invalid'
    }
  }
  return 'pathext-only'
}

function ConvertFrom-WindowsNodeDiagnosticReceipt(
  [object]$RunResult,
  [string]$ExpectedMode,
  [string]$ExpectedCase
) {
  $invalid = [pscustomobject]@{ Valid = $false; Receipt = $null; Reason = 'invalid' }
  try {
    if ($null -eq $RunResult -or
        $null -eq $RunResult.PSObject.Properties['StandardOutput'] -or
        $RunResult.StandardOutput -isnot [string] -or
        $RunResult.StandardOutput.Length -gt 8192 -or
        $null -eq $RunResult.PSObject.Properties['StandardError'] -or
        $RunResult.StandardError -isnot [string] -or
        $RunResult.StandardError.Length -ne 0 -or
        $null -eq $RunResult.PSObject.Properties['ExitCode'] -or
        $RunResult.ExitCode -isnot [int]) {
      return $invalid
    }
  $allowedKeys = @(
    'schemaVersion', 'mode', 'measurement', 'exceptionKind', 'identityMatch', 'profileMatch', 'cwdMatch', 'executableMatch',
    'powershellVersion', 'runtimeVersion', 'pathextPresent', 'pathextState', 'pathextLength', 'pathextHasExe', 'pathextHasCmd', 'pathextExactExe',
    'argumentPassing', 'nativeErrorPreference', 'lastExitBeforePresent', 'lastExitBeforeType', 'lastExitBeforeCode',
    'invokeSucceeded', 'outputCount', 'runtimeMatch', 'lastExitAfterPresent', 'lastExitAfterType', 'lastExitAfterCode',
    'stderrBytes', 'stderrReadSucceeded', 'stderrTruncated', 'stderrCleanupConfirmed',
    'directStarted', 'directExitObserved', 'directExitCode', 'directStdoutBytes', 'directStderrBytes',
    'directStdoutEof', 'directStderrEof', 'directCleanupConfirmed', 'directFailure'
  )
  $lines = @(([string]$RunResult.StandardOutput -split "`r?`n") | Where-Object { $_ -ne '' })
  $receiptLines = @($lines | Where-Object { $_.StartsWith('WINDOWS_NODE_DIAGNOSTIC_RECEIPT=', [StringComparison]::Ordinal) })
  $otherLines = @($lines | Where-Object {
      $_ -cne 'RVW_NODE_DIAGNOSTIC_READY' -and
        -not $_.StartsWith('WINDOWS_NODE_DIAGNOSTIC_RECEIPT=', [StringComparison]::Ordinal)
    })
  if ($receiptLines.Count -ne 1 -or $otherLines.Count -ne 0) { return $invalid }
  $json = $receiptLines[0].Substring('WINDOWS_NODE_DIAGNOSTIC_RECEIPT='.Length)
  if ($json.Length -gt 7900) { return $invalid }
  $jsonDocument = [System.Text.Json.JsonDocument]::Parse($json)
  try {
    if ($jsonDocument.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return $invalid }
    $jsonPropertyNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $jsonDocument.RootElement.EnumerateObject()) {
      if (-not $jsonPropertyNames.Add($property.Name)) { return $invalid }
    }
  } finally {
    $jsonDocument.Dispose()
  }
  $receipt = ConvertFrom-Json -InputObject $json -AsHashtable -ErrorAction Stop
  if ($null -eq $receipt -or $receipt -isnot [System.Collections.IDictionary] -or
      $receipt.Count -ne $allowedKeys.Count -or
      @($receipt.Keys | Where-Object { $_ -notin $allowedKeys }).Count -ne 0) {
    return $invalid
  }
  foreach ($name in $allowedKeys) {
    if (@($receipt.Keys | Where-Object { [string]::Equals([string]$_, $name, [StringComparison]::Ordinal) }).Count -ne 1) {
      return $invalid
    }
  }
  if (($receipt.schemaVersion -isnot [int] -and $receipt.schemaVersion -isnot [long]) -or $receipt.schemaVersion -ne 1 -or
      $receipt.mode -cne $ExpectedMode -or $receipt.measurement -notin @('match', 'mismatch', 'exception') -or
      $receipt.exceptionKind -notin @('none', 'command-not-found', 'native-command', 'access-denied', 'io', 'invalid-operation', 'other') -or
      $receipt.pathextState -notin @('absent', 'empty', 'nonempty') -or
      $receipt.argumentPassing -notin @('Legacy', 'Standard', 'Windows', 'unknown') -or
      $receipt.nativeErrorPreference -notin @('true', 'false', 'unknown') -or
      $receipt.lastExitBeforeType -notin @('none', 'int32', 'other') -or
      $receipt.lastExitAfterType -notin @('none', 'int32', 'other')) {
    return $invalid
  }
  $booleanNames = @(
    'identityMatch', 'profileMatch', 'cwdMatch', 'executableMatch', 'pathextPresent', 'pathextHasExe', 'pathextHasCmd',
    'pathextExactExe', 'lastExitBeforePresent', 'invokeSucceeded', 'runtimeMatch', 'lastExitAfterPresent',
    'stderrReadSucceeded', 'stderrTruncated', 'stderrCleanupConfirmed', 'directStarted', 'directExitObserved',
    'directStdoutEof', 'directStderrEof', 'directCleanupConfirmed'
  )
  foreach ($name in $booleanNames) {
    if ($receipt[$name] -isnot [bool]) { return $invalid }
  }
  foreach ($name in @('outputCount', 'pathextLength', 'stderrBytes', 'directStdoutBytes', 'directStderrBytes')) {
    if ($receipt[$name] -isnot [int] -and $receipt[$name] -isnot [long]) { return $invalid }
    if ($receipt[$name] -lt 0 -or ($name -eq 'pathextLength' -and $receipt[$name] -gt 32767)) { return $invalid }
  }
  foreach ($name in @('powershellVersion', 'runtimeVersion', 'lastExitBeforeCode', 'lastExitAfterCode', 'directExitCode', 'directFailure')) {
    if ($receipt[$name] -isnot [string] -or $receipt[$name].Length -gt 64 -or
        $receipt[$name].Contains("`r") -or $receipt[$name].Contains("`n")) { return $invalid }
  }
  if ($receipt.powershellVersion -notmatch '^\d+(?:\.\d+){1,3}$' -or
      $receipt.runtimeVersion -notmatch '^\d+(?:\.\d+){1,3}$' -or
      ($receipt.pathextState -eq 'absent' -and ($receipt.pathextPresent -or $receipt.pathextLength -ne 0)) -or
      ($receipt.pathextState -eq 'empty' -and (-not $receipt.pathextPresent -or $receipt.pathextLength -ne 0)) -or
      ($receipt.pathextState -eq 'nonempty' -and (-not $receipt.pathextPresent -or $receipt.pathextLength -eq 0)) -or
      -not (Test-WindowsNodeExitEvidence $receipt.lastExitBeforePresent $receipt.lastExitBeforeType $receipt.lastExitBeforeCode) -or
      -not (Test-WindowsNodeExitEvidence $receipt.lastExitAfterPresent $receipt.lastExitAfterType $receipt.lastExitAfterCode)) {
    return $invalid
  }
  if (-not $receipt.identityMatch -or -not $receipt.profileMatch -or -not $receipt.cwdMatch -or -not $receipt.executableMatch) {
    return $invalid
  }
  if ($receipt.measurement -eq 'exception' -or -not $receipt.stderrReadSucceeded -or -not $receipt.stderrCleanupConfirmed -or
      $receipt.stderrBytes -gt 16777216 -or $receipt.outputCount -gt 2) {
    return $invalid
  }
  $expectedPathExtOverride = $ExpectedCase -in @('B', 'E')
  if ($expectedPathExtOverride) {
    if ($receipt.pathextState -ne 'nonempty' -or $receipt.pathextLength -ne 4 -or
        -not $receipt.pathextHasExe -or $receipt.pathextHasCmd -or -not $receipt.pathextExactExe) {
      return $invalid
    }
  } elseif ($receipt.pathextHasExe -or $receipt.pathextExactExe) {
    return $invalid
  }
  if ($ExpectedMode -in @('runtime-null', 'runtime-file')) {
    if ($receipt.directStarted -or $receipt.directExitObserved -or $receipt.directExitCode -cne 'none' -or
        $receipt.directStdoutBytes -ne 0 -or $receipt.directStderrBytes -ne 0 -or $receipt.directStdoutEof -or
        $receipt.directStderrEof -or $receipt.directCleanupConfirmed -or $receipt.directFailure -cne 'not-run') {
      return $invalid
    }
    $expectedMatch = $receipt.invokeSucceeded -and $receipt.outputCount -eq 1 -and $receipt.runtimeMatch -and
      $receipt.lastExitAfterPresent -and $receipt.lastExitAfterType -eq 'int32' -and $receipt.lastExitAfterCode -eq '0'
  } elseif ($ExpectedMode -eq 'exit17') {
    if ($receipt.directStarted -or $receipt.directExitObserved -or $receipt.directExitCode -cne 'none' -or
        $receipt.directStdoutBytes -ne 0 -or $receipt.directStderrBytes -ne 0 -or $receipt.directStdoutEof -or
        $receipt.directStderrEof -or $receipt.directCleanupConfirmed -or $receipt.directFailure -cne 'not-run') {
      return $invalid
    }
    $expectedMatch = -not $receipt.invokeSucceeded -and $receipt.outputCount -eq 0 -and $receipt.runtimeMatch -and
      $receipt.lastExitAfterPresent -and $receipt.lastExitAfterType -eq 'int32' -and $receipt.lastExitAfterCode -eq '17'
  } elseif ($ExpectedMode -eq 'direct') {
    if ($receipt.directFailure -notin @(
        'none', 'input-invalid', 'start-returned-false', 'start-exception', 'probe-setup-failed', 'exit-observation-failed',
        'stdin-close-failed', 'execution-timeout', 'probe-exception', 'cleanup-unconfirmed', 'exit-nonzero',
        'runtime-output-mismatch', 'unexpected-stderr'
      ) -or -not $receipt.directStarted -or -not $receipt.directExitObserved -or
        -not $receipt.directStdoutEof -or -not $receipt.directStderrEof -or -not $receipt.directCleanupConfirmed -or
        -not (Test-WindowsNodeExitEvidence $receipt.directExitObserved 'int32' $receipt.directExitCode)) {
      return $invalid
    }
    $expectedMatch = $receipt.directFailure -eq 'none' -and $receipt.directExitCode -eq '0' -and $receipt.runtimeMatch
  } else {
    return $invalid
  }
  if (($receipt.measurement -eq 'match') -ne [bool]$expectedMatch -or
      $RunResult.ExitCode -ne $(if ($expectedMatch) { 0 } else { 90 })) {
    return $invalid
  }
  return [pscustomobject]@{ Valid = $true; Receipt = $receipt; Reason = 'none' }
  } catch {
    return $invalid
  }
}

function Test-WindowsNodeExitEvidence([bool]$Present, [string]$Type, [string]$Code) {
  if ($Type -eq 'none') { return (-not $Present -and $Code -ceq 'none') }
  if ($Type -eq 'other') { return ($Present -and $Code -ceq 'none') }
  if ($Type -ne 'int32' -or -not $Present -or $Code -notmatch '^-?\d{1,10}$') { return $false }
  $parsed = 0
  if (-not [int]::TryParse($Code, [Globalization.NumberStyles]::Integer, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    return $false
  }
  return $parsed.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $Code
}

function Test-WindowsNodeDiagnosticSupervision(
  [object]$RunResult,
  [string]$ExpectedSid,
  [string]$ExpectedProfile
) {
  if ($null -eq $RunResult) { return $false }
  $required = @(
    'FailureCode', 'CleanupFailureCode', 'ExitObserved', 'GoAttempted', 'GoSent', 'TimedOut',
    'CleanupConfirmed', 'EnvironmentValidated', 'Token'
  )
  foreach ($name in $required) {
    if ($null -eq $RunResult.PSObject.Properties[$name]) { return $false }
  }
  foreach ($name in @('ExitObserved', 'GoAttempted', 'GoSent', 'TimedOut', 'CleanupConfirmed', 'EnvironmentValidated')) {
    if ($RunResult.$name -isnot [bool]) { return $false }
  }
  if ($RunResult.FailureCode -or $RunResult.CleanupFailureCode -or
      -not $RunResult.ExitObserved -or -not $RunResult.GoAttempted -or -not $RunResult.GoSent -or
      $RunResult.TimedOut -or -not $RunResult.CleanupConfirmed -or -not $RunResult.EnvironmentValidated -or
      $null -eq $RunResult.Token) {
    return $false
  }
  $token = $RunResult.Token
  foreach ($name in @('Sid', 'IntegritySid', 'ElevationType', 'IsElevated', 'HasAdministratorsSid', 'ProfileHiveLoaded', 'ProfilePath')) {
    if ($null -eq $token.PSObject.Properties[$name]) { return $false }
  }
  foreach ($name in @('IsElevated', 'HasAdministratorsSid', 'ProfileHiveLoaded')) {
    if ($token.$name -isnot [bool]) { return $false }
  }
  if ($token.Sid -isnot [string] -or $token.IntegritySid -isnot [string] -or
      $token.ElevationType -isnot [int] -or $token.ProfilePath -isnot [string]) {
    return $false
  }
  $profileMatches = if ($IsWindows) {
    [WindowsHarnessNative]::ProfilePathsEqual($token.ProfilePath, $ExpectedProfile)
  } else {
    [string]::Equals($token.ProfilePath, $ExpectedProfile, [StringComparison]::Ordinal)
  }
  return [string]::Equals($token.Sid, $ExpectedSid, [StringComparison]::Ordinal) -and
    -not $token.IsElevated -and -not $token.HasAdministratorsSid -and
    $token.ElevationType -eq 1 -and $token.IntegritySid -ceq 'S-1-16-8192' -and
    $token.ProfileHiveLoaded -and $profileMatches
}

function Invoke-WindowsNodeInvocationDiagnostics(
  [System.Collections.IDictionary]$BaseEnvironment,
  [string]$PowerShellPath,
  [string]$DiagnosticScriptPath,
  [string]$WorkingDirectory,
  [string]$ExpectedSid,
  [string]$ExpectedProfile,
  [scriptblock]$Runner,
  [string]$SourceSha,
  [string]$TreeSha,
  [string]$ArchiveSha256,
  [bool]$DiagnosticScriptHashMatch,
  [string]$RunId,
  [string]$RunAttempt
) {
  $result = [pscustomobject]@{
    Complete = $false
    RetentionRequired = $true
    StopReason = 'not-started'
    Cases = [System.Collections.Generic.List[object]]::new()
  }
  if ($null -eq $Runner -or -not $DiagnosticScriptHashMatch -or
      -not (Test-Path -LiteralPath $DiagnosticScriptPath -PathType Leaf)) {
    $result.StopReason = 'diagnostic-source-invalid'
    return $result
  }
  $baseline = Copy-FixtureEnvironment $BaseEnvironment
  if ($baseline.ContainsKey('PATHEXT')) {
    $result.StopReason = 'baseline-already-has-pathext'
    return $result
  }
  $baselineBefore = Copy-FixtureEnvironment $baseline
  $plan = @(
    [pscustomobject]@{ Case = 'A'; Mode = 'runtime-null'; AddPathExt = $false },
    [pscustomobject]@{ Case = 'B'; Mode = 'runtime-null'; AddPathExt = $true },
    [pscustomobject]@{ Case = 'A2'; Mode = 'runtime-null'; AddPathExt = $false },
    [pscustomobject]@{ Case = 'C'; Mode = 'runtime-file'; AddPathExt = $false },
    [pscustomobject]@{ Case = 'D'; Mode = 'direct'; AddPathExt = $false },
    [pscustomobject]@{ Case = 'E'; Mode = 'exit17'; AddPathExt = $true }
  )
  [Console]::Out.WriteLine("WINDOWS_NODE_DIAGNOSTIC_PROVENANCE sourceSha=$SourceSha treeSha=$TreeSha archiveSha256=$ArchiveSha256 diagnosticScriptHashMatch=$($DiagnosticScriptHashMatch.ToString().ToLowerInvariant()) runId=$RunId runAttempt=$RunAttempt")
  $bMatched = $false
  $baselinePathExtEvidence = $null
  foreach ($item in $plan) {
    if ($item.Case -eq 'E' -and -not $bMatched) {
      $result.Cases.Add([pscustomobject]@{
          Case = 'E'
          Mode = 'exit17'
          EnvironmentDelta = 'pathext-only'
          Measurement = 'skipped'
          Supervision = 'not-run'
          Receipt = 'not-run'
          CleanupConfirmed = $true
          Result = $null
        })
      [Console]::Out.WriteLine('WINDOWS_NODE_INVOCATION case=E mode=exit17 environmentDelta=pathext-only measurement=skipped supervision=not-run receipt=not-run cleanupConfirmed=true reason=B_not_match')
      continue
    }
    $caseEnvironment = Copy-FixtureEnvironment $baseline
    if ($item.AddPathExt) { $caseEnvironment['PATHEXT'] = '.EXE' }
    $environmentDelta = Get-FixtureEnvironmentDelta $baseline $caseEnvironment ([bool]$item.AddPathExt)
    $expectedEnvironmentDelta = if ($item.AddPathExt) { 'pathext-only' } else { 'none' }
    $caseArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $DiagnosticScriptPath, '-Mode', $item.Mode)
    if ($environmentDelta -cne $expectedEnvironmentDelta) {
      $result.StopReason = 'environment-delta-invalid'
      [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=invalid measurement=unknown supervision=failed receipt=invalid cleanupConfirmed=false")
      return $result
    }
    $caseEnvironmentBefore = Copy-FixtureEnvironment $caseEnvironment
    $runResult = $null
    try { $runResult = & $Runner $PowerShellPath $caseArguments $WorkingDirectory $caseEnvironment 30 30 15 } catch {
      $result.StopReason = 'runner-threw'
      [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=$environmentDelta measurement=unknown supervision=failed receipt=invalid cleanupConfirmed=false")
      return $result
    }
    $supervisionConfirmed = Test-WindowsNodeDiagnosticSupervision $runResult $ExpectedSid $ExpectedProfile
    if (-not $supervisionConfirmed) {
      $result.StopReason = 'supervision-unconfirmed'
      [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=$environmentDelta measurement=unknown supervision=failed receipt=invalid cleanupConfirmed=false")
      return $result
    }
    $parsed = ConvertFrom-WindowsNodeDiagnosticReceipt $runResult $item.Mode $item.Case
    if (-not $parsed.Valid -or -not (Test-FixtureEnvironmentEqual $caseEnvironment $caseEnvironmentBefore)) {
      $result.StopReason = 'receipt-invalid'
      [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=$environmentDelta measurement=unknown supervision=confirmed receipt=invalid cleanupConfirmed=true")
      return $result
    }
    if (-not (Test-FixtureEnvironmentEqual $baseline $baselineBefore) -or
        -not (Test-FixtureEnvironmentEqual $BaseEnvironment $baselineBefore)) {
      $result.StopReason = 'baseline-environment-mutated'
      [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=$environmentDelta measurement=unknown supervision=confirmed receipt=invalid cleanupConfirmed=true")
      return $result
    }
    $receipt = $parsed.Receipt
    $pathExtEvidence = @(
      $receipt.pathextPresent.ToString().ToLowerInvariant(),
      $receipt.pathextState,
      $receipt.pathextLength.ToString([Globalization.CultureInfo]::InvariantCulture),
      $receipt.pathextHasExe.ToString().ToLowerInvariant(),
      $receipt.pathextHasCmd.ToString().ToLowerInvariant(),
      $receipt.pathextExactExe.ToString().ToLowerInvariant()
    ) -join '|'
    if ($item.Case -eq 'A') {
      $baselinePathExtEvidence = $pathExtEvidence
    } elseif ($item.Case -in @('A2', 'C', 'D') -and
        ($null -eq $baselinePathExtEvidence -or $pathExtEvidence -cne $baselinePathExtEvidence)) {
      $result.StopReason = 'baseline-pathext-mutated'
      return $result
    }
    if ($item.Case -eq 'B') { $bMatched = $receipt.measurement -eq 'match' }
    $caseResult = [pscustomobject]@{
      Case = $item.Case
      Mode = $item.Mode
      EnvironmentDelta = $environmentDelta
      Measurement = $receipt.measurement
      Supervision = 'confirmed'
      Receipt = 'complete'
      CleanupConfirmed = $true
      Result = $receipt
    }
    $result.Cases.Add($caseResult)
    [Console]::Out.WriteLine("WINDOWS_NODE_INVOCATION case=$($item.Case) mode=$($item.Mode) environmentDelta=$environmentDelta measurement=$($receipt.measurement) supervision=confirmed receipt=complete cleanupConfirmed=true identityMatch=$($receipt.identityMatch.ToString().ToLowerInvariant()) profileMatch=$($receipt.profileMatch.ToString().ToLowerInvariant()) cwdMatch=$($receipt.cwdMatch.ToString().ToLowerInvariant()) executableMatch=$($receipt.executableMatch.ToString().ToLowerInvariant()) powershellVersion=$($receipt.powershellVersion) runtimeVersion=$($receipt.runtimeVersion) pathextPresent=$($receipt.pathextPresent.ToString().ToLowerInvariant()) pathextState=$($receipt.pathextState) pathextLength=$($receipt.pathextLength) pathextHasExe=$($receipt.pathextHasExe.ToString().ToLowerInvariant()) pathextHasCmd=$($receipt.pathextHasCmd.ToString().ToLowerInvariant()) pathextExactExe=$($receipt.pathextExactExe.ToString().ToLowerInvariant()) argumentPassing=$($receipt.argumentPassing) nativeErrorPreference=$($receipt.nativeErrorPreference) lastExitBeforePresent=$($receipt.lastExitBeforePresent.ToString().ToLowerInvariant()) lastExitBeforeType=$($receipt.lastExitBeforeType) lastExitBeforeCode=$($receipt.lastExitBeforeCode) invokeSucceeded=$($receipt.invokeSucceeded.ToString().ToLowerInvariant()) outputCount=$($receipt.outputCount) runtimeMatch=$($receipt.runtimeMatch.ToString().ToLowerInvariant()) lastExitAfterPresent=$($receipt.lastExitAfterPresent.ToString().ToLowerInvariant()) lastExitAfterType=$($receipt.lastExitAfterType) lastExitAfterCode=$($receipt.lastExitAfterCode) stderrBytes=$($receipt.stderrBytes) stderrReadSucceeded=$($receipt.stderrReadSucceeded.ToString().ToLowerInvariant()) stderrTruncated=$($receipt.stderrTruncated.ToString().ToLowerInvariant()) directStarted=$($receipt.directStarted.ToString().ToLowerInvariant()) directExitObserved=$($receipt.directExitObserved.ToString().ToLowerInvariant()) directExitCode=$($receipt.directExitCode) directStdoutBytes=$($receipt.directStdoutBytes) directStderrBytes=$($receipt.directStderrBytes) directStdoutEof=$($receipt.directStdoutEof.ToString().ToLowerInvariant()) directStderrEof=$($receipt.directStderrEof.ToString().ToLowerInvariant()) directCleanupConfirmed=$($receipt.directCleanupConfirmed.ToString().ToLowerInvariant()) directFailure=$($receipt.directFailure)")
  }
  if (-not (Test-FixtureEnvironmentEqual $BaseEnvironment $baselineBefore)) {
    $result.StopReason = 'baseline-environment-mutated'
    return $result
  }
  $result.Complete = $true
  $result.RetentionRequired = $false
  $result.StopReason = 'none'
  return $result
}

function New-WindowsNodeDiagnosticBootstrap(
  [string]$ArchivePath,
  [string]$ExpectedArchiveSha256,
  [string]$BootstrapDirectory
) {
  $destination = Join-Path $BootstrapDirectory 'windows-node-invocation-diagnostic.ps1'
  $result = [pscustomobject]@{ Ready = $false; Reason = 'not-started'; Path = $destination; ScriptSha256 = 'none' }
  $archiveStream = $null
  $archive = $null
  $entryStream = $null
  $contentStream = $null
  $destinationStream = $null
  $sha = $null
  $stage = 'input'
  try {
    if ($ExpectedArchiveSha256 -notmatch '^[0-9a-f]{64}$') {
      $result.Reason = 'archive-hash-invalid'
      return $result
    }
    $bootstrapItem = Get-Item -LiteralPath $BootstrapDirectory -Force -ErrorAction Stop
    if (-not $bootstrapItem.PSIsContainer -or ($bootstrapItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $result.Reason = 'bootstrap-directory-unsafe'
      return $result
    }
    if (Test-Path -LiteralPath $destination) {
      $result.Reason = 'destination-exists'
      return $result
    }
    $stage = 'archive-hash'
    $observedArchiveHash = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if (-not [string]::Equals($observedArchiveHash, $ExpectedArchiveSha256, [StringComparison]::Ordinal)) {
      $result.Reason = 'archive-hash-mismatch'
      return $result
    }

    $stage = 'archive-open'
    $archiveStream = [IO.File]::Open($ArchivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
    $entryName = 'scripts/ci/windows-node-invocation-diagnostic.ps1'
    $entries = @($archive.Entries | Where-Object { [string]::Equals($_.FullName, $entryName, [StringComparison]::Ordinal) })
    if ($entries.Count -eq 0) {
      $result.Reason = 'entry-missing'
      return $result
    }
    if ($entries.Count -ne 1) {
      $result.Reason = 'entry-duplicate'
      return $result
    }
    if ($entries[0].Length -le 0 -or $entries[0].Length -gt 65536) {
      $result.Reason = 'entry-size-invalid'
      return $result
    }

    $stage = 'entry-read'
    $entryStream = $entries[0].Open()
    $contentStream = [IO.MemoryStream]::new()
    $entryStream.CopyTo($contentStream)
    if ($contentStream.Length -ne $entries[0].Length) {
      $result.Reason = 'entry-length-mismatch'
      return $result
    }
    $content = $contentStream.ToArray()
    $sha = [Security.Cryptography.SHA256]::Create()
    $entryHash = [Convert]::ToHexString($sha.ComputeHash($content)).ToLowerInvariant()

    $stage = 'destination-write'
    $destinationStream = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $destinationStream.Write($content, 0, $content.Length)
    $destinationStream.Flush($true)
    $destinationStream.Dispose()
    $destinationStream = $null

    $stage = 'destination-verify'
    $destinationItem = Get-Item -LiteralPath $destination -Force -ErrorAction Stop
    if ($destinationItem.PSIsContainer -or ($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $destinationItem.Length -ne $content.Length) {
      $result.Reason = 'destination-unsafe'
      return $result
    }
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if (-not [string]::Equals($entryHash, $destinationHash, [StringComparison]::Ordinal)) {
      $result.Reason = 'entry-copy-hash-mismatch'
      return $result
    }
    $result.Ready = $true
    $result.Reason = 'none'
    $result.ScriptSha256 = $entryHash
    return $result
  } catch {
    $result.Reason = switch ($stage) {
      'archive-hash' { 'archive-read-failed' }
      'archive-open' { 'archive-invalid' }
      'entry-read' { 'entry-read-failed' }
      'destination-write' { 'destination-write-failed' }
      'destination-verify' { 'destination-verify-failed' }
      default { 'bootstrap-input-invalid' }
    }
    return $result
  } finally {
    if ($null -ne $destinationStream) { $destinationStream.Dispose() }
    if ($null -ne $contentStream) { $contentStream.Dispose() }
    if ($null -ne $entryStream) { $entryStream.Dispose() }
    if ($null -ne $archive) { $archive.Dispose() }
    elseif ($null -ne $archiveStream) { $archiveStream.Dispose() }
    if ($null -ne $sha) { $sha.Dispose() }
  }
}

function Get-WindowsNodeDiagnosticGate([object]$BaselineResult, [bool]$BootstrapReady, [string]$ExpectedSid, [string]$ExpectedProfile) {
  $gate = [pscustomobject]@{ TargetFailure = $false; ShouldRun = $false; Reason = 'baseline-not-targeted' }
  if ($null -eq $BaselineResult -or
      $null -eq $BaselineResult.PSObject.Properties['ExitCode'] -or
      $BaselineResult.ExitCode -isnot [int] -or $BaselineResult.ExitCode -ne 90 -or
      $null -eq $BaselineResult.PSObject.Properties['StandardError'] -or
      $BaselineResult.StandardError -isnot [string]) {
    return $gate
  }
  if (-not (Test-WindowsNodeDiagnosticSupervision $BaselineResult $ExpectedSid $ExpectedProfile)) {
    $gate.Reason = 'baseline-supervision-unconfirmed'
    return $gate
  }
  $lines = @([Regex]::Split($BaselineResult.StandardError, '\r\n|\n|\r'))
  if ($lines.Count -eq 2 -and $lines[1] -ceq '') { $lines = @($lines[0]) }
  if ($lines.Count -ne 1 -or $lines[0] -cne 'WINDOWS_IDENTITY_PREFLIGHT_FAILED: Node runtime probe failed') {
    return $gate
  }
  $gate.TargetFailure = $true
  if (-not $BootstrapReady) {
    $gate.Reason = 'diagnostic-bootstrap-unverified'
    return $gate
  }
  $gate.ShouldRun = $true
  $gate.Reason = 'none'
  return $gate
}

function Invoke-WindowsNodeDiagnosticsFailClosed([int]$BaselineExitCode, [object]$Gate, [scriptblock]$DiagnosticInvoker) {
  $retentionRequired = $false
  if ($null -ne $Gate -and $null -ne $Gate.PSObject.Properties['TargetFailure'] -and $Gate.TargetFailure -is [bool]) {
    $retentionRequired = $Gate.TargetFailure
  }
  $attempt = [pscustomobject]@{
    ExitCode = $BaselineExitCode
    Complete = $false
    RetentionRequired = $retentionRequired
    Reason = 'gate-unavailable'
    FailureStage = 'none'
    FailureKind = 'none'
    MissingFunction = $false
  }
  if ($null -ne $Gate -and $null -ne $Gate.PSObject.Properties['Reason'] -and $Gate.Reason -is [string]) {
    $attempt.Reason = $Gate.Reason
  }
  try {
    if ($null -eq $Gate -or $Gate.TargetFailure -isnot [bool] -or $Gate.ShouldRun -isnot [bool]) {
      $attempt.Reason = 'gate-invalid'
      return $attempt
    }
    if (-not $Gate.TargetFailure -or -not $Gate.ShouldRun) { return $attempt }
    if ($null -eq $DiagnosticInvoker) {
      $attempt.Reason = 'diagnostic-invoker-missing'
      return $attempt
    }
    $diagnosticResult = & $DiagnosticInvoker
    if ($diagnosticResult -isnot [pscustomobject] -or
        $null -eq $diagnosticResult.PSObject.Properties['Complete'] -or
        $null -eq $diagnosticResult.PSObject.Properties['RetentionRequired'] -or
        $diagnosticResult.Complete -isnot [bool] -or
        $diagnosticResult.RetentionRequired -isnot [bool] -or
        -not $diagnosticResult.Complete -or $diagnosticResult.RetentionRequired) {
      $attempt.Reason = 'diagnostic-result-unconfirmed'
      return $attempt
    }
    $attempt.Complete = $true
    $attempt.RetentionRequired = $false
    $attempt.Reason = 'none'
    return $attempt
  } catch {
    $attempt.Reason = 'diagnostic-exception'
    $attempt.FailureStage = 'invoker'
    if ($_.Exception -is [Management.Automation.CommandNotFoundException]) {
      $attempt.FailureKind = 'command-not-found'
      $attempt.MissingFunction = $true
    } else {
      $attempt.FailureKind = 'other'
    }
    return $attempt
  }
}

function Invoke-WindowsDiagnosticNativeRunAsUser(
  [string]$Executable,
  [string[]]$Arguments,
  [string]$UserName,
  [string]$Domain,
  [Security.SecureString]$Password,
  [string]$WorkingDirectory,
  [System.Collections.IDictionary]$Environment,
  [string]$ExpectedSid,
  [string]$ReadyMarker,
  [int]$ReadyTimeoutSeconds,
  [int]$ExecutionTimeoutSeconds,
  [int]$CleanupTimeoutSeconds
) {
  return [WindowsHarnessNative]::RunAsUser(
    $Executable,
    $Arguments,
    $UserName,
    $Domain,
    $Password,
    $WorkingDirectory,
    $Environment,
    $ExpectedSid,
    $ReadyMarker,
    $ReadyTimeoutSeconds,
    $ExecutionTimeoutSeconds,
    $CleanupTimeoutSeconds
  )
}

function Get-WindowsFixturePathState([string]$Path) {
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return 'unsafe'
    }
    return 'directory'
  } catch {
    if ($_.Exception -is [System.Management.Automation.ItemNotFoundException] -and
        $_.FullyQualifiedErrorId -like 'PathNotFound,*') {
      return 'missing'
    }
    return 'unknown'
  }
}

function Complete-WindowsHarnessFixture(
  [bool]$RetentionRequired,
  [string]$AccountSid,
  [string]$AccountName,
  [string]$FixtureRoot,
  [string]$RunnerTempRoot
) {
  if ($RetentionRequired) {
    return [pscustomobject]@{ Status = 'retained'; Reason = 'PROCESS_CLEANUP_UNCONFIRMED'; CleanupFailed = $true; OwnerScan = $null }
  }
  if ([string]::IsNullOrWhiteSpace($AccountSid)) {
    return [pscustomobject]@{ Status = 'not-needed'; Reason = 'NO_ACCOUNT'; CleanupFailed = $false; OwnerScan = $null }
  }

  $processScan = Get-FixtureProcessScanResult $AccountSid
  if ($processScan.State -ne 'clear') {
    return [pscustomobject]@{
      Status = 'retained'
      Reason = "OWNER_SCAN_$($processScan.State)"
      CleanupFailed = $true
      OwnerScan = $processScan
    }
  }

  try {
    if ([string]::IsNullOrWhiteSpace($AccountName)) {
      throw 'ACCOUNT_NAME_MISSING'
    }
    Remove-LocalUser -Name $AccountName -ErrorAction Stop | Out-Null
    $remainingAccounts = @(
      Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -ceq $AccountSid }
    )
    if ($remainingAccounts.Count -ne 0) {
      return [pscustomobject]@{
        Status = 'retained'
        Reason = 'ACCOUNT_REMOVAL_UNCONFIRMED'
        CleanupFailed = $true
        OwnerScan = $processScan
      }
    }
  } catch {
    return [pscustomobject]@{
      Status = 'retained'
      Reason = 'ACCOUNT_REMOVAL_UNCONFIRMED'
      CleanupFailed = $true
      OwnerScan = $processScan
    }
  }

  if ([string]::IsNullOrWhiteSpace($FixtureRoot)) {
    return [pscustomobject]@{ Status = 'cleaned'; Reason = 'none'; CleanupFailed = $false; OwnerScan = $processScan }
  }
  $fixturePathState = Get-WindowsFixturePathState $FixtureRoot
  if ($fixturePathState -eq 'missing') {
    return [pscustomobject]@{ Status = 'cleaned'; Reason = 'none'; CleanupFailed = $false; OwnerScan = $processScan }
  }
  if ($fixturePathState -ne 'directory') {
    return [pscustomobject]@{
      Status = 'failed'
      Reason = 'FIXTURE_PATH_UNSAFE'
      CleanupFailed = $true
      OwnerScan = $processScan
    }
  }
  try {
    $resolvedTemp = [IO.Path]::GetFullPath($RunnerTempRoot)
    $resolvedFixture = [IO.Path]::GetFullPath($FixtureRoot)
    $relative = [IO.Path]::GetRelativePath($resolvedTemp, $resolvedFixture)
    $separator = [IO.Path]::DirectorySeparatorChar.ToString()
    if ($relative -eq '.' -or
        $relative -eq '..' -or
        $relative.StartsWith("..$separator", [StringComparison]::Ordinal) -or
        [IO.Path]::IsPathRooted($relative) -or
        (Split-Path -Leaf $resolvedFixture) -notlike 'revo-windows-identity-*') {
      throw 'FIXTURE_PATH_NOT_UNIQUE_RUNNER_TEMP'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force -ErrorAction Stop | Out-Null
  } catch {
    return [pscustomobject]@{
      Status = 'failed'
      Reason = 'FIXTURE_REMOVAL_FAILED'
      CleanupFailed = $true
      OwnerScan = $processScan
    }
  }
  if ((Get-WindowsFixturePathState $resolvedFixture) -ne 'missing') {
    return [pscustomobject]@{
      Status = 'failed'
      Reason = 'FIXTURE_REMOVAL_UNCONFIRMED'
      CleanupFailed = $true
      OwnerScan = $processScan
    }
  }
  return [pscustomobject]@{ Status = 'cleaned'; Reason = 'none'; CleanupFailed = $false; OwnerScan = $processScan }
}

function Get-FinalWindowsHarnessExitCode([int]$ChildExitCode, [bool]$CleanupFailed) {
  if ($ChildExitCode -eq 0 -and $CleanupFailed) {
    return 1
  }
  return $ChildExitCode
}

function Assert-NodeToolCacheItem([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      ($Directory -and -not $item.PSIsContainer) -or
      (-not $Directory -and $item.PSIsContainer)) {
    throw 'Node tool-cache entry is not a regular expected filesystem item.'
  }
}

function Assert-NodeToolCacheRoot([string]$Path) {
  if ($IsWindows -and $Path -notmatch '^[A-Za-z]:\\') {
    throw 'RUNNER_TOOL_CACHE must be a local drive path.'
  }
  $root = [IO.Path]::GetPathRoot($Path)
  if ([string]::IsNullOrEmpty($root)) {
    throw 'RUNNER_TOOL_CACHE has no filesystem root.'
  }
  $current = $root
  foreach ($component in $Path.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $component
    Assert-NodeToolCacheItem $current $true
  }
}

function Get-NodeToolCacheInstallation([string]$RepositoryRoot) {
  $versionFile = Join-Path $RepositoryRoot '.nvmrc'
  $nodeVersion = [IO.File]::ReadAllText($versionFile).Trim()
  if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Node version file does not contain one exact semantic version.'
  }
  if ($nodeVersion -cne '26.8.2') {
    throw 'Node version file does not match the Windows test target.'
  }
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TOOL_CACHE) -or
      -not [IO.Path]::IsPathFullyQualified($env:RUNNER_TOOL_CACHE)) {
    throw 'RUNNER_TOOL_CACHE is missing or is not absolute.'
  }

  $cacheRoot = [IO.Path]::GetFullPath($env:RUNNER_TOOL_CACHE)
  Assert-NodeToolCacheRoot $cacheRoot
  $nodeRoot = Join-Path $cacheRoot 'node'
  $versionRoot = Join-Path $nodeRoot $nodeVersion
  $nodeDirectory = Join-Path $versionRoot 'x64'
  $completeMarker = "$nodeDirectory.complete"
  $nodePath = Join-Path $nodeDirectory 'node.exe'
  $npmPath = Join-Path $nodeDirectory 'npm.cmd'
  $nodeModules = Join-Path $nodeDirectory 'node_modules'
  $npmRoot = Join-Path $nodeModules 'npm'
  $npmPackagePath = Join-Path $npmRoot 'package.json'
  $npmCliPath = Join-Path $npmRoot 'bin/npm-cli.js'

  foreach ($directory in @($cacheRoot, $nodeRoot, $versionRoot, $nodeDirectory, $nodeModules, $npmRoot, (Join-Path $npmRoot 'bin'))) {
    Assert-NodeToolCacheItem $directory $true
  }
  foreach ($file in @($completeMarker, $nodePath, $npmPath, $npmPackagePath, $npmCliPath)) {
    Assert-NodeToolCacheItem $file $false
  }

  $npmPackage = [IO.File]::ReadAllText($npmPackagePath) | ConvertFrom-Json -ErrorAction Stop
  $npmVersion = [string]$npmPackage.version
  if ($npmPackage.name -cne 'npm' -or $npmVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'Bundled npm package version is invalid.'
  }

  return [pscustomobject]@{
    NodeVersion = $nodeVersion
    NodeDirectory = $nodeDirectory
    NodePath = $nodePath
    NpmPath = $npmPath
    NpmVersion = $npmVersion
  }
}

function Get-ExecutableInputEvidence([object]$Value, [object]$ResolvedSelection) {
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
  $matchesResolvedSelection = $false
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
    $matchesResolvedSelection = $ResolvedSelection -is [string] -and
      [string]::Equals($Value, $ResolvedSelection, [StringComparison]::OrdinalIgnoreCase)
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
    MatchesResolvedSelection = $matchesResolvedSelection
    Valid = $valueKind -eq 'string' -and $nonblank -and $fullyQualified -and $localDrive -and
      -not $hasControl -and -not $hasDoubleQuote -and -not $surroundingWhitespace -and $matchesResolvedSelection
  }
}

$accountName = $null
$accountSid = $null
$fixtureRoot = $null
$securePassword = $null
$nativeResult = $null
$diagnosticBootstrap = [pscustomobject]@{ Ready = $false; Reason = 'not-prepared'; Path = 'none'; ScriptSha256 = 'none' }
$cleanupFailure = $false
$scriptExitCode = 0
$retainFixtureForProcess = $false

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

  try {
    $nodeInstallation = Get-NodeToolCacheInstallation $sourceRoot
  } catch {
    throw 'NODE_TOOLCACHE_PREFLIGHT_FAILED'
  }
  Write-Output "NODE_SELECTION source=toolcache version=$($nodeInstallation.NodeVersion) arch=x64 pairValid=true"
  $nodePath = $nodeInstallation.NodePath
  $npmPath = $nodeInstallation.NpmPath
  $nodeDirectory = $nodeInstallation.NodeDirectory
  $nodeInputEvidence = Get-ExecutableInputEvidence $nodePath $nodeInstallation.NodePath
  $npmInputEvidence = Get-ExecutableInputEvidence $npmPath $nodeInstallation.NpmPath
  Write-Output "WINDOWS_EXECUTABLE_INPUT name=node kind=$($nodeInputEvidence.ValueKind) length=$($nodeInputEvidence.Length) nonblank=$($nodeInputEvidence.Nonblank.ToString().ToLowerInvariant()) fullyQualified=$($nodeInputEvidence.FullyQualified.ToString().ToLowerInvariant()) localDrive=$($nodeInputEvidence.LocalDrive.ToString().ToLowerInvariant()) hasControl=$($nodeInputEvidence.HasControl.ToString().ToLowerInvariant()) hasDoubleQuote=$($nodeInputEvidence.HasDoubleQuote.ToString().ToLowerInvariant()) surroundingWhitespace=$($nodeInputEvidence.SurroundingWhitespace.ToString().ToLowerInvariant()) matchesResolvedSelection=$($nodeInputEvidence.MatchesResolvedSelection.ToString().ToLowerInvariant())"
  Write-Output "WINDOWS_EXECUTABLE_INPUT name=npm kind=$($npmInputEvidence.ValueKind) length=$($npmInputEvidence.Length) nonblank=$($npmInputEvidence.Nonblank.ToString().ToLowerInvariant()) fullyQualified=$($npmInputEvidence.FullyQualified.ToString().ToLowerInvariant()) localDrive=$($npmInputEvidence.LocalDrive.ToString().ToLowerInvariant()) hasControl=$($npmInputEvidence.HasControl.ToString().ToLowerInvariant()) hasDoubleQuote=$($npmInputEvidence.HasDoubleQuote.ToString().ToLowerInvariant()) surroundingWhitespace=$($npmInputEvidence.SurroundingWhitespace.ToString().ToLowerInvariant()) matchesResolvedSelection=$($npmInputEvidence.MatchesResolvedSelection.ToString().ToLowerInvariant())"
  if (-not $nodeInputEvidence.Valid -or -not $npmInputEvidence.Valid) {
    throw 'EXECUTABLE_INPUT_PREFLIGHT_FAILED'
  }
  $pwshPath = [IO.Path]::GetFullPath((Join-Path $PSHOME 'pwsh.exe'))
  if (-not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) {
    throw 'Current PowerShell executable is missing.'
  }
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
  try {
    $diagnosticBootstrap = New-WindowsNodeDiagnosticBootstrap $archivePath $archiveHash $bootstrap
  } catch {
    $diagnosticBootstrap = [pscustomobject]@{
      Ready = $false
      Reason = 'bootstrap-initialization-failed'
      Path = (Join-Path $bootstrap 'windows-node-invocation-diagnostic.ps1')
      ScriptSha256 = 'none'
    }
  }
  Write-Output "WINDOWS_NODE_DIAGNOSTIC_BOOTSTRAP ready=$($diagnosticBootstrap.Ready.ToString().ToLowerInvariant()) reason=$($diagnosticBootstrap.Reason) scriptSha256=$($diagnosticBootstrap.ScriptSha256)"

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
  $environment['REVO_EXPECTED_NODE_VERSION'] = "v$($nodeInstallation.NodeVersion)"
  $environment['REVO_EXPECTED_NPM_VERSION'] = $nodeInstallation.NpmVersion
  $environment['REVO_PWSH_EXE'] = $pwshPath
  $environment['REVO_TOKEN_PROBE_SCRIPT'] = Join-Path $bootstrap 'windows-token-probe.ps1'
  $environment['REVO_RUN_ID'] = $env:GITHUB_RUN_ID
  $environment['REVO_RUN_ATTEMPT'] = $env:GITHUB_RUN_ATTEMPT
  $environment['CI'] = 'true'

  $probePrefix = @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command')
  $exitZero = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; exit 0'
  $retainFixtureForProcess = $true
  $zeroResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitZero), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  if ($null -ne $zeroResult -and $zeroResult.CleanupConfirmed -is [bool] -and $zeroResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $retainFixtureForProcess = $true
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
  if ($null -ne $earlyExitResult -and $earlyExitResult.CleanupConfirmed -is [bool] -and $earlyExitResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $retainFixtureForProcess = $true
  $seventeenResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $exitSeventeen), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 30)
  if ($null -ne $seventeenResult -and $seventeenResult.CleanupConfirmed -is [bool] -and $seventeenResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
  Assert-HarnessSuccess $seventeenResult 17 'Harness exit-code control for child exit 17'
  Write-Output 'CHILD_EXIT_CODE_17_PROBE=PASS'

  $noReadyCommand = 'Start-Sleep -Seconds 60'
  $retainFixtureForProcess = $true
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
  if ($null -ne $noReadyResult -and $noReadyResult.CleanupConfirmed -is [bool] -and $noReadyResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $retainFixtureForProcess = $true
  $timeoutResult = [WindowsHarnessNative]::RunAsUser($pwshPath, ($probePrefix + $timeoutCommand), $accountName, $env:COMPUTERNAME, $securePassword, $fixtureRoot, $environment, $accountSid, 'RVW_HARNESS_READY', 3)
  if ($null -ne $timeoutResult -and $timeoutResult.CleanupConfirmed -is [bool] -and $timeoutResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $descendantCommand = '[Console]::WriteLine("RVW_HARNESS_READY"); [Console]::Out.Flush(); if ([Console]::ReadLine() -cne "GO") { exit 90 }; $childInfo = [Diagnostics.ProcessStartInfo]::new($env:REVO_PWSH_EXE); $childInfo.UseShellExecute = $false; $childInfo.CreateNoWindow = $true; $childInfo.RedirectStandardInput = $true; $childInfo.ArgumentList.Add("-NoLogo"); $childInfo.ArgumentList.Add("-NoProfile"); $childInfo.ArgumentList.Add("-NonInteractive"); $childInfo.ArgumentList.Add("-Command"); $childInfo.ArgumentList.Add("[Console]::Out.WriteLine(''RVW_DESCENDANT_STDOUT''); [Console]::Out.Flush(); [Console]::Error.WriteLine(''RVW_DESCENDANT_STDERR''); [Console]::Error.Flush(); [IO.File]::WriteAllText(`$env:REVO_DESCENDANT_ACK, ''ready''); Start-Sleep -Seconds 120"); $child = [Diagnostics.Process]::Start($childInfo); if ($null -eq $child) { exit 91 }; $child.StandardInput.Close(); $wait = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path -LiteralPath $env:REVO_DESCENDANT_ACK -PathType Leaf) -and $wait.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }; if (-not (Test-Path -LiteralPath $env:REVO_DESCENDANT_ACK -PathType Leaf)) { exit 92 }; exit 0'

  $descendantStagePath = Join-Path $bootstrap 'descendant-probe-stage.ps1'
  $descendantPreparationPath = Join-Path $bootstrap 'prepare-descendant-probe.ps1'
  $descendantScriptPath = Join-Path $tempDirectory 'descendant-probe.ps1'
  foreach ($generatedScriptPath in @($descendantStagePath, $descendantPreparationPath, $descendantScriptPath)) {
    if (Test-Path -LiteralPath $generatedScriptPath) {
      throw 'Generated descendant script path already exists.'
    }
  }

  $descendantPreparationScript = @'
$ErrorActionPreference = 'Stop'

function Copy-StagedDescendantScript([string]$SourcePath, [string]$DestinationPath) {
  $sourceStream = $null
  $destinationStream = $null
  try {
    $sourceStream = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $destinationStream = [IO.File]::Open($DestinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $sourceStream.CopyTo($destinationStream)
    $destinationStream.Flush($true)
  } finally {
    try {
      if ($null -ne $destinationStream) { $destinationStream.Dispose() }
    } finally {
      if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
  }
}

[Console]::WriteLine('RVW_HARNESS_READY')
[Console]::Out.Flush()
if ([Console]::ReadLine() -cne 'GO') { exit 90 }
try {
  Copy-StagedDescendantScript $env:REVO_DESCENDANT_SCRIPT_STAGE $env:REVO_DESCENDANT_SCRIPT_DESTINATION
  [Console]::Out.WriteLine('RVW_DESCENDANT_STAGE_READY')
  [Console]::Out.Flush()
  exit 0
} catch {
  [Console]::Error.WriteLine('RVW_DESCENDANT_STAGE_FAILED')
  [Console]::Error.Flush()
  exit 93
}
'@

  Write-NewUtf8TextFile $descendantStagePath $descendantCommand
  Write-NewUtf8TextFile $descendantPreparationPath $descendantPreparationScript
  $preparationEnvironment = [System.Collections.Generic.Dictionary[string, string]]::new($environment, [StringComparer]::OrdinalIgnoreCase)
  $preparationEnvironment['REVO_DESCENDANT_SCRIPT_STAGE'] = $descendantStagePath
  $preparationEnvironment['REVO_DESCENDANT_SCRIPT_DESTINATION'] = $descendantScriptPath

  $preparationArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $descendantPreparationPath)
  $preparationCommandBound = Assert-WindowsCredentialedCommandLineBound $pwshPath $preparationArguments
  Write-Output "DESCENDANT_PREPARATION_COMMAND commandLengthBound=$($preparationCommandBound.CommandLengthBound) withinLimit=true"
  $retainFixtureForProcess = $true
  $preparationResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    $preparationArguments,
    $accountName,
    $env:COMPUTERNAME,
    $securePassword,
    $fixtureRoot,
    $preparationEnvironment,
    $accountSid,
    'RVW_HARNESS_READY',
    30
  )
  if ($null -ne $preparationResult -and $preparationResult.CleanupConfirmed -is [bool] -and $preparationResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
  Assert-HarnessSuccess $preparationResult 0 'Descendant-script preparation'
  if ($null -eq $preparationResult.Token -or
      $preparationResult.Token.Sid -cne $accountSid -or
      -not $preparationResult.StandardOutput.Contains('RVW_DESCENDANT_STAGE_READY')) {
    throw 'Descendant-script preparation did not confirm the standard user and copy completion.'
  }

  $expectedTempPath = [IO.Path]::GetFullPath($tempDirectory)
  $actualScriptParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($descendantScriptPath))
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actualScriptParent, $expectedTempPath)) {
    throw 'Descendant script was not created directly inside the private temporary directory.'
  }
  $descendantScriptItem = Get-Item -LiteralPath $descendantScriptPath -Force
  if ($descendantScriptItem.PSIsContainer -or
      ($descendantScriptItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Descendant script destination is not an ordinary file.'
  }
  $descendantScriptAcl = Get-Acl -LiteralPath $descendantScriptPath
  if ($descendantScriptAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -cne $accountSid) {
    throw 'Descendant script is not owned by the verified standard user.'
  }
  $allowedFileSids = @($accountSid, 'S-1-5-18', 'S-1-5-32-544')
  $standardUserReadGranted = $false
  foreach ($rule in @($descendantScriptAcl.Access)) {
    $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -notin $allowedFileSids -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      throw 'Descendant script DACL contains an unexpected principal or rule.'
    }
    if ($ruleSid -ceq $accountSid -and
        ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0) {
      $standardUserReadGranted = $true
    }
  }
  if (-not $standardUserReadGranted) {
    throw 'Descendant script DACL does not grant the standard user read access.'
  }
  $stagedScriptBytes = [IO.File]::ReadAllBytes($descendantStagePath)
  $ownedScriptBytes = [IO.File]::ReadAllBytes($descendantScriptPath)
  $scriptBytesMatch = $stagedScriptBytes.Length -eq $ownedScriptBytes.Length
  if ($scriptBytesMatch) {
    for ($byteIndex = 0; $byteIndex -lt $stagedScriptBytes.Length; $byteIndex++) {
      if ($stagedScriptBytes[$byteIndex] -ne $ownedScriptBytes[$byteIndex]) {
        $scriptBytesMatch = $false
        break
      }
    }
  }
  if (-not $scriptBytesMatch) {
    throw 'Standard-user descendant script bytes did not match the staged source.'
  }
  Write-Output 'DESCENDANT_SCRIPT_FILE=PASS userOwned=true privateAcl=true bytesMatch=true reparsePoint=false'

  $descendantArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $descendantScriptPath)
  $descendantCommandBound = Assert-WindowsCredentialedCommandLineBound $pwshPath $descendantArguments
  Write-Output "DESCENDANT_PROBE_COMMAND commandLengthBound=$($descendantCommandBound.CommandLengthBound) withinLimit=true"
  $descendantWatch = [Diagnostics.Stopwatch]::StartNew()
  $retainFixtureForProcess = $true
  $descendantResult = [WindowsHarnessNative]::RunAsUser(
    $pwshPath,
    $descendantArguments,
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
  if ($null -ne $descendantResult -and $descendantResult.CleanupConfirmed -is [bool] -and $descendantResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
      -not $descendantAckExists -or
      $descendantWatch.ElapsedMilliseconds -gt 60000) {
    throw 'Descendant-held-pipe control did not prove inherited output, detect the descendant, and bound cleanup.'
  }
  Write-Output 'DESCENDANTS_HELD_PIPE_CLEANUP_PROBE=PASS'

  $missingExecutable = Join-Path $fixtureRoot 'missing-harness-child.exe'
  $retainFixtureForProcess = $true
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
  if ($null -ne $startFailureResult -and $startFailureResult.CleanupConfirmed -is [bool] -and $startFailureResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $retainFixtureForProcess = $true
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
  if ($null -ne $tokenFailureResult -and $tokenFailureResult.CleanupConfirmed -is [bool] -and $tokenFailureResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
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
  $retainFixtureForProcess = $true
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
  if ($null -ne $nativeResult -and $nativeResult.CleanupConfirmed -is [bool] -and $nativeResult.CleanupConfirmed) {
    $retainFixtureForProcess = $false
  }
  Write-Output "WINDOWS_EXECUTABLE_ENV_COPY nodeInputPresent=$($nativeResult.NodeEnvironmentInputPresent.ToString().ToLowerInvariant()) nodeInputLength=$($nativeResult.NodeEnvironmentInputLength) nodeCopiedPresent=$($nativeResult.NodeEnvironmentCopiedPresent.ToString().ToLowerInvariant()) nodeCopyEqual=$($nativeResult.NodeEnvironmentCopyEqual.ToString().ToLowerInvariant()) npmInputPresent=$($nativeResult.NpmEnvironmentInputPresent.ToString().ToLowerInvariant()) npmInputLength=$($nativeResult.NpmEnvironmentInputLength) npmCopiedPresent=$($nativeResult.NpmEnvironmentCopiedPresent.ToString().ToLowerInvariant()) npmCopyEqual=$($nativeResult.NpmEnvironmentCopyEqual.ToString().ToLowerInvariant()) environmentValidated=$($nativeResult.EnvironmentValidated.ToString().ToLowerInvariant())"
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
    $scriptExitCode = $nativeResult.ExitCode
  }

  $baselineExitCode = $scriptExitCode
  $diagnosticGate = $null
  try {
    $diagnosticGate = Get-WindowsNodeDiagnosticGate $nativeResult ([bool]$diagnosticBootstrap.Ready) $accountSid $profilePath
  } catch {
    if ($nativeResult.ExitCode -is [int] -and $nativeResult.ExitCode -eq 90) {
      $retainFixtureForProcess = $true
    }
    Write-Output 'WINDOWS_NODE_DIAGNOSTICS=failed reason=gate-evaluation-failed'
  }
  if ($null -ne $diagnosticGate -and $diagnosticGate.TargetFailure) {
    $retainFixtureForProcess = $true
    $diagnosticInvoker = {
      $diagnosticRunner = {
        param($Executable, $Arguments, $WorkingDirectory, $ChildEnvironment, $ReadyTimeout, $ExecutionTimeout, $CleanupTimeout)
        [void](Assert-WindowsCredentialedCommandLineBound $Executable $Arguments)
        return Invoke-WindowsDiagnosticNativeRunAsUser `
          -Executable $Executable `
          -Arguments $Arguments `
          -UserName $accountName `
          -Domain $env:COMPUTERNAME `
          -Password $securePassword `
          -WorkingDirectory $WorkingDirectory `
          -Environment $ChildEnvironment `
          -ExpectedSid $accountSid `
          -ReadyMarker 'RVW_NODE_DIAGNOSTIC_READY' `
          -ReadyTimeoutSeconds $ReadyTimeout `
          -ExecutionTimeoutSeconds $ExecutionTimeout `
          -CleanupTimeoutSeconds $CleanupTimeout
      }
      return Invoke-WindowsNodeInvocationDiagnostics `
        -BaseEnvironment $environment `
        -PowerShellPath $pwshPath `
        -DiagnosticScriptPath $diagnosticBootstrap.Path `
        -WorkingDirectory $fixtureRoot `
        -ExpectedSid $accountSid `
        -ExpectedProfile $profilePath `
        -Runner $diagnosticRunner `
        -SourceSha $head `
        -TreeSha $tree `
        -ArchiveSha256 $archiveHash `
        -DiagnosticScriptHashMatch $diagnosticBootstrap.Ready `
        -RunId ([string]$env:GITHUB_RUN_ID) `
        -RunAttempt ([string]$env:GITHUB_RUN_ATTEMPT)
    }
    try {
      $diagnosticAttempt = Invoke-WindowsNodeDiagnosticsFailClosed $baselineExitCode $diagnosticGate $diagnosticInvoker
      $scriptExitCode = $diagnosticAttempt.ExitCode
      $retainFixtureForProcess = $diagnosticAttempt.RetentionRequired
      if ($diagnosticAttempt.Complete) {
        Write-Output 'WINDOWS_NODE_DIAGNOSTICS=complete baselineExit=90'
      } elseif ($diagnosticAttempt.Reason -eq 'diagnostic-bootstrap-unverified') {
        Write-Output "WINDOWS_NODE_DIAGNOSTICS=skipped reason=$($diagnosticAttempt.Reason) baselineExit=90"
      } else {
        Write-Output "WINDOWS_NODE_DIAGNOSTICS=failed reason=$($diagnosticAttempt.Reason) stage=$($diagnosticAttempt.FailureStage) kind=$($diagnosticAttempt.FailureKind) missingFunction=$($diagnosticAttempt.MissingFunction.ToString().ToLowerInvariant()) baselineExit=90"
      }
    } catch {
      $scriptExitCode = $baselineExitCode
      $retainFixtureForProcess = $true
      Write-Output 'WINDOWS_NODE_DIAGNOSTICS=failed reason=exception baselineExit=90'
    }
  }
} finally {
  if ($securePassword) {
    try {
      $securePassword.Dispose()
    } catch {
      $cleanupFailure = $true
      Write-Output 'WINDOWS_HARNESS_PASSWORD_DISPOSE=FAILED'
    }
  }

  $fixtureCleanup = Complete-WindowsHarnessFixture `
    -RetentionRequired $retainFixtureForProcess `
    -AccountSid $accountSid `
    -AccountName $accountName `
    -FixtureRoot $fixtureRoot `
    -RunnerTempRoot $env:RUNNER_TEMP
  if ($null -ne $fixtureCleanup.OwnerScan) {
    $ownerScan = $fixtureCleanup.OwnerScan
    Write-Output "WINDOWS_FIXTURE_OWNER_SCAN state=$($ownerScan.State) reason=$($ownerScan.Reason) phase=$($ownerScan.Phase) examinedCount=$($ownerScan.ExaminedCount) resultCount=$($ownerScan.ResultCount) returnPresent=$($ownerScan.ReturnPresent.ToString().ToLowerInvariant()) returnType=$($ownerScan.ReturnType) returnValue=$($ownerScan.ReturnValue) sidPresent=$($ownerScan.SidPresent.ToString().ToLowerInvariant()) sidKind=$($ownerScan.SidKind) category=$($ownerScan.Category) hresult=$($ownerScan.HResult)"
  }
  if ($fixtureCleanup.CleanupFailed) {
    $cleanupFailure = $true
  }
  if ($fixtureCleanup.Status -eq 'retained' -or $fixtureCleanup.Status -eq 'failed') {
    Write-Output "WINDOWS_FIXTURE_RETENTION=REQUIRED reason=$($fixtureCleanup.Reason)"
  } elseif ($fixtureCleanup.Status -eq 'cleaned') {
    Write-Output 'WINDOWS_FIXTURE_CLEANUP=CONFIRMED'
  }
}

$scriptExitCode = Get-FinalWindowsHarnessExitCode $scriptExitCode $cleanupFailure
$childExitForLog = 'none'
if ($null -ne $nativeResult -and $nativeResult.ExitCode -is [int]) {
  $childExitForLog = $nativeResult.ExitCode.ToString([Globalization.CultureInfo]::InvariantCulture)
}
Write-Output "WINDOWS_HARNESS_EXIT child=$childExitForLog cleanupFailed=$($cleanupFailure.ToString().ToLowerInvariant()) final=$scriptExitCode"
exit $scriptExitCode
