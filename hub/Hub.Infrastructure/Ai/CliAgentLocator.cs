using System.Collections.Concurrent;
using Hub.Core.Ai;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Ai;

/// <summary>
/// Finds an agent CLI without running it: each file name (exe before cmd) on PATH, then in the agent's known install
/// folders. Generalises the former Claude-only locator.
/// </summary>
public static class CliAgentLocator
{
    public static string? Find(CliAgentSpec spec, string? pathVariable = null, string? userProfile = null)
    {
        var known = spec.KnownDirs.Select(d => CliLaunch.ExpandKnownDir(d, userProfile)).ToList();
        var dirs = (pathVariable ?? Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Concat(known)
            .ToList();

        return Search(spec.Executables, dirs) ?? Search(spec.KnownDirOnlyExecutables, known);
    }

    private static string? Search(IEnumerable<string> baseNames, IReadOnlyList<string> dirs)
    {
        foreach (var name in baseNames.SelectMany(CliLaunch.FileNames))
        {
            foreach (var dir in dirs)
            {
                try
                {
                    var candidate = Path.Combine(dir.Trim('"'), name);
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch (ArgumentException)
                {
                }
            }
        }

        return null;
    }
}

/// <summary>In-memory <see cref="ISecretStore"/> for tests; never touches the platform vault.</summary>
public sealed class InMemorySecretStore : ISecretStore
{
    private readonly ConcurrentDictionary<string, string> _secrets = new(StringComparer.OrdinalIgnoreCase);

    public bool IsAvailable => true;

    public string? Read(string name) => _secrets.TryGetValue(name, out var s) ? s : null;

    public void Write(string name, string secret) => _secrets[name] = secret;

    public bool Delete(string name) => _secrets.TryRemove(name, out _);
}
