using Hub.Core.Ai;

namespace Hub.Infrastructure.Ai;

/// <summary>
/// The brand's secret store with a fallback to stores under legacy names (credential prefixes from before a rename). A key
/// found only under a legacy name is re-saved under the current one and then removed from the legacy store, so it lives in
/// one place again. Writes go to the current store only; deletes clear every copy.
/// </summary>
public sealed class MigratingSecretStore(ISecretStore current, IReadOnlyList<ISecretStore> legacy) : ISecretStore
{
    public bool IsAvailable => current.IsAvailable;

    public string? Read(string name)
    {
        if (current.Read(name) is { } secret)
        {
            return secret;
        }

        foreach (var old in legacy)
        {
            if (old.Read(name) is not { } found)
            {
                continue;
            }

            current.Write(name, found);
            old.Delete(name);
            return found;
        }

        return null;
    }

    public void Write(string name, string secret) => current.Write(name, secret);

    public bool Delete(string name)
    {
        var deleted = current.Delete(name);
        foreach (var old in legacy)
        {
            deleted |= old.Delete(name);
        }

        return deleted;
    }
}
