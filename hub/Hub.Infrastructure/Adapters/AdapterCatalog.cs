using Hub.Core.Adapters;
using Hub.Infrastructure.Usage;

namespace Hub.Infrastructure.Adapters;

/// <summary>
/// A built-in agent's code half (ARCHITECTURE §3): event mapping, hook installer (null when the agent has no hooks) and
/// usage sources. <c>adapters/&lt;id&gt;/adapter.json</c> is its data half.
/// </summary>
public sealed record AgentIntegration(IAgentAdapter Adapter, IHookInstaller? Installer)
{
    public IReadOnlyList<IUsageSource> UsageSources { get; init; } = [];
}

/// <summary>One row of <c>GET /v1/adapters</c>.</summary>
/// <param name="Path">The definition file; null for a built-in adapter whose definition was not found.</param>
public sealed record AdapterEntry(string Id, string DisplayName, AdapterSource Source, string? Path)
{
    public AdapterDefinition? Definition { get; init; }

    /// <summary>Maps the agent's events; null when the entry is unusable (invalid user file, id taken by a built-in).</summary>
    public IAgentAdapter? Adapter { get; init; }

    /// <summary>Hook installer; null for protocol (hookless) adapters.</summary>
    public IHookInstaller? Installer { get; init; }

    public string? Error { get; init; }
}

/// <summary>
/// The live adapter set, owned by the host: built-in integrations joined with the built-in definitions, plus a
/// <see cref="GenericAdapter"/> for every valid user definition. Built-in ids win over user ids. <see cref="Reload"/> re-reads
/// the definition folders and swaps <see cref="Entries"/> and <see cref="Registry"/> atomically; readers on other threads
/// always see a consistent pair.
/// </summary>
public sealed class AdapterCatalog
{
    private readonly IReadOnlyList<AgentIntegration> _builtIns;
    private readonly string? _builtInDir;
    private readonly string? _userDir;
    private readonly Lock _reload = new();
    private volatile Snapshot _current;

    public AdapterCatalog(IReadOnlyList<AgentIntegration> builtIns, string? builtInDir, string? userDir)
    {
        _builtIns = builtIns;
        _builtInDir = builtInDir;
        _userDir = userDir;
        _current = Build();
    }

    /// <summary>Raised after <see cref="Reload"/> on the calling thread.</summary>
    public event Action<IReadOnlyList<AdapterEntry>>? Changed;

    public IReadOnlyList<AdapterEntry> Entries => _current.Entries;

    /// <summary>What hook events are mapped with; never contains an entry without an adapter.</summary>
    public AdapterRegistry Registry => _current.Registry;

    public IReadOnlyList<AgentIntegration> BuiltIns => _builtIns;

    /// <summary>The usable entry for <paramref name="id"/> (one with an adapter), if any.</summary>
    public AdapterEntry? Find(string id) => _current.Entries.FirstOrDefault(e => e.Id == id && e.Adapter is not null);

    public IReadOnlyList<AdapterEntry> Reload()
    {
        Snapshot next;
        lock (_reload)
        {
            next = Build();
            _current = next;
        }

        Changed?.Invoke(next.Entries);
        return next.Entries;
    }

    private Snapshot Build()
    {
        var entries = new List<AdapterEntry>();
        var code = _builtIns.ToDictionary(i => i.Adapter.Id, StringComparer.Ordinal);
        var builtInIds = new HashSet<string>(StringComparer.Ordinal);

        foreach (var loaded in AdapterDefinitionLoader.LoadDirectory(_builtInDir, AdapterSource.BuiltIn))
        {
            if (!builtInIds.Add(loaded.Id))
            {
                continue;
            }

            code.TryGetValue(loaded.Id, out var integration);
            if (loaded.Definition is { } d)
            {
                entries.Add(new AdapterEntry(d.Id, d.DisplayName, AdapterSource.BuiltIn, loaded.Path)
                {
                    Definition = d,
                    Adapter = integration?.Adapter ?? new GenericAdapter(d.Id, d.DisplayName),
                    Installer = integration?.Installer,
                });
            }
            else
            {
                // A broken bundled file must not switch off an agent whose code adapter works.
                entries.Add(new AdapterEntry(loaded.Id, integration?.Adapter.DisplayName ?? loaded.Id, AdapterSource.BuiltIn, loaded.Path)
                {
                    Adapter = integration?.Adapter,
                    Installer = integration?.Installer,
                    Error = loaded.Error,
                });
            }
        }

        foreach (var integration in _builtIns.Where(i => builtInIds.Add(i.Adapter.Id)))
        {
            entries.Add(new AdapterEntry(integration.Adapter.Id, integration.Adapter.DisplayName, AdapterSource.BuiltIn, null)
            {
                Adapter = integration.Adapter,
                Installer = integration.Installer,
            });
        }

        var userIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var loaded in AdapterDefinitionLoader.LoadDirectory(_userDir, AdapterSource.User))
        {
            if (builtInIds.Contains(loaded.Id))
            {
                entries.Add(new AdapterEntry(loaded.Id, loaded.Definition?.DisplayName ?? loaded.Id, AdapterSource.User, loaded.Path)
                {
                    Definition = loaded.Definition,
                    Error = $"The built-in adapter '{loaded.Id}' takes precedence; give this one another id.",
                });
                continue;
            }

            if (!userIds.Add(loaded.Id))
            {
                continue;
            }

            entries.Add(loaded.Definition is { } d
                ? new AdapterEntry(d.Id, d.DisplayName, AdapterSource.User, loaded.Path)
                {
                    Definition = d,
                    Adapter = new GenericAdapter(d.Id, d.DisplayName),
                }
                : new AdapterEntry(loaded.Id, loaded.Id, AdapterSource.User, loaded.Path) { Error = loaded.Error });
        }

        return new Snapshot(entries, new AdapterRegistry(entries.Where(e => e.Adapter is not null).Select(e => e.Adapter!)));
    }

    private sealed record Snapshot(IReadOnlyList<AdapterEntry> Entries, AdapterRegistry Registry);
}
