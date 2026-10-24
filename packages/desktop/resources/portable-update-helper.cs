using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

[DataContract]
class InstallConfig {
    [DataMember] public string Target;
    [DataMember] public string Destination;
    [DataMember] public bool RenameOnly;
    [DataMember] public string Stage;
    [DataMember] public string Backup;
    [DataMember] public string Sha256;
    [DataMember] public string OriginalSha256;
    [DataMember] public int ParentPid;
    [DataMember] public bool Relaunch;
    [DataMember] public string Ready;
    [DataMember] public string Cancel;
    [DataMember] public string Result;
}
[DataContract]
class InstallResult {
    [DataMember] public bool success;
    [DataMember] public bool rolledBack;
    [DataMember] public string backup;
    [DataMember] public string executable;
    [DataMember] public string error;
}
class PortableUpdateHelper {
    static string Hash(string file) {
        using (var stream = File.OpenRead(file))
        using (var algorithm = SHA256.Create())
            return BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    static Process Launch(string file) {
        return Process.Start(new ProcessStartInfo(file) {
            UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = Path.GetDirectoryName(file)
        });
    }
    static void Save(InstallConfig config, InstallResult result) {
        // Logging cannot roll back a successfully launched application.
        try {
            using (var file = File.Create(config.Result))
                new DataContractJsonSerializer(typeof(InstallResult)).WriteObject(file, result);
        } catch { }
    }
    static int Main(string[] args) {
        InstallConfig c = null;
        bool replaced = false, renamed = false, pathsValid = false, parentExited = false;
        try {
            if (args.Length != 1) return 1;
            using (var file = File.OpenRead(args[0]))
                c = (InstallConfig)new DataContractJsonSerializer(typeof(InstallConfig)).ReadObject(file);
            c.Target = Path.GetFullPath(c.Target);
            c.Destination = String.IsNullOrEmpty(c.Destination) ? c.Target : Path.GetFullPath(c.Destination);
            string directory = Path.GetDirectoryName(Path.GetFullPath(c.Target));
            bool changingName = !String.Equals(c.Target, c.Destination, StringComparison.OrdinalIgnoreCase);
            if (changingName && (!String.Equals(Path.GetDirectoryName(c.Destination), directory, StringComparison.OrdinalIgnoreCase)
                || !Regex.IsMatch(Path.GetFileName(c.Destination), @"^Backspace-\d+\.\d+\.\d+-portable-x64\.exe$")))
                throw new InvalidOperationException("Invalid executable destination");
            if (changingName && (File.Exists(c.Destination) || Directory.Exists(c.Destination)))
                throw new InvalidOperationException("Destination already exists; both executables preserved");
            foreach (string file in c.RenameOnly ? new string[0] : new[] { c.Stage, c.Backup }) {
                if (!String.Equals(Path.GetDirectoryName(Path.GetFullPath(file)), directory, StringComparison.OrdinalIgnoreCase)
                    || String.Equals(file, c.Target, StringComparison.OrdinalIgnoreCase)
                    || !Regex.IsMatch(Path.GetFileName(file), @"^\.backspace-update-[a-f0-9-]+\.(new|backup)\.exe$"))
                    throw new InvalidOperationException("Invalid replacement path");
            }
            if ((!c.RenameOnly && c.Stage == c.Backup) || (c.RenameOnly && (!changingName || c.Stage != null || c.Backup != null))
                || !Regex.IsMatch(c.Sha256, "^[a-f0-9]{64}$") || !Regex.IsMatch(c.OriginalSha256, "^[a-f0-9]{64}$")
                || (c.RenameOnly && c.Sha256 != c.OriginalSha256))
                throw new InvalidOperationException("Invalid replacement data");
            pathsValid = true;
            if (!c.RenameOnly && Hash(c.Stage) != c.Sha256) throw new InvalidOperationException("Staged update checksum mismatch");
            using (var parent = Process.GetProcessById(c.ParentPid)) {
                IntPtr handle = parent.Handle;
                File.WriteAllText(c.Ready, "ready", Encoding.UTF8);
                DateTime deadline = DateTime.UtcNow.AddSeconds(120);
                while (!parent.WaitForExit(250)) {
                    if (File.Exists(c.Cancel)) throw new InvalidOperationException("Update preparation cancelled");
                    if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Application did not exit; original preserved");
                }
            }
            parentExited = true;
            if (File.Exists(c.Cancel)) throw new InvalidOperationException("Update preparation cancelled");
            DateTime replaceDeadline = DateTime.UtcNow.AddSeconds(90);
            while (true) {
                if (!c.RenameOnly && Hash(c.Stage) != c.Sha256) throw new InvalidOperationException("Staged update checksum changed");
                if (Hash(c.Target) != c.OriginalSha256) throw new InvalidOperationException("Original executable changed; refusing replacement");
                if (changingName && (File.Exists(c.Destination) || Directory.Exists(c.Destination)))
                    throw new InvalidOperationException("Destination already exists; both executables preserved");
                try {
                    // Wait for the NSIS outer launcher to release the portable EXE.
                    if (c.RenameOnly) { File.Move(c.Target, c.Destination); renamed = true; }
                    else File.Replace(c.Stage, c.Target, c.Backup);
                    replaced = true;
                    break;
                } catch (IOException) {
                    if (DateTime.UtcNow >= replaceDeadline) throw;
                    Thread.Sleep(250);
                }
            }
            if (changingName && !renamed) { File.Move(c.Target, c.Destination); renamed = true; }
            if (Hash(c.Destination) != c.Sha256) throw new InvalidOperationException("Installed update checksum mismatch");
            if (c.Relaunch) {
                using (var started = Launch(c.Destination))
                    if (started.WaitForExit(3000) && started.ExitCode != 0)
                        throw new InvalidOperationException("Updated application failed to start");
            }
            Save(c, new InstallResult { success = true, backup = c.Backup, executable = c.Destination });
            return 0;
        } catch (Exception error) {
            bool rolledBack = false;
            string failure = error.Message;
            if (replaced) {
                try {
                    if (renamed) File.Move(c.Destination, c.Target);
                    if (!c.RenameOnly) File.Replace(c.Backup, c.Target, null);
                    rolledBack = true;
                } catch (Exception rollback) { failure += "; rollback: " + rollback.Message; }
            }
            if (parentExited && c.Relaunch && (rolledBack || !replaced)) {
                try {
                    if (Hash(c.Target) == c.OriginalSha256) { using (var previous = Launch(c.Target)) { } }
                } catch (Exception restart) { failure += "; restart previous: " + restart.Message; }
            }
            if (c != null) Save(c, new InstallResult { success = false, rolledBack = rolledBack, error = failure });
            return 1;
        } finally {
            if (pathsValid) { try { if (File.Exists(c.Stage)) File.Delete(c.Stage); } catch { } }
        }
    }
}
