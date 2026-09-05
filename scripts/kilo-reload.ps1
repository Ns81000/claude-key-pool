# Kilo Code config reload trigger — replicates the Kilo plugin's "Reload" button.
#
# The button posts /instance/reload to the local Kilo server the plugin spawns
# (kilo.exe serve). That server is protected by a one-time Basic-auth password
# the extension generates (crypto.randomBytes(32).hex) and passes only via the
# KILO_SERVER_PASSWORD environment variable — it is never written to disk. So
# the only way for an external process to make the same call is to read that
# variable from the server process's own environment block (same user,
# read-only, via PEB), then POST with kilo:<password> Basic auth.
#
# Output: a single JSON line on stdout:
#   {"ok":true,"status":"reloaded"}
#   {"ok":false,"status":"kilo-not-running"}   - no kilo.exe serve process
#   {"ok":false,"status":"session-running"}    - HTTP 409, a session is active
#   {"ok":false,"status":"failed","detail":"…"}
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class ProcEnv {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr hProcess, int pic, ref PROCESS_BASIC_INFORMATION pbi, int cb, out int pSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr baseAddress, byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    private static IntPtr ReadPtr(IntPtr h, IntPtr address) {
        byte[] buf = new byte[8];
        IntPtr n;
        if (!ReadProcessMemory(h, address, buf, 8, out n)) return IntPtr.Zero;
        return new IntPtr(BitConverter.ToInt64(buf, 0));
    }

    private static byte[] ReadBlock(IntPtr h, IntPtr address, int size) {
        byte[] buf = new byte[size];
        IntPtr n;
        if (!ReadProcessMemory(h, address, buf, size, out n)) return null;
        return buf;
    }

    // Reads one variable from another process's environment block (UTF-16).
    // Offsets are x64: PEB->ProcessParameters at PEB+0x20; the Environment
    // pointer sits at +0x98 in the classic layout and +0x80 on Windows 11
    // 24H2+ — both are probed; the block is located via EnvironmentSize
    // (+0x3F0) with a double-NUL scan as the fallback.
    public static string GetEnvironmentVariable(int pid, string name) {
        IntPtr h = OpenProcess(0x0410, false, pid); // QUERY_INFORMATION | VM_READ
        if (h == IntPtr.Zero) return null;
        try {
            PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
            int pSize;
            int st = NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out pSize);
            if (st != 0 || pbi.PebBaseAddress == IntPtr.Zero) return null;
            IntPtr rupp = ReadPtr(h, new IntPtr(pbi.PebBaseAddress.ToInt64() + 0x20));
            if (rupp == IntPtr.Zero) return null;
            IntPtr env = ReadPtr(h, new IntPtr(rupp.ToInt64() + 0x98));
            if (env == IntPtr.Zero) env = ReadPtr(h, new IntPtr(rupp.ToInt64() + 0x80));
            if (env == IntPtr.Zero) return null;
            long envSize = 0;
            byte[] sizeBuf = ReadBlock(h, new IntPtr(rupp.ToInt64() + 0x3F0), 8);
            if (sizeBuf != null) envSize = BitConverter.ToInt64(sizeBuf, 0);
            byte[] blk = null;
            if (envSize > 0 && envSize < 4 * 1024 * 1024) blk = ReadBlock(h, env, (int)envSize);
            if (blk == null) {
                const int chunk = 4096;
                System.Collections.Generic.List<byte> acc = new System.Collections.Generic.List<byte>();
                while (acc.Count < 1024 * 1024) {
                    byte[] part = ReadBlock(h, new IntPtr(env.ToInt64() + acc.Count), chunk);
                    if (part == null) break;
                    acc.AddRange(part);
                    byte[] a = acc.ToArray();
                    for (int i = 2; i + 3 < a.Length; i++) {
                        if (a[i] == 0 && a[i + 1] == 0 && a[i + 2] == 0 && a[i + 3] == 0) {
                            blk = new byte[i + 4];
                            Array.Copy(a, 0, blk, 0, i + 4);
                            break;
                        }
                    }
                    if (blk != null) break;
                }
                if (blk == null) blk = acc.ToArray();
                if (blk.Length == 0) return null;
            }
            string text = System.Text.Encoding.Unicode.GetString(blk);
            string prefix = name + "=";
            foreach (string v in text.Split(new char[] { '\0' })) {
                if (v != null && v.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return v.Substring(prefix.Length);
            }
            return null;
        } finally {
            CloseHandle(h);
        }
    }
}
'@
Add-Type -TypeDefinition $src

function Out-Json($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

# 1. Find the Kilo server process (spawned by the extension as `kilo.exe serve`).
$proc = Get-CimInstance Win32_Process -Filter "Name='kilo.exe'" |
    Where-Object { $_.CommandLine -like '*serve*' } | Select-Object -First 1
if (-not $proc) { Out-Json @{ ok = $false; status = 'kilo-not-running' }; exit 0 }

# 2. Read the one-time server password from the process environment.
$password = [ProcEnv]::GetEnvironmentVariable($proc.ProcessId, 'KILO_SERVER_PASSWORD')
if (-not $password) {
    Out-Json @{ ok = $false; status = 'failed'; detail = 'KILO_SERVER_PASSWORD not found in kilo.exe environment' }
    exit 0
}

# 3. Find the port it listens on.
$port = (Get-NetTCPConnection -OwningProcess $proc.ProcessId -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Select-Object -First 1).LocalPort
if (-not $port) {
    Out-Json @{ ok = $false; status = 'failed'; detail = "kilo.exe pid $($proc.ProcessId) has no listening port" }
    exit 0
}

# 4. Same call the Reload button makes: POST /instance/reload with Basic auth.
$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("kilo:" + $password))
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:$port/instance/reload" -Method POST `
        -Headers @{ Authorization = $auth } -TimeoutSec 10 -UseBasicParsing
    Out-Json @{ ok = $true; status = 'reloaded' }
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 409) {
        Out-Json @{ ok = $false; status = 'session-running'; detail = 'Cannot reload while a Kilo session is running' }
    } else {
        $msg = $_.Exception.Message -replace '\r?\n', ' '
        Out-Json @{ ok = $false; status = 'failed'; detail = "http=$code $msg" }
    }
}
