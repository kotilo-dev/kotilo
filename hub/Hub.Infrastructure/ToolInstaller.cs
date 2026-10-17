using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure;

/// <summary>
/// Keeps agenthub-hook and kotilo-statusline in a stable folder (<c>%LOCALAPPDATA%\kotilo\hub\bin</c>) so the commands
/// written to Claude's <c>settings.json</c> do not depend on where the app was built or unpacked (decision D-061).
/// Files are copied when missing or different; a file locked by a running hook keeps its old copy until next start.
/// </summary>
public static class ToolInstaller
{
    private static readonly string[] Tools = [Hub.Core.Brand.Current.HookMarker, Hub.Core.Brand.Current.ExePrefix + "-statusline"];
    private static readonly string[] Extensions = [Executable.Suffix, ".dll", ".runtimeconfig.json", ".deps.json"];

    /// <returns>True when every tool file in <paramref name="targetDir"/> matches the source.</returns>
    public static bool Sync(string sourceDir, string targetDir, out IReadOnlyList<string> failures)
    {
        var failed = new List<string>();
        failures = failed;
        if (string.Equals(Path.GetFullPath(sourceDir).TrimEnd('\\'), Path.GetFullPath(targetDir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        Directory.CreateDirectory(targetDir);
        RemoveStaleJitFiles(sourceDir, targetDir, failed);
        foreach (var name in Tools.SelectMany(t => Extensions.Select(e => t + e)))
        {
            var source = Path.Combine(sourceDir, name);
            if (!File.Exists(source))
            {
                // A Native AOT build ships only the executable.
                continue;
            }

            var target = Path.Combine(targetDir, name);
            if (Same(source, target))
            {
                continue;
            }

            try
            {
                var temp = target + ".new";
                File.Copy(source, temp, overwrite: true);
                File.Move(temp, target, overwrite: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                failed.Add($"{name}: {ex.Message}");
            }
        }

        return failed.Count == 0;
    }

    /// <summary>
    /// When the source ships a Native AOT exe (no managed .dll next to it), the managed files of an earlier JIT copy are
    /// removed from the target: the native exe never loads them and they would only confuse.
    /// </summary>
    private static void RemoveStaleJitFiles(string sourceDir, string targetDir, List<string> failed)
    {
        foreach (var tool in Tools)
        {
            if (!File.Exists(Path.Combine(sourceDir, Executable.Name(tool))) || File.Exists(Path.Combine(sourceDir, tool + ".dll")))
            {
                continue;
            }

            foreach (var stale in Extensions.Where(e => e != Executable.Suffix).Select(e => Path.Combine(targetDir, tool + e)).Where(File.Exists))
            {
                try
                {
                    File.Delete(stale);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    failed.Add($"{Path.GetFileName(stale)}: {ex.Message}");
                }
            }
        }
    }

    private static bool Same(string a, string b)
    {
        var fa = new FileInfo(a);
        var fb = new FileInfo(b);
        return fb.Exists && fa.Length == fb.Length && fa.LastWriteTimeUtc == fb.LastWriteTimeUtc;
    }
}
