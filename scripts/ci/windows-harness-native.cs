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
    public string StandardOutput { get; set; }
    public string StandardError { get; set; }
    public WindowsHarnessTokenReport Token { get; set; }
}

public static class WindowsHarnessNative
{
    private const uint TokenQuery = 0x0008;
    private const int TokenUserClass = 1;
    private const int TokenGroupsClass = 2;
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

    public static string CreateUserProfile(string sid, string userName)
    {
        var path = new StringBuilder(32768);
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
        new DirectoryInfo(path).SetAccessControl(security);
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
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
        }

        Process process = null;
        var output = new BoundedCapture();
        var error = new BoundedCapture();
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var assignedToJob = false;
        var cleanupConfirmed = false;
        var timedOut = false;
        var exitCode = -1;
        WindowsHarnessTokenReport token = null;

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
                    throw new InvalidOperationException("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(limitsBuffer);
            }

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

            process = Process.Start(start);
            if (process == null)
            {
                throw new InvalidOperationException("Could not start standard-user harness process");
            }

            process.OutputDataReceived += (sender, eventArgs) =>
            {
                if (eventArgs.Data == null) return;
                output.AppendLine(eventArgs.Data);
                if (String.Equals(eventArgs.Data, readyMarker, StringComparison.Ordinal)) ready.TrySetResult(true);
            };
            process.ErrorDataReceived += (sender, eventArgs) =>
            {
                if (eventArgs.Data != null) error.AppendLine(eventArgs.Data);
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            if (!ready.Task.Wait(TimeSpan.FromSeconds(timeoutSeconds)))
            {
                timedOut = !process.HasExited;
                throw new TimeoutException("Standard-user harness did not reach its ready handshake");
            }

            token = InspectHandle(process.Handle);
            var tokenFailure = ValidateStandardUser(token, expectedSid);
            if (tokenFailure != null)
            {
                throw new InvalidOperationException("Standard-user token or loaded profile preflight failed: " + tokenFailure);
            }

            if (!AssignProcessToJobObject(job, process.Handle))
            {
                throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
            }
            assignedToJob = true;
            process.StandardInput.WriteLine("GO");
            process.StandardInput.Flush();

            if (!process.WaitForExit(checked(timeoutSeconds * 1000)))
            {
                timedOut = true;
                TerminateJobObject(job, 124);
                if (!process.WaitForExit(15000))
                {
                    throw new InvalidOperationException("Timed-out fixture process did not exit after job termination");
                }
            }
            process.WaitForExit();
            exitCode = process.ExitCode;

            var active = ActiveProcesses(job);
            if (active != 0)
            {
                TerminateJobObject(job, 125);
                if (!WaitForNoActiveProcesses(job, 15000))
                {
                    throw new InvalidOperationException("Fixture job retained processes after termination");
                }
                throw new InvalidOperationException("Fixture job left descendant processes running");
            }

            cleanupConfirmed = true;
        }
        catch
        {
            if (process != null && !process.HasExited)
            {
                if (assignedToJob)
                {
                    TerminateJobObject(job, 126);
                    process.WaitForExit(15000);
                }
                else
                {
                    process.Kill(true);
                    process.WaitForExit(15000);
                }
            }
            if (assignedToJob && ActiveProcesses(job) == 0) cleanupConfirmed = true;
            throw;
        }
        finally
        {
            if (process != null)
            {
                if (process.HasExited) process.WaitForExit();
                process.Dispose();
            }
            if (!CloseHandle(job))
            {
                throw new InvalidOperationException("CloseHandle for fixture job failed: " + Marshal.GetLastWin32Error());
            }
        }

        return new WindowsHarnessRunResult
        {
            ExitCode = exitCode,
            TimedOut = timedOut,
            CleanupConfirmed = cleanupConfirmed,
            StandardOutput = output.ToString(),
            StandardError = error.ToString(),
            Token = token,
        };
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

    private static bool WaitForNoActiveProcesses(IntPtr job, int timeoutMilliseconds)
    {
        var deadline = Environment.TickCount64 + timeoutMilliseconds;
        do
        {
            if (ActiveProcesses(job) == 0) return true;
            System.Threading.Thread.Sleep(50);
        } while (Environment.TickCount64 < deadline);
        return ActiveProcesses(job) == 0;
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

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, uint length, out uint returnLength);

    [DllImport("userenv.dll", EntryPoint = "GetUserProfileDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserProfileDirectory(IntPtr token, StringBuilder profilePath, ref uint size);

    [DllImport("userenv.dll", EntryPoint = "CreateProfile", CharSet = CharSet.Unicode)]
    private static extern int CreateProfile(string userSid, string userName, StringBuilder profilePath, uint size);
}
