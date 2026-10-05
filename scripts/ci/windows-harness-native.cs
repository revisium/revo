using Microsoft.Win32;
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

public sealed class WindowsHarnessTokenReport
{
    public string Sid { get; set; }
    public string ProfilePath { get; set; }
    public string IntegritySid { get; set; }
    public bool IsElevated { get; set; }
    public int ElevationType { get; set; }
    public bool HasAdministratorsSid { get; set; }
    public bool ProfileHiveLoaded { get; set; }
}

public sealed class WindowsHarnessExecutableReport
{
    public bool Valid { get; set; }
    public string Machine { get; set; }
    public string OptionalHeader { get; set; }
    public string Subsystem { get; set; }
    public string FailureCode { get; set; }
}

internal sealed class WindowsHarnessNodeProbeState
{
    public bool StartAttempted { get; set; }
    public bool Started { get; set; }
    public string Stage { get; set; } = "input-validation";
    public string FailureCode { get; set; } = "none";
    public string StartExceptionKind { get; set; } = "none";
    public int? StartHResult { get; set; }
    public int? StartNativeErrorCode { get; set; }
    public string ExceptionPhase { get; set; } = "none";
    public string ExceptionKind { get; set; } = "none";
    public int? ExceptionHResult { get; set; }
    public int? ExceptionNativeErrorCode { get; set; }
    public int? ExitCode { get; set; }
    public bool ExitObserved { get; set; }
    public bool TimedOut { get; set; }
    public bool KillAttempted { get; set; }
    public bool KillRequestSucceeded { get; set; }
    public string KillFailureKind { get; set; } = "none";
    public int? KillHResult { get; set; }
    public int? KillNativeErrorCode { get; set; }
    public long StandardOutputBytes { get; set; }
    public bool StandardOutputTruncated { get; set; }
    public bool StandardOutputEof { get; set; }
    public string StandardOutputReadFailureKind { get; set; } = "none";
    public long StandardErrorBytes { get; set; }
    public bool StandardErrorTruncated { get; set; }
    public bool StandardErrorEof { get; set; }
    public string StandardErrorReadFailureKind { get; set; } = "none";
    public string StandardInputCloseFailureKind { get; set; } = "none";
    public string DisposeFailureKind { get; set; } = "none";
    public bool RuntimeMatch { get; set; }
    public bool CleanupConfirmed
    {
        get
        {
            return ExitObserved &&
                StandardOutputEof && StandardErrorEof &&
                StandardOutputReadFailureKind == "none" &&
                StandardErrorReadFailureKind == "none" &&
                DisposeFailureKind == "none" &&
                CleanupFailureCode == "none";
        }
    }
    public string CleanupFailureCode { get; set; } = "none";
    public long ElapsedMilliseconds { get; set; }
}

public sealed class WindowsHarnessNodeProbeReport
{
    internal WindowsHarnessNodeProbeReport(WindowsHarnessNodeProbeState state)
    {
        StartAttempted = state.StartAttempted;
        Started = state.Started;
        Stage = state.Stage;
        FailureCode = state.FailureCode;
        StartExceptionKind = state.StartExceptionKind;
        StartHResult = state.StartHResult;
        StartNativeErrorCode = state.StartNativeErrorCode;
        ExceptionPhase = state.ExceptionPhase;
        ExceptionKind = state.ExceptionKind;
        ExceptionHResult = state.ExceptionHResult;
        ExceptionNativeErrorCode = state.ExceptionNativeErrorCode;
        ExitCode = state.ExitCode;
        ExitObserved = state.ExitObserved;
        TimedOut = state.TimedOut;
        KillAttempted = state.KillAttempted;
        KillRequestSucceeded = state.KillRequestSucceeded;
        KillFailureKind = state.KillFailureKind;
        KillHResult = state.KillHResult;
        KillNativeErrorCode = state.KillNativeErrorCode;
        StandardOutputBytes = state.StandardOutputBytes;
        StandardOutputTruncated = state.StandardOutputTruncated;
        StandardOutputEof = state.StandardOutputEof;
        StandardOutputReadFailureKind = state.StandardOutputReadFailureKind;
        StandardErrorBytes = state.StandardErrorBytes;
        StandardErrorTruncated = state.StandardErrorTruncated;
        StandardErrorEof = state.StandardErrorEof;
        StandardErrorReadFailureKind = state.StandardErrorReadFailureKind;
        StandardInputCloseFailureKind = state.StandardInputCloseFailureKind;
        DisposeFailureKind = state.DisposeFailureKind;
        RuntimeMatch = state.RuntimeMatch;
        CleanupConfirmed = state.CleanupConfirmed;
        CleanupFailureCode = state.CleanupFailureCode;
        ElapsedMilliseconds = state.ElapsedMilliseconds;
    }

    public bool StartAttempted { get; }
    public bool Started { get; }
    public string Stage { get; }
    public string FailureCode { get; }
    public string StartExceptionKind { get; }
    public int? StartHResult { get; }
    public int? StartNativeErrorCode { get; }
    public string ExceptionPhase { get; }
    public string ExceptionKind { get; }
    public int? ExceptionHResult { get; }
    public int? ExceptionNativeErrorCode { get; }
    public int? ExitCode { get; }
    public bool ExitObserved { get; }
    public bool TimedOut { get; }
    public bool KillAttempted { get; }
    public bool KillRequestSucceeded { get; }
    public string KillFailureKind { get; }
    public int? KillHResult { get; }
    public int? KillNativeErrorCode { get; }
    public long StandardOutputBytes { get; }
    public bool StandardOutputTruncated { get; }
    public bool StandardOutputEof { get; }
    public string StandardOutputReadFailureKind { get; }
    public long StandardErrorBytes { get; }
    public bool StandardErrorTruncated { get; }
    public bool StandardErrorEof { get; }
    public string StandardErrorReadFailureKind { get; }
    public string StandardInputCloseFailureKind { get; }
    public string DisposeFailureKind { get; }
    public bool RuntimeMatch { get; }
    public bool CleanupConfirmed { get; }
    public string CleanupFailureCode { get; }
    public long ElapsedMilliseconds { get; }
}

public sealed class WindowsHarnessRunResult
{
    public int ExitCode { get; set; }
    public bool TimedOut { get; set; }
    public bool CleanupConfirmed { get; set; }
    public string FailureCode { get; set; }
    public string CleanupFailureCode { get; set; }
    public bool ExitObserved { get; set; }
    public bool GoAttempted { get; set; }
    public bool GoSent { get; set; }
    public string StandardOutput { get; set; }
    public string StandardError { get; set; }
    public string StartFailureOrigin { get; set; }
    public string StartExceptionKind { get; set; }
    public int? StartHResult { get; set; }
    public int? StartNativeErrorCode { get; set; }
    public bool EnvironmentValidated { get; set; }
    public bool NodeEnvironmentInputPresent { get; set; }
    public int NodeEnvironmentInputLength { get; set; }
    public bool NodeEnvironmentCopiedPresent { get; set; }
    public bool NodeEnvironmentCopyEqual { get; set; }
    public bool NpmEnvironmentInputPresent { get; set; }
    public int NpmEnvironmentInputLength { get; set; }
    public bool NpmEnvironmentCopiedPresent { get; set; }
    public bool NpmEnvironmentCopyEqual { get; set; }
    public WindowsHarnessTokenReport Token { get; set; }
}

public static class WindowsHarnessNative
{
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const int TokenUserClass = 1;
    private const int TokenGroupsClass = 2;
    private const int TokenPrivilegesClass = 3;
    private const int TokenElevationTypeClass = 18;
    private const int TokenElevationClass = 20;
    private const int TokenIntegrityLevelClass = 25;
    private const int JobObjectBasicAccountingInformationClass = 1;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const string AdministratorsSid = "S-1-5-32-544";
    private const string SystemSid = "S-1-5-18";
    private const string MediumIntegritySid = "S-1-16-8192";
    private const int TokenElevationTypeDefault = 1;
    private const int MaxCapturedCharacters = 262144;
    private const int NodeProbeExecutionTimeoutMilliseconds = 10000;
    private const int NodeProbeCleanupTimeoutMilliseconds = 5000;
    private const int NodeProbeCaptureLimitBytes = 4096;
    private const int ProfilePathBufferChars = 260;
    private const uint SePrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;
    private const string SeRestorePrivilege = "SeRestorePrivilege";

    public static string ClassifyStartException(Exception exception)
    {
        if (exception is Win32Exception) return "win32";
        if (exception is ArgumentException) return "argument";
        if (exception is InvalidOperationException) return "invalid-operation";
        if (exception is PlatformNotSupportedException || exception is NotSupportedException)
            return "not-supported";
        if (exception is UnauthorizedAccessException) return "unauthorized-access";
        if (exception is System.Security.SecurityException) return "security";
        return "other";
    }

    public static async Task<WindowsHarnessNodeProbeReport> ProbeNodeRuntimeDirect(
        string executable,
        string workingDirectory,
        string expectedRuntime)
    {
        var state = new WindowsHarnessNodeProbeState();
        var stopwatch = Stopwatch.StartNew();
        if (String.IsNullOrWhiteSpace(executable) || !Path.IsPathFullyQualified(executable) ||
            String.IsNullOrWhiteSpace(workingDirectory) || !Path.IsPathFullyQualified(workingDirectory) ||
            String.IsNullOrEmpty(expectedRuntime) || expectedRuntime.Length > 128 ||
            expectedRuntime.IndexOf('\0') >= 0)
        {
            state.FailureCode = "input-invalid";
            state.ElapsedMilliseconds = stopwatch.ElapsedMilliseconds;
            return new WindowsHarnessNodeProbeReport(state);
        }

        Process process = null;
        NodeProbeCapture output = null;
        NodeProbeCapture error = null;
        Task outputTask = null;
        Task errorTask = null;
        Task<NodeProbeExitResult> exitTask = null;
        var processStarted = false;
        try
        {
            state.Stage = "setup";
            var start = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                WorkingDirectory = workingDirectory,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            start.ArgumentList.Add("-p");
            start.ArgumentList.Add("process.version + '|' + process.platform + '|' + process.arch");
            process = new Process { StartInfo = start };
            state.Stage = "start";
            state.StartAttempted = true;
            try
            {
                processStarted = process.Start();
                state.Started = processStarted;
                if (!processStarted) state.FailureCode = "start-returned-false";
            }
            catch (Exception exception)
            {
                state.FailureCode = "start-exception";
                var evidence = CreateNodeProbeExceptionEvidence("start", exception);
                RecordNodeProbeException(state, evidence);
                state.StartExceptionKind = evidence.Kind;
                state.StartHResult = evidence.HResult;
                if (exception is Win32Exception win32Exception)
                {
                    state.StartNativeErrorCode = win32Exception.NativeErrorCode;
                }
            }

            if (processStarted)
            {
                var executionDeadline = Environment.TickCount64 + NodeProbeExecutionTimeoutMilliseconds;
                output = new NodeProbeCapture(NodeProbeCaptureLimitBytes, "stdout-read");
                error = new NodeProbeCapture(NodeProbeCaptureLimitBytes, "stderr-read");
                try
                {
                    state.Stage = "stdout-read";
                    outputTask = CaptureNodeProbeStreamAsync(process.StandardOutput.BaseStream, output);
                    state.Stage = "stderr-read";
                    errorTask = CaptureNodeProbeStreamAsync(process.StandardError.BaseStream, error);
                }
                catch (Exception exception)
                {
                    RecordNodeProbeException(state, CreateNodeProbeExceptionEvidence("setup", exception));
                    if (state.FailureCode == "none") state.FailureCode = "probe-setup-failed";
                }
                try
                {
                    state.Stage = "exit-observation";
                    exitTask = ObserveNodeProbeExitAsync(process);
                }
                catch (Exception exception)
                {
                    RecordNodeProbeException(state, CreateNodeProbeExceptionEvidence("exit-observation", exception));
                    if (state.FailureCode == "none") state.FailureCode = "exit-observation-failed";
                }

                state.Stage = "stdin-close";
                try
                {
                    process.StandardInput.Close();
                }
                catch (Exception exception)
                {
                    var evidence = CreateNodeProbeExceptionEvidence("stdin-close", exception);
                    state.StandardInputCloseFailureKind = evidence.Kind;
                    RecordNodeProbeException(state, evidence);
                    if (state.FailureCode == "none") state.FailureCode = "stdin-close-failed";
                }

                if (state.FailureCode == "none" && exitTask != null)
                {
                    state.Stage = "execution-wait";
                    if (!await WaitForNodeProbeTaskUntilAsync(exitTask, executionDeadline).ConfigureAwait(false))
                    {
                        state.TimedOut = true;
                        state.FailureCode = "execution-timeout";
                        TryKillNodeProbe(process, state);
                    }
                }
                else if (exitTask == null || !exitTask.IsCompleted)
                {
                    TryKillNodeProbe(process, state);
                }
            }
        }
        catch (Exception exception)
        {
            RecordNodeProbeException(state, CreateNodeProbeExceptionEvidence("supervisor", exception));
            if (state.FailureCode == "none") state.FailureCode = "probe-exception";
            if (process != null && processStarted)
            {
                TryKillNodeProbe(process, state);
            }
        }
        finally
        {
            if (processStarted && process != null)
            {
                state.Stage = state.FailureCode == "none" ? "cleanup-wait" : state.Stage;
                var cleanupDeadline = Environment.TickCount64 + NodeProbeCleanupTimeoutMilliseconds;
                if (exitTask == null)
                {
                    try
                    {
                        exitTask = ObserveNodeProbeExitAsync(process);
                    }
                    catch (Exception exception)
                    {
                        RecordNodeProbeException(state, CreateNodeProbeExceptionEvidence("exit-observation", exception));
                    }
                }
                if (exitTask == null || !exitTask.IsCompleted)
                {
                    TryKillNodeProbe(process, state);
                }

                var activeTasks = new List<Task>();
                if (exitTask != null) activeTasks.Add(exitTask);
                if (outputTask != null) activeTasks.Add(outputTask);
                if (errorTask != null) activeTasks.Add(errorTask);
                var cleanupTask = Task.WhenAll(activeTasks);
                if (activeTasks.Count > 0 &&
                    !await WaitForNodeProbeTaskUntilAsync(cleanupTask, cleanupDeadline).ConfigureAwait(false))
                {
                    SetNodeProbeCleanupFailure(state, "cleanup-deadline-exceeded");
                    CloseNodeProbeReadStreams(process, state);
                }

                if (exitTask != null && exitTask.IsCompleted)
                {
                    var exitResult = await exitTask.ConfigureAwait(false);
                    state.ExitObserved = exitResult.ExitObserved;
                    state.ExitCode = exitResult.ExitCode;
                    if (exitResult.Exception != null)
                    {
                        RecordNodeProbeException(state, exitResult.Exception);
                        if (state.FailureCode == "none") state.FailureCode = "exit-observation-failed";
                    }
                }
                else
                {
                    TryObserveNodeProbeExit(process, state);
                }

            }

            if (process != null)
            {
                try
                {
                    process.Dispose();
                }
                catch (Exception exception)
                {
                    var evidence = CreateNodeProbeExceptionEvidence("dispose", exception);
                    state.DisposeFailureKind = evidence.Kind;
                    RecordNodeProbeException(state, evidence);
                    SetNodeProbeCleanupFailure(state, "process-dispose-failed");
                }
            }

            if (processStarted)
            {
                var outputSnapshot = output == null ? null : output.Snapshot();
                var errorSnapshot = error == null ? null : error.Snapshot();
                ApplyNodeProbeCapture(state, outputSnapshot, true, expectedRuntime);
                ApplyNodeProbeCapture(state, errorSnapshot, false, expectedRuntime);
                if (!state.ExitObserved) SetNodeProbeCleanupFailure(state, "root-exit-unconfirmed");
                if (!state.StandardOutputEof) SetNodeProbeCleanupFailure(state, "stdout-eof-unconfirmed");
                if (!state.StandardErrorEof) SetNodeProbeCleanupFailure(state, "stderr-eof-unconfirmed");
                if (state.StandardOutputReadFailureKind != "none") SetNodeProbeCleanupFailure(state, "stdout-read-failed");
                if (state.StandardErrorReadFailureKind != "none") SetNodeProbeCleanupFailure(state, "stderr-read-failed");
            }

            state.ElapsedMilliseconds = stopwatch.ElapsedMilliseconds;
        }

        if (state.FailureCode == "none")
        {
            if (!state.CleanupConfirmed)
            {
                state.Stage = "cleanup-wait";
                state.FailureCode = "cleanup-unconfirmed";
            }
            else if (!state.ExitCode.HasValue || state.ExitCode.Value != 0)
            {
                state.FailureCode = "exit-nonzero";
            }
            else if (!state.RuntimeMatch || state.StandardOutputTruncated)
            {
                state.FailureCode = "runtime-output-mismatch";
            }
            else if (state.StandardErrorBytes != 0 || state.StandardErrorTruncated)
            {
                state.FailureCode = "unexpected-stderr";
            }
            else
            {
                state.Stage = "complete";
            }
        }

        return new WindowsHarnessNodeProbeReport(state);
    }

    private static async Task CaptureNodeProbeStreamAsync(Stream stream, NodeProbeCapture capture)
    {
        try
        {
            var buffer = new byte[8192];
            while (true)
            {
                var count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (count == 0)
                {
                    capture.MarkEof();
                    return;
                }
                capture.Append(buffer, count);
            }
        }
        catch (Exception exception)
        {
            capture.RecordFailure(CreateNodeProbeExceptionEvidence(capture.FailurePhase, exception));
        }
    }

    private static async Task<NodeProbeExitResult> ObserveNodeProbeExitAsync(Process process)
    {
        try
        {
            await process.WaitForExitAsync().ConfigureAwait(false);
            return new NodeProbeExitResult(true, process.ExitCode, null);
        }
        catch (Exception exception)
        {
            return new NodeProbeExitResult(false, null, CreateNodeProbeExceptionEvidence("exit-observation", exception));
        }
    }

    private static async Task<bool> WaitForNodeProbeTaskUntilAsync(Task task, long deadline)
    {
        if (task.IsCompleted) return true;
        var remaining = deadline - Environment.TickCount64;
        if (remaining <= 0) return task.IsCompleted;
        var delay = Task.Delay((int)Math.Min(Int32.MaxValue, remaining));
        return await Task.WhenAny(task, delay).ConfigureAwait(false) == task && task.IsCompleted;
    }

    private static void TryKillNodeProbe(Process process, WindowsHarnessNodeProbeState state)
    {
        if (state.KillAttempted) return;
        state.KillAttempted = true;
        try
        {
            process.Kill();
            state.KillRequestSucceeded = true;
        }
        catch (Exception exception)
        {
            var evidence = CreateNodeProbeExceptionEvidence("kill", exception);
            state.KillFailureKind = evidence.Kind;
            state.KillHResult = evidence.HResult;
            state.KillNativeErrorCode = evidence.NativeErrorCode;
        }
    }

    private static void CloseNodeProbeReadStreams(Process process, WindowsHarnessNodeProbeState state)
    {
        try
        {
            process.StandardOutput.BaseStream.Dispose();
        }
        catch (Exception exception)
        {
            var evidence = CreateNodeProbeExceptionEvidence("dispose", exception);
            state.DisposeFailureKind = evidence.Kind;
            RecordNodeProbeException(state, evidence);
        }
        try
        {
            process.StandardError.BaseStream.Dispose();
        }
        catch (Exception exception)
        {
            var evidence = CreateNodeProbeExceptionEvidence("dispose", exception);
            if (state.DisposeFailureKind == "none") state.DisposeFailureKind = evidence.Kind;
            RecordNodeProbeException(state, evidence);
        }
    }

    private static void TryObserveNodeProbeExit(Process process, WindowsHarnessNodeProbeState state)
    {
        try
        {
            if (process.HasExited)
            {
                state.ExitCode = process.ExitCode;
                state.ExitObserved = true;
            }
        }
        catch (Exception exception)
        {
            RecordNodeProbeException(state, CreateNodeProbeExceptionEvidence("exit-observation", exception));
        }
    }

    private static void ApplyNodeProbeCapture(
        WindowsHarnessNodeProbeState state,
        NodeProbeCaptureSnapshot snapshot,
        bool standardOutput,
        string expectedRuntime)
    {
        if (snapshot == null) return;
        if (standardOutput)
        {
            state.StandardOutputBytes = snapshot.TotalBytes;
            state.StandardOutputTruncated = snapshot.Truncated;
            state.StandardOutputEof = snapshot.Eof;
            state.StandardOutputReadFailureKind = snapshot.ReadFailureKind;
            state.RuntimeMatch = snapshot.MatchesExpectedRuntime(expectedRuntime);
        }
        else
        {
            state.StandardErrorBytes = snapshot.TotalBytes;
            state.StandardErrorTruncated = snapshot.Truncated;
            state.StandardErrorEof = snapshot.Eof;
            state.StandardErrorReadFailureKind = snapshot.ReadFailureKind;
        }
        if (snapshot.Exception != null)
        {
            RecordNodeProbeException(state, snapshot.Exception);
        }
    }

    private static void RecordNodeProbeException(
        WindowsHarnessNodeProbeState state,
        NodeProbeExceptionEvidence evidence)
    {
        if (evidence == null || state.ExceptionPhase != "none") return;
        state.ExceptionPhase = evidence.Phase;
        state.ExceptionKind = evidence.Kind;
        state.ExceptionHResult = evidence.HResult;
        state.ExceptionNativeErrorCode = evidence.NativeErrorCode;
    }

    private static void SetNodeProbeCleanupFailure(WindowsHarnessNodeProbeState state, string code)
    {
        if (state.CleanupFailureCode == "none") state.CleanupFailureCode = code;
    }

    private static NodeProbeExceptionEvidence CreateNodeProbeExceptionEvidence(
        string phase,
        Exception exception)
    {
        var nativeErrorCode = exception is Win32Exception win32Exception
            ? (int?)win32Exception.NativeErrorCode
            : null;
        return new NodeProbeExceptionEvidence(
            phase,
            ClassifyProbeException(exception),
            exception.HResult,
            nativeErrorCode);
    }

    private static string ClassifyProbeException(Exception exception)
    {
        if (exception is Win32Exception) return "win32";
        if (exception is UnauthorizedAccessException) return "unauthorized-access";
        if (exception is IOException) return "io-error";
        if (exception is ObjectDisposedException) return "object-disposed";
        if (exception is ArgumentException) return "argument";
        if (exception is InvalidOperationException) return "invalid-operation";
        if (exception is PlatformNotSupportedException || exception is NotSupportedException)
            return "not-supported";
        if (exception is System.Security.SecurityException) return "security";
        return "other";
    }

    private static void RecordStartReturnedFalse(WindowsHarnessRunResult result)
    {
        result.FailureCode = "PROCESS_START_FAILED";
        result.StartFailureOrigin = "returned-false";
    }

    private static void RecordStartException(WindowsHarnessRunResult result, Exception exception)
    {
        result.FailureCode = "PROCESS_START_FAILED";
        result.StartFailureOrigin = "exception";
        result.StartExceptionKind = ClassifyStartException(exception);
        result.StartHResult = exception.HResult;
        if (exception is Win32Exception win32Exception)
        {
            result.StartNativeErrorCode = win32Exception.NativeErrorCode;
        }
    }

    public static string CreateUserProfile(string sid, string userName)
    {
        // Compatibility bound for the short disposable profile path used by this CI harness.
        var path = new StringBuilder(ProfilePathBufferChars);
        var result = CreateProfile(sid, userName, path, (uint)path.Capacity);
        if (result != 0)
        {
            throw new InvalidOperationException("CreateProfile failed: 0x" + result.ToString("X8"));
        }
        return path.ToString();
    }

    public static bool ProfilePathsEqual(string left, string right)
    {
        try
        {
            if (String.IsNullOrWhiteSpace(left) || String.IsNullOrWhiteSpace(right) ||
                !Path.IsPathFullyQualified(left) || !Path.IsPathFullyQualified(right))
            {
                return false;
            }

            var normalizedLeft = Path.TrimEndingDirectorySeparator(Path.GetFullPath(left));
            var normalizedRight = Path.TrimEndingDirectorySeparator(Path.GetFullPath(right));
            return StringComparer.OrdinalIgnoreCase.Equals(normalizedLeft, normalizedRight);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool IsSafeEnvironment(IDictionary<string, string> environment)
    {
        if (environment == null) return false;
        foreach (var entry in environment)
        {
            if (String.IsNullOrEmpty(entry.Key) || entry.Key.IndexOf('=') >= 0 ||
                entry.Key.IndexOf('\0') >= 0 || entry.Value == null || entry.Value.IndexOf('\0') >= 0)
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryGetEnvironmentValue(
        IDictionary<string, string> environment,
        string name,
        out string value)
    {
        value = null;
        return environment != null && environment.TryGetValue(name, out value);
    }

    private static void CaptureEnvironmentEvidence(
        IDictionary<string, string> source,
        IDictionary<string, string> copied,
        WindowsHarnessRunResult result)
    {
        string nodeInput;
        string nodeCopied;
        string npmInput;
        string npmCopied;
        var nodeInputPresent = TryGetEnvironmentValue(source, "REVO_NODE_EXE", out nodeInput) &&
            !String.IsNullOrWhiteSpace(nodeInput);
        var nodeCopiedPresent = TryGetEnvironmentValue(copied, "REVO_NODE_EXE", out nodeCopied) &&
            !String.IsNullOrWhiteSpace(nodeCopied);
        var npmInputPresent = TryGetEnvironmentValue(source, "REVO_NPM_CMD", out npmInput) &&
            !String.IsNullOrWhiteSpace(npmInput);
        var npmCopiedPresent = TryGetEnvironmentValue(copied, "REVO_NPM_CMD", out npmCopied) &&
            !String.IsNullOrWhiteSpace(npmCopied);

        result.NodeEnvironmentInputPresent = nodeInputPresent;
        result.NodeEnvironmentInputLength = nodeInput == null ? 0 : nodeInput.Length;
        result.NodeEnvironmentCopiedPresent = nodeCopiedPresent;
        result.NodeEnvironmentCopyEqual = nodeInputPresent && nodeCopiedPresent &&
            String.Equals(nodeInput, nodeCopied, StringComparison.Ordinal);
        result.NpmEnvironmentInputPresent = npmInputPresent;
        result.NpmEnvironmentInputLength = npmInput == null ? 0 : npmInput.Length;
        result.NpmEnvironmentCopiedPresent = npmCopiedPresent;
        result.NpmEnvironmentCopyEqual = npmInputPresent && npmCopiedPresent &&
            String.Equals(npmInput, npmCopied, StringComparison.Ordinal);

        var allEntriesEqual = source != null && copied != null && source.Count == copied.Count;
        if (allEntriesEqual)
        {
            foreach (var entry in source)
            {
                string copiedValue;
                if (!TryGetEnvironmentValue(copied, entry.Key, out copiedValue) ||
                    !String.Equals(entry.Value, copiedValue, StringComparison.Ordinal))
                {
                    allEntriesEqual = false;
                    break;
                }
            }
        }
        result.EnvironmentValidated = IsSafeEnvironment(source) && allEntriesEqual &&
            result.NodeEnvironmentCopyEqual && result.NpmEnvironmentCopyEqual;
    }

    public static WindowsHarnessExecutableReport InspectExecutable(string path)
    {
        var report = new WindowsHarnessExecutableReport
        {
            Valid = false,
            Machine = "unknown",
            OptionalHeader = "unknown",
            Subsystem = "unknown",
            FailureCode = "invalid-image",
        };
        if (String.IsNullOrWhiteSpace(path))
        {
            report.FailureCode = "path-missing";
            return report;
        }

        try
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.Directory) != 0 ||
                (attributes & FileAttributes.ReparsePoint) != 0)
            {
                report.FailureCode = "path-unsafe";
                return report;
            }

            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new BinaryReader(stream))
            {
                if (stream.Length < 64)
                {
                    report.FailureCode = "image-too-small";
                    return report;
                }
                if (reader.ReadUInt16() != 0x5A4D)
                {
                    report.FailureCode = "dos-signature-invalid";
                    return report;
                }

                stream.Position = 0x3c;
                var peOffset = reader.ReadInt32();
                if (peOffset < 64 || peOffset > stream.Length - 24)
                {
                    report.FailureCode = "pe-offset-invalid";
                    return report;
                }

                stream.Position = peOffset;
                if (reader.ReadUInt32() != 0x00004550)
                {
                    report.FailureCode = "pe-signature-invalid";
                    return report;
                }

                var machine = reader.ReadUInt16();
                stream.Position = (long)peOffset + 20;
                var optionalHeaderSize = reader.ReadUInt16();
                if (stream.Position + 2 > stream.Length)
                {
                    report.FailureCode = "optional-header-invalid";
                    return report;
                }

                var optionalHeaderStart = peOffset + 24L;
                if (optionalHeaderStart + optionalHeaderSize > stream.Length)
                {
                    report.FailureCode = "optional-header-truncated";
                    return report;
                }

                stream.Position = optionalHeaderStart;
                var optionalHeaderMagic = reader.ReadUInt16();
                report.OptionalHeader = optionalHeaderMagic == 0x010b
                    ? "pe32"
                    : optionalHeaderMagic == 0x020b ? "pe32plus" : "other";
                if (report.OptionalHeader == "other")
                {
                    report.FailureCode = "optional-header-magic-invalid";
                    return report;
                }
                var minimumOptionalHeaderSize = optionalHeaderMagic == 0x010b ? 96 : 112;
                if (optionalHeaderSize < minimumOptionalHeaderSize)
                {
                    report.FailureCode = "optional-header-invalid";
                    return report;
                }
                if (((machine == 0x8664 || machine == 0xaa64) && optionalHeaderMagic != 0x020b) ||
                    (machine == 0x014c && optionalHeaderMagic != 0x010b))
                {
                    report.FailureCode = "optional-header-machine-mismatch";
                    return report;
                }

                stream.Position = optionalHeaderStart + 68;
                var subsystem = reader.ReadUInt16();
                report.Machine = machine == 0x8664 ? "amd64" : machine == 0x014c ? "x86" : machine == 0xaa64 ? "arm64" : "other";
                report.Subsystem = subsystem == 2 ? "gui" : subsystem == 3 ? "console" : "other";
                report.Valid = true;
                report.FailureCode = "none";
                return report;
            }
        }
        catch (UnauthorizedAccessException)
        {
            report.FailureCode = "access-denied";
        }
        catch (FileNotFoundException)
        {
            report.FailureCode = "file-not-found";
        }
        catch (DirectoryNotFoundException)
        {
            report.FailureCode = "directory-not-found";
        }
        catch (IOException)
        {
            report.FailureCode = "io-error";
        }
        catch (Exception)
        {
            report.FailureCode = "other";
        }
        return report;
    }

    public static void SetDirectorySecurity(string path, string ownerSid, string userRights)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(new SecurityIdentifier(ownerSid));
        AddRule(security, ownerSid, userRights);
        AddRule(security, SystemSid, "FullControl");
        AddRule(security, AdministratorsSid, "FullControl");
        SetDirectorySecurityWithRestorePrivilege(path, security);
    }

    public static bool IsRestorePrivilegeEnabled()
    {
        IntPtr token = IntPtr.Zero;
        if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token))
        {
            throw new InvalidOperationException("TOKEN_QUERY_FAILED");
        }

        try
        {
            Luid restorePrivilege;
            if (!LookupPrivilegeValue(null, SeRestorePrivilege, out restorePrivilege))
            {
                throw new InvalidOperationException("SE_RESTORE_PRIVILEGE_LOOKUP_FAILED");
            }
            return IsPrivilegeEnabled(token, restorePrivilege);
        }
        finally
        {
            if (!CloseHandle(token))
            {
                throw new InvalidOperationException("TOKEN_HANDLE_CLOSE_FAILED");
            }
        }
    }

    public static void SetReadOnlyDirectorySecurity(string path, string userSid)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(WindowsIdentity.GetCurrent().User);
        AddRule(security, WindowsIdentity.GetCurrent().User.Value, "FullControl");
        AddRule(security, SystemSid, "FullControl");
        AddRule(security, AdministratorsSid, "FullControl");
        AddRule(security, userSid, "ReadAndExecute");
        new DirectoryInfo(path).SetAccessControl(security);
    }

    public static WindowsHarnessTokenReport InspectProcess(int processId)
    {
        using (var process = Process.GetProcessById(processId))
        {
            return InspectHandle(process.Handle);
        }
    }

    public static string ValidateStandardUser(WindowsHarnessTokenReport token, string expectedSid)
    {
        if (!String.Equals(token.Sid, expectedSid, StringComparison.Ordinal)) return "user SID mismatch";
        if (token.IsElevated) return "token is elevated";
        if (token.HasAdministratorsSid) return "Administrators SID is present in token";
        if (token.ElevationType != TokenElevationTypeDefault) return "token elevation type is not default";
        if (!String.Equals(token.IntegritySid, MediumIntegritySid, StringComparison.Ordinal)) return "token is not medium integrity";
        if (!token.ProfileHiveLoaded || String.IsNullOrWhiteSpace(token.ProfilePath)) return "user profile is not loaded";
        return null;
    }

    public static WindowsHarnessRunResult RunAsUser(
        string executable,
        string[] arguments,
        string userName,
        string domain,
        SecureString password,
        string workingDirectory,
        IDictionary<string, string> environment,
        string expectedSid,
        string readyMarker,
        int timeoutSeconds)
    {
        return RunAsUser(
            executable,
            arguments,
            userName,
            domain,
            password,
            workingDirectory,
            environment,
            expectedSid,
            readyMarker,
            30,
            timeoutSeconds,
            15);
    }

    public static WindowsHarnessRunResult RunAsUser(
        string executable,
        string[] arguments,
        string userName,
        string domain,
        SecureString password,
        string workingDirectory,
        IDictionary<string, string> environment,
        string expectedSid,
        string readyMarker,
        int readyTimeoutSeconds,
        int executionTimeoutSeconds,
        int cleanupTimeoutSeconds)
    {
        if (readyTimeoutSeconds <= 0) throw new ArgumentOutOfRangeException("readyTimeoutSeconds");
        if (executionTimeoutSeconds <= 0) throw new ArgumentOutOfRangeException("executionTimeoutSeconds");
        if (cleanupTimeoutSeconds <= 0) throw new ArgumentOutOfRangeException("cleanupTimeoutSeconds");
        var readyTimeoutMilliseconds = checked(readyTimeoutSeconds * 1000);
        var executionTimeoutMilliseconds = checked(executionTimeoutSeconds * 1000);
        var cleanupTimeoutMilliseconds = checked(cleanupTimeoutSeconds * 1000);

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
        }

        var result = new WindowsHarnessRunResult { ExitCode = -1 };
        Process process = null;
        var output = new BoundedCapture();
        var error = new BoundedCapture();
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var exited = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var standardOutputEof = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var standardErrorEof = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var assignedToJob = false;
        var processStarted = false;
        var standardOutputReaderStarted = false;
        var standardErrorReaderStarted = false;
        WindowsHarnessTokenReport token = null;
        DataReceivedEventHandler outputHandler = null;
        DataReceivedEventHandler errorHandler = null;
        EventHandler exitHandler = null;

        try
        {
            var limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var limitsSize = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            var limitsBuffer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsBuffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformationClass, limitsBuffer, (uint)limitsSize))
                {
                    result.FailureCode = "JOB_CONFIGURATION_FAILED";
                }
            }
            finally
            {
                Marshal.FreeHGlobal(limitsBuffer);
            }

            if (result.FailureCode == null)
            {
                var start = new ProcessStartInfo
                {
                    FileName = executable,
                    UseShellExecute = false,
                    WorkingDirectory = workingDirectory,
                    UserName = userName,
                    Domain = domain,
                    Password = password,
                    LoadUserProfile = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                start.Environment.Clear();
                if (!IsSafeEnvironment(environment))
                {
                    result.FailureCode = "ENVIRONMENT_INPUT_INVALID";
                    throw new InvalidOperationException("Harness environment input validation failed.");
                }
                foreach (var entry in environment)
                {
                    start.Environment[entry.Key] = entry.Value;
                }
                CaptureEnvironmentEvidence(environment, start.Environment, result);
                if (!result.EnvironmentValidated)
                {
                    result.FailureCode = "ENVIRONMENT_COPY_MISMATCH";
                    throw new InvalidOperationException("Harness environment copy validation failed.");
                }
                foreach (var argument in arguments)
                {
                    start.ArgumentList.Add(argument);
                }

                process = new Process { StartInfo = start };
                outputHandler = (sender, eventArgs) =>
                {
                    if (eventArgs.Data == null)
                    {
                        standardOutputEof.TrySetResult(true);
                        return;
                    }
                    output.AppendLine(eventArgs.Data);
                    if (String.Equals(eventArgs.Data, readyMarker, StringComparison.Ordinal))
                    {
                        ready.TrySetResult(true);
                    }
                };
                errorHandler = (sender, eventArgs) =>
                {
                    if (eventArgs.Data == null)
                    {
                        standardErrorEof.TrySetResult(true);
                        return;
                    }
                    error.AppendLine(eventArgs.Data);
                };
                exitHandler = (sender, eventArgs) => exited.TrySetResult(true);
                process.OutputDataReceived += outputHandler;
                process.ErrorDataReceived += errorHandler;
                process.Exited += exitHandler;
                process.EnableRaisingEvents = true;

                try
                {
                    processStarted = process.Start();
                    if (!processStarted)
                    {
                        RecordStartReturnedFalse(result);
                    }
                }
                catch (Exception exception)
                {
                    RecordStartException(result, exception);
                }

                if (processStarted)
                {
                    var assignmentSucceeded = AssignProcessToJobObject(job, process.Handle);
                    if (assignmentSucceeded)
                    {
                        assignedToJob = true;
                    }
                    else
                    {
                        result.FailureCode = TryRecordExit(process, result)
                            ? "EARLY_EXIT"
                            : "JOB_ASSIGN_FAILED";
                    }

                    try
                    {
                        process.BeginOutputReadLine();
                        standardOutputReaderStarted = true;
                    }
                    catch (Exception)
                    {
                        if (result.FailureCode == null) result.FailureCode = "SUPERVISOR_FAILURE";
                    }
                    try
                    {
                        process.BeginErrorReadLine();
                        standardErrorReaderStarted = true;
                    }
                    catch (Exception)
                    {
                        if (result.FailureCode == null) result.FailureCode = "SUPERVISOR_FAILURE";
                    }

                    if (assignmentSucceeded && result.FailureCode == null)
                    {
                        var readyDeadline = Environment.TickCount64 + readyTimeoutMilliseconds;
                        var readyDelay = Task.Delay(readyTimeoutMilliseconds);
                        Task.WhenAny(ready.Task, exited.Task, readyDelay).GetAwaiter().GetResult();

                        if (TryRecordExit(process, result))
                        {
                            result.FailureCode = "EARLY_EXIT";
                        }
                        else if (!ready.Task.IsCompleted || Environment.TickCount64 >= readyDeadline)
                        {
                            result.FailureCode = "READY_TIMEOUT";
                            result.TimedOut = true;
                        }
                        else
                        {
                            try
                            {
                                token = InspectHandle(process.Handle);
                                result.Token = token;
                                if (ValidateStandardUser(token, expectedSid) != null)
                                {
                                    result.FailureCode = "TOKEN_PREFLIGHT_FAILED";
                                }
                            }
                            catch (Exception)
                            {
                                result.FailureCode = "TOKEN_PREFLIGHT_FAILED";
                            }

                            if (result.FailureCode == null && TryRecordExit(process, result))
                            {
                                result.FailureCode = "EARLY_EXIT";
                            }
                            else if (result.FailureCode == null)
                            {
                                result.GoAttempted = true;
                                try
                                {
                                    process.StandardInput.WriteLine("GO");
                                    process.StandardInput.Flush();
                                    result.GoSent = true;
                                }
                                catch (Exception)
                                {
                                    result.FailureCode = "GO_WRITE_FAILED";
                                }

                                if (result.GoSent)
                                {
                                    var executionDelay = Task.Delay(executionTimeoutMilliseconds);
                                    Task.WhenAny(exited.Task, executionDelay).GetAwaiter().GetResult();
                                    if (!TryRecordExit(process, result))
                                    {
                                        result.FailureCode = "EXECUTION_TIMEOUT";
                                        result.TimedOut = true;
                                    }
                                    else if (ActiveProcesses(job) > 0)
                                    {
                                        result.FailureCode = "DESCENDANTS_REMAINED";
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (Exception)
        {
            if (result.FailureCode == null) result.FailureCode = "SUPERVISOR_FAILURE";
        }
        finally
        {
            var cleanupDeadline = Environment.TickCount64 + cleanupTimeoutMilliseconds;
            var rootExitConfirmed = !processStarted;
            var jobEmptyConfirmed = false;
            var standardOutputEofConfirmed = !standardOutputReaderStarted;
            var standardErrorEofConfirmed = !standardErrorReaderStarted;
            var jobCloseConfirmed = false;

            if (processStarted && process != null)
            {
                var jobStateKnown = false;
                uint activeProcesses = 0;
                try
                {
                    activeProcesses = ActiveProcesses(job);
                    jobStateKnown = true;
                    jobEmptyConfirmed = activeProcesses == 0;
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "JOB_QUERY_FAILED");
                }

                try
                {
                    rootExitConfirmed = TryRecordExit(process, result);
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "ROOT_EXIT_QUERY_FAILED");
                }

                if (assignedToJob && (!rootExitConfirmed || !jobStateKnown || activeProcesses > 0))
                {
                    if (!TerminateJobObject(job, 124))
                    {
                        RecordCleanupFailure(result, "JOB_TERMINATION_FAILED");
                    }
                }
                else if (!assignedToJob && !rootExitConfirmed)
                {
                    try
                    {
                        process.Kill();
                    }
                    catch (Exception)
                    {
                        try
                        {
                            if (!TryRecordExit(process, result))
                            {
                                RecordCleanupFailure(result, "ROOT_TERMINATION_FAILED");
                            }
                        }
                        catch (Exception)
                        {
                            RecordCleanupFailure(result, "ROOT_TERMINATION_FAILED");
                        }
                    }
                }

                if (!rootExitConfirmed)
                {
                    WaitForTaskUntil(exited.Task, cleanupDeadline);
                    try
                    {
                        rootExitConfirmed = TryRecordExit(process, result);
                    }
                    catch (Exception)
                    {
                        RecordCleanupFailure(result, "ROOT_EXIT_QUERY_FAILED");
                    }
                }
                if (!rootExitConfirmed)
                {
                    RecordCleanupFailure(result, "ROOT_EXIT_UNCONFIRMED");
                }

                try
                {
                    jobEmptyConfirmed = WaitForNoActiveProcessesUntil(job, cleanupDeadline);
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "JOB_QUERY_FAILED");
                    jobEmptyConfirmed = false;
                }
                if (!jobEmptyConfirmed)
                {
                    RecordCleanupFailure(result, "JOB_NOT_EMPTY");
                }

                if (!standardOutputReaderStarted || !standardErrorReaderStarted)
                {
                    RecordCleanupFailure(result, "OUTPUT_DRAIN_NOT_STARTED");
                }

                var readers = new List<Task>();
                if (standardOutputReaderStarted) readers.Add(standardOutputEof.Task);
                if (standardErrorReaderStarted) readers.Add(standardErrorEof.Task);
                if (readers.Count > 0)
                {
                    var drain = Task.WhenAll(readers.ToArray());
                    WaitForTaskUntil(drain, cleanupDeadline);
                    standardOutputEofConfirmed = standardOutputReaderStarted &&
                        standardOutputEof.Task.Status == TaskStatus.RanToCompletion;
                    standardErrorEofConfirmed = standardErrorReaderStarted &&
                        standardErrorEof.Task.Status == TaskStatus.RanToCompletion;
                    if ((standardOutputReaderStarted && !standardOutputEofConfirmed) ||
                        (standardErrorReaderStarted && !standardErrorEofConfirmed))
                    {
                        RecordCleanupFailure(result, "OUTPUT_EOF_UNCONFIRMED");
                    }
                }
                else
                {
                    standardOutputEofConfirmed = false;
                    standardErrorEofConfirmed = false;
                }
            }
            else
            {
                try
                {
                    jobEmptyConfirmed = ActiveProcesses(job) == 0;
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "JOB_QUERY_FAILED");
                }
                rootExitConfirmed = true;
            }

            if (process != null)
            {
                try
                {
                    if (outputHandler != null) process.OutputDataReceived -= outputHandler;
                    if (errorHandler != null) process.ErrorDataReceived -= errorHandler;
                    if (exitHandler != null) process.Exited -= exitHandler;
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "PROCESS_EVENT_HANDLER_RELEASE_FAILED");
                }
            }

            if (!CloseHandle(job))
            {
                RecordCleanupFailure(result, "JOB_HANDLE_CLOSE_FAILED");
            }
            else
            {
                jobCloseConfirmed = true;
            }

            if (process != null)
            {
                if (processStarted)
                {
                    try
                    {
                        process.StandardInput.Dispose();
                    }
                    catch (Exception)
                    {
                        RecordCleanupFailure(result, "PROCESS_INPUT_RELEASE_FAILED");
                    }
                }
                try
                {
                    process.Dispose();
                }
                catch (Exception)
                {
                    RecordCleanupFailure(result, "PROCESS_HANDLE_RELEASE_FAILED");
                }
            }

            result.CleanupConfirmed = rootExitConfirmed && jobEmptyConfirmed &&
                standardOutputEofConfirmed && standardErrorEofConfirmed && jobCloseConfirmed &&
                result.CleanupFailureCode == null;
        }

        result.StandardOutput = output.ToString();
        result.StandardError = error.ToString();
        result.Token = token;
        return result;
    }

    private static void AddRule(DirectorySecurity security, string sid, string rights)
    {
        var permission = (FileSystemRights)Enum.Parse(typeof(FileSystemRights), rights);
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(sid),
            permission,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
    }

    private static void SetDirectorySecurityWithRestorePrivilege(string path, DirectorySecurity security)
    {
        IntPtr token = IntPtr.Zero;
        var restoreStateCaptured = false;
        TokenPrivilegesOne previousState = new TokenPrivilegesOne();
        string operationFailureCode = null;
        Exception operationFailure = null;
        Exception restoreFailure = null;
        Exception closeFailure = null;

        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenAdjustPrivileges, out token))
            {
                operationFailureCode = "TOKEN_ADJUST_PRIVILEGES_OPEN_FAILED";
                throw new InvalidOperationException(operationFailureCode);
            }

            Luid restorePrivilege;
            if (!LookupPrivilegeValue(null, SeRestorePrivilege, out restorePrivilege))
            {
                operationFailureCode = "SE_RESTORE_PRIVILEGE_LOOKUP_FAILED";
                throw new InvalidOperationException(operationFailureCode);
            }

            if (!IsPrivilegeEnabled(token, restorePrivilege))
            {
                var requestedState = new TokenPrivilegesOne
                {
                    PrivilegeCount = 1,
                    Privileges = new LuidAndAttributes
                    {
                        Luid = restorePrivilege,
                        Attributes = SePrivilegeEnabled,
                    },
                };
                var privilegeBufferSize = checked((uint)Marshal.SizeOf(typeof(TokenPrivilegesOne)));
                TokenPrivilegesOne returnedPreviousState;
                uint returnLength;
                var adjusted = AdjustTokenPrivileges(
                    token,
                    false,
                    ref requestedState,
                    privilegeBufferSize,
                    out returnedPreviousState,
                    out returnLength);
                var adjustError = Marshal.GetLastWin32Error();
                if (returnedPreviousState.PrivilegeCount == 1)
                {
                    previousState = returnedPreviousState;
                    restoreStateCaptured = true;
                }

                if (!adjusted || adjustError == ErrorNotAllAssigned)
                {
                    operationFailureCode = "SE_RESTORE_PRIVILEGE_ENABLE_FAILED";
                    throw new InvalidOperationException(operationFailureCode);
                }
                if (!restoreStateCaptured || returnLength < privilegeBufferSize)
                {
                    operationFailureCode = "SE_RESTORE_PRIVILEGE_PREVIOUS_STATE_INVALID";
                    throw new InvalidOperationException(operationFailureCode);
                }
            }

            try
            {
                new DirectoryInfo(path).SetAccessControl(security);
            }
            catch (Exception exception)
            {
                operationFailureCode = "DIRECTORY_ACL_APPLY_FAILED";
                operationFailure = exception;
            }
        }
        catch (Exception exception)
        {
            if (operationFailure == null)
            {
                if (operationFailureCode == null) operationFailureCode = "DIRECTORY_ACL_SETUP_FAILED";
                operationFailure = exception;
            }
        }
        finally
        {
            if (restoreStateCaptured)
            {
                try
                {
                    TokenPrivilegesOne ignoredPreviousState;
                    uint ignoredReturnLength;
                    var restored = AdjustTokenPrivileges(
                        token,
                        false,
                        ref previousState,
                        checked((uint)Marshal.SizeOf(typeof(TokenPrivilegesOne))),
                        out ignoredPreviousState,
                        out ignoredReturnLength);
                    var restoreError = Marshal.GetLastWin32Error();
                    if (!restored || restoreError == ErrorNotAllAssigned)
                    {
                        restoreFailure = new InvalidOperationException("SE_RESTORE_PRIVILEGE_RESTORE_FAILED");
                    }
                }
                catch (Exception exception)
                {
                    restoreFailure = new InvalidOperationException("SE_RESTORE_PRIVILEGE_RESTORE_FAILED", exception);
                }
            }

            if (token != IntPtr.Zero && !CloseHandle(token))
            {
                closeFailure = new InvalidOperationException("TOKEN_HANDLE_CLOSE_FAILED");
            }
        }

        var failures = new List<Exception>();
        if (operationFailure != null)
        {
            failures.Add(new InvalidOperationException(operationFailureCode, operationFailure));
        }
        if (restoreFailure != null) failures.Add(restoreFailure);
        if (closeFailure != null) failures.Add(closeFailure);
        if (failures.Count == 1) throw failures[0];
        if (failures.Count > 1) throw new AggregateException("DIRECTORY_SECURITY_OPERATION_FAILED", failures);
    }

    private static WindowsHarnessTokenReport InspectHandle(IntPtr processHandle)
    {
        IntPtr token = IntPtr.Zero;
        if (!OpenProcessToken(processHandle, TokenQuery, out token))
        {
            throw new InvalidOperationException("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
        }
        try
        {
            var buffers = new List<IntPtr>();
            try
            {
                var userBuffer = GetTokenInformationBuffer(token, TokenUserClass);
                buffers.Add(userBuffer);
                var sid = new SecurityIdentifier(Marshal.ReadIntPtr(userBuffer)).Value;
                var groupsBuffer = GetTokenInformationBuffer(token, TokenGroupsClass);
                buffers.Add(groupsBuffer);
                var groupCount = unchecked((uint)Marshal.ReadInt32(groupsBuffer));
                var headerSize = IntPtr.Size == 8 ? 8 : 4;
                var groupSize = IntPtr.Size == 8 ? 16 : 8;
                var hasAdministratorsSid = false;
                for (uint index = 0; index < groupCount; index++)
                {
                    var groupPointer = IntPtr.Add(groupsBuffer, checked(headerSize + (int)index * groupSize));
                    var groupSidPointer = Marshal.ReadIntPtr(groupPointer);
                    if (String.Equals(new SecurityIdentifier(groupSidPointer).Value, AdministratorsSid, StringComparison.Ordinal))
                    {
                        hasAdministratorsSid = true;
                    }
                }

                var elevationBuffer = GetTokenInformationBuffer(token, TokenElevationClass);
                buffers.Add(elevationBuffer);
                var isElevated = Marshal.ReadInt32(elevationBuffer) != 0;
                var elevationTypeBuffer = GetTokenInformationBuffer(token, TokenElevationTypeClass);
                buffers.Add(elevationTypeBuffer);
                var elevationType = Marshal.ReadInt32(elevationTypeBuffer);
                var integrityBuffer = GetTokenInformationBuffer(token, TokenIntegrityLevelClass);
                buffers.Add(integrityBuffer);
                var integritySid = new SecurityIdentifier(Marshal.ReadIntPtr(integrityBuffer)).Value;
                var profilePath = GetProfilePath(token);
                bool profileLoaded;
                using (var profileKey = Registry.Users.OpenSubKey(sid))
                {
                    profileLoaded = profileKey != null;
                }

                return new WindowsHarnessTokenReport
                {
                    Sid = sid,
                    ProfilePath = profilePath,
                    IntegritySid = integritySid,
                    IsElevated = isElevated,
                    ElevationType = elevationType,
                    HasAdministratorsSid = hasAdministratorsSid,
                    ProfileHiveLoaded = profileLoaded,
                };
            }
            finally
            {
                foreach (var buffer in buffers) Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(token);
        }
    }

    private static IntPtr GetTokenInformationBuffer(IntPtr token, int informationClass)
    {
        uint required;
        GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out required);
        if (required == 0)
        {
            throw new InvalidOperationException("GetTokenInformation did not return a required buffer size: " + Marshal.GetLastWin32Error());
        }
        var buffer = Marshal.AllocHGlobal(checked((int)required));
        if (!GetTokenInformation(token, informationClass, buffer, required, out required))
        {
            var error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(buffer);
            throw new InvalidOperationException("GetTokenInformation failed: " + error);
        }
        return buffer;
    }

    private static bool IsPrivilegeEnabled(IntPtr token, Luid expectedPrivilege)
    {
        var buffer = GetTokenInformationBuffer(token, TokenPrivilegesClass);
        try
        {
            var count = unchecked((uint)Marshal.ReadInt32(buffer));
            var entrySize = Marshal.SizeOf(typeof(LuidAndAttributes));
            for (uint index = 0; index < count; index++)
            {
                var entryPointer = IntPtr.Add(buffer, checked(sizeof(uint) + (int)index * entrySize));
                var entry = (LuidAndAttributes)Marshal.PtrToStructure(entryPointer, typeof(LuidAndAttributes));
                if (entry.Luid.LowPart == expectedPrivilege.LowPart &&
                    entry.Luid.HighPart == expectedPrivilege.HighPart)
                {
                    return (entry.Attributes & SePrivilegeEnabled) != 0;
                }
            }
            return false;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string GetProfilePath(IntPtr token)
    {
        uint length = 0;
        GetUserProfileDirectory(token, null, ref length);
        var buffer = new StringBuilder(checked((int)length));
        if (!GetUserProfileDirectory(token, buffer, ref length))
        {
            throw new InvalidOperationException("GetUserProfileDirectory failed: " + Marshal.GetLastWin32Error());
        }
        return buffer.ToString();
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        var size = Marshal.SizeOf(typeof(JobObjectBasicAccountingInformation));
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformationClass, buffer, (uint)size, IntPtr.Zero))
            {
                throw new InvalidOperationException("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
            }
            var offset = Marshal.OffsetOf(typeof(JobObjectBasicAccountingInformation), "ActiveProcesses").ToInt32();
            return unchecked((uint)Marshal.ReadInt32(buffer, offset));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool TryRecordExit(Process process, WindowsHarnessRunResult result)
    {
        if (result.ExitObserved) return true;
        if (!process.HasExited) return false;
        var exitCode = process.ExitCode;
        result.ExitCode = exitCode;
        result.ExitObserved = true;
        return true;
    }

    private static bool WaitForTaskUntil(Task task, long deadline)
    {
        if (task.IsCompleted) return task.Status == TaskStatus.RanToCompletion;
        var remaining = deadline - Environment.TickCount64;
        if (remaining <= 0) return false;
        try
        {
            return task.Wait((int)Math.Min(Int32.MaxValue, remaining)) &&
                task.Status == TaskStatus.RanToCompletion;
        }
        catch (AggregateException)
        {
            return false;
        }
    }

    private static bool WaitForNoActiveProcessesUntil(IntPtr job, long deadline)
    {
        while (true)
        {
            if (ActiveProcesses(job) == 0) return true;
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0) return ActiveProcesses(job) == 0;
            System.Threading.Thread.Sleep((int)Math.Min(50, remaining));
        }
    }

    private static void RecordCleanupFailure(WindowsHarnessRunResult result, string code)
    {
        if (result.CleanupFailureCode == null) result.CleanupFailureCode = code;
    }

    private sealed class NodeProbeExceptionEvidence
    {
        public NodeProbeExceptionEvidence(string phase, string kind, int? hResult, int? nativeErrorCode)
        {
            Phase = phase;
            Kind = kind;
            HResult = hResult;
            NativeErrorCode = nativeErrorCode;
        }

        public string Phase { get; }
        public string Kind { get; }
        public int? HResult { get; }
        public int? NativeErrorCode { get; }
    }

    private sealed class NodeProbeExitResult
    {
        public NodeProbeExitResult(bool exitObserved, int? exitCode, NodeProbeExceptionEvidence exception)
        {
            ExitObserved = exitObserved;
            ExitCode = exitCode;
            Exception = exception;
        }

        public bool ExitObserved { get; }
        public int? ExitCode { get; }
        public NodeProbeExceptionEvidence Exception { get; }
    }

    private sealed class NodeProbeCaptureSnapshot
    {
        private readonly byte[] captured;
        private readonly int stored;

        public NodeProbeCaptureSnapshot(
            long totalBytes,
            byte[] captured,
            int stored,
            bool eof,
            string readFailureKind,
            NodeProbeExceptionEvidence exception)
        {
            TotalBytes = totalBytes;
            this.captured = captured;
            this.stored = stored;
            Eof = eof;
            ReadFailureKind = readFailureKind;
            Exception = exception;
        }

        public long TotalBytes { get; }
        public bool Truncated { get { return TotalBytes > stored; } }
        public bool Eof { get; }
        public string ReadFailureKind { get; }
        public NodeProbeExceptionEvidence Exception { get; }

        public bool MatchesExpectedRuntime(string expectedRuntime)
        {
            if (!Eof || ReadFailureKind != "none" || Truncated || stored != TotalBytes) return false;
            var expected = Encoding.ASCII.GetBytes(expectedRuntime);
            var contentLength = stored;
            if (contentLength == expected.Length + 2 &&
                captured[contentLength - 2] == (byte)'\r' &&
                captured[contentLength - 1] == (byte)'\n')
            {
                contentLength -= 2;
            }
            else if (contentLength == expected.Length + 1 &&
                     captured[contentLength - 1] == (byte)'\n')
            {
                contentLength--;
            }
            else
            {
                return false;
            }
            if (contentLength != expected.Length) return false;
            for (var index = 0; index < expected.Length; index++)
            {
                if (captured[index] != expected[index]) return false;
            }
            return true;
        }
    }

    private sealed class NodeProbeCapture
    {
        private readonly byte[] captured;
        private readonly object gate = new object();
        private int stored;
        private long totalBytes;
        private bool eof;
        private string readFailureKind = "none";
        private NodeProbeExceptionEvidence exception;

        public NodeProbeCapture(int captureLimitBytes, string failurePhase)
        {
            captured = new byte[captureLimitBytes];
            FailurePhase = failurePhase;
        }

        public string FailurePhase { get; }

        public void Append(byte[] buffer, int count)
        {
            if (count < 0 || count > buffer.Length) throw new ArgumentOutOfRangeException("count");
            lock (gate)
            {
                totalBytes = totalBytes > Int64.MaxValue - count
                    ? Int64.MaxValue
                    : totalBytes + count;
                var copyCount = Math.Min(captured.Length - stored, count);
                if (copyCount > 0)
                {
                    Array.Copy(buffer, 0, captured, stored, copyCount);
                    stored += copyCount;
                }
            }
        }

        public void MarkEof()
        {
            lock (gate) eof = true;
        }

        public void RecordFailure(NodeProbeExceptionEvidence evidence)
        {
            lock (gate)
            {
                if (exception != null) return;
                exception = evidence;
                readFailureKind = evidence.Kind;
            }
        }

        public NodeProbeCaptureSnapshot Snapshot()
        {
            lock (gate)
            {
                var copy = new byte[stored];
                Array.Copy(captured, copy, stored);
                return new NodeProbeCaptureSnapshot(
                    totalBytes,
                    copy,
                    stored,
                    eof,
                    readFailureKind,
                    exception);
            }
        }
    }

    private sealed class BoundedCapture
    {
        private readonly StringBuilder value = new StringBuilder();
        private readonly object gate = new object();
        private int stored;

        public void AppendLine(string line)
        {
            lock (gate)
            {
                if (stored >= MaxCapturedCharacters) return;
                var remaining = MaxCapturedCharacters - stored;
                var text = line.Length + Environment.NewLine.Length <= remaining
                    ? line + Environment.NewLine
                    : line.Substring(0, Math.Max(0, remaining - Environment.NewLine.Length)) + Environment.NewLine;
                value.Append(text);
                stored += text.Length;
            }
        }

        public override string ToString()
        {
            lock (gate) return value.ToString();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAndAttributes
    {
        public Luid Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivilegesOne
    {
        public uint PrivilegeCount;
        public LuidAndAttributes Privileges;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = false)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);

    [DllImport("advapi32.dll", EntryPoint = "LookupPrivilegeValueW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr token,
        [MarshalAs(UnmanagedType.Bool)] bool disableAllPrivileges,
        ref TokenPrivilegesOne newState,
        uint bufferLength,
        out TokenPrivilegesOne previousState,
        out uint returnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, uint length, out uint returnLength);

    [DllImport("userenv.dll", EntryPoint = "GetUserProfileDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder profilePath, ref uint size);

    [DllImport("userenv.dll", EntryPoint = "CreateProfile", CharSet = CharSet.Unicode)]
    private static extern int CreateProfile(string userSid, string userName, StringBuilder profilePath, uint size);
}
