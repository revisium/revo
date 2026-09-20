using Microsoft.Win32;
using System;
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
    private const int ProfilePathBufferChars = 260;
    private const uint SePrivilegeEnabled = 0x00000002;
    private const int ErrorNotAllAssigned = 1300;
    private const string SeRestorePrivilege = "SeRestorePrivilege";

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
                foreach (var entry in environment)
                {
                    start.Environment[entry.Key] = entry.Value;
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
                        result.FailureCode = "PROCESS_START_FAILED";
                    }
                }
                catch (Exception)
                {
                    result.FailureCode = "PROCESS_START_FAILED";
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
