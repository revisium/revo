#Requires -PSEdition Core
#Requires -Version 7.0

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateRange(1, 2147483647)]
  [int]$ProcessId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
  Add-Type -Path (Join-Path $PSScriptRoot 'windows-harness-native.cs') -ErrorAction Stop
  $report = [WindowsHarnessNative]::InspectProcess($ProcessId)
  [ordered]@{
    schemaVersion = 1
    inspectedPid = $ProcessId
    sid = $report.Sid
    isElevated = $report.IsElevated
    elevationType = $report.ElevationType
    hasAdministratorsSid = $report.HasAdministratorsSid
    integritySid = $report.IntegritySid
    profileHiveLoaded = $report.ProfileHiveLoaded
    profileMatchesExpected = [WindowsHarnessNative]::ProfilePathsEqual($report.ProfilePath, $env:REVO_EXPECTED_PROFILE)
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine('WINDOWS_TOKEN_PROBE_FAILED')
  exit 92
}
