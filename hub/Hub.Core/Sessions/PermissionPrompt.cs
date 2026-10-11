using System.Text.RegularExpressions;

namespace Hub.Core.Sessions;

/// <summary>What a permission request may do, as a short label for the permission card (DESIGN_SYSTEM §7.5).</summary>
public enum PermissionRisk
{
    Other,
    DeletesFiles,
    WritesDatabase,
    Network,
    InstallsPackages,
    GitPush,
}

/// <summary>
/// The request a session is waiting on. Lives only in memory on <see cref="SessionInfo"/>: the command may carry
/// secrets, so it is never written to SQLite or a log (AGENTS.md rule 5).
/// </summary>
public sealed record PermissionPrompt(string? Tool, string? Command, string? Path, PermissionRisk? Risk, DateTimeOffset Since);

/// <summary>Heuristic risk label for a shell command; null when there is no command to judge (file edits).</summary>
public static partial class PermissionRiskClassifier
{
    // Order matters: the first match wins, most destructive first.
    private static readonly (PermissionRisk Risk, Regex Pattern)[] Rules =
    [
        (PermissionRisk.DeletesFiles, DeletesFiles()),
        (PermissionRisk.WritesDatabase, WritesDatabase()),
        (PermissionRisk.GitPush, GitPush()),
        (PermissionRisk.InstallsPackages, InstallsPackages()),
        (PermissionRisk.Network, Network()),
    ];

    public static PermissionRisk? Classify(string? command)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            return null;
        }

        foreach (var (risk, pattern) in Rules)
        {
            if (pattern.IsMatch(command))
            {
                return risk;
            }
        }

        return PermissionRisk.Other;
    }

    private const string Start = @"(?:^|[\s;&|(`]|\$\()";

    [GeneratedRegex(Start + @"(?:rm|rmdir|del|erase|rd|Remove-Item|ri|shred|unlink)(?=\s|$)|git\s+clean\b|git\s+reset\s+--hard\b|\bDROP\s+(?:TABLE|DATABASE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex DeletesFiles();

    [GeneratedRegex(@"\b(?:ef\s+database\s+update|ef\s+migrations\s+(?:add|remove)|prisma\s+(?:migrate|db\s+push)|rails\s+db:|alembic\s+upgrade|flyway\s+migrate|knex\s+migrate|sequelize\s+db:migrate|manage\.py\s+migrate)\b|" + Start + @"(?:psql|sqlcmd|mysql|sqlite3|mongosh|redis-cli)(?=\s|$)|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex WritesDatabase();

    [GeneratedRegex(@"\bgit\s+push\b", RegexOptions.IgnoreCase)]
    private static partial Regex GitPush();

    [GeneratedRegex(Start + @"(?:npm\s+(?:i|install|add|ci)|pnpm\s+(?:i|install|add)|yarn\s+(?:add|install)|pip3?\s+install|uv\s+(?:add|pip\s+install)|poetry\s+add|cargo\s+(?:add|install)|go\s+(?:get|install)|gem\s+install|dotnet\s+(?:add\s+\S+\s+package|add\s+package|tool\s+install)|winget\s+install|choco\s+install|scoop\s+install|apt(?:-get)?\s+install|brew\s+install|Install-Module|Install-Package)\b", RegexOptions.IgnoreCase)]
    private static partial Regex InstallsPackages();

    [GeneratedRegex(Start + @"(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|ssh|scp|sftp|rsync|ftp|nc|telnet)(?=\s|$)|\bgit\s+(?:clone|fetch|pull)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Network();
}
