using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Hub.Core;
using Hub.Core.Adapters;

namespace Hub.Infrastructure.OpenCode;

/// <summary>
/// OpenCode v2 integration: Kotilo's server plugin (<c>adapters/opencode/plugin.js</c>, embedded) copied to
/// <c>$XDG_CONFIG_HOME/opencode/plugins/agenthub.js</c> with the hook exe path filled in. OpenCode loads every <c>*.js</c> in
/// that folder (2.0.22 <c>plugin/source-directory.ts</c>); no OpenCode config file is touched. The file is ours when it has
/// our name and contains the <c>agenthub-hook</c> marker; a foreign file with that name is backed up and left alone.
/// Changes reach a running OpenCode service only after it restarts (<c>opencode service stop</c>), UNVERIFIED hot reload.
/// </summary>
public sealed partial class OpenCodePluginInstaller(string pluginsDir, string hookExePath, TimeProvider? time = null) : IHookInstaller
{
    /// <summary>Fixed under any brand: a renamed file would leave the old plugin behind and OpenCode would load both.</summary>
    public const string FileName = "agenthub.js";

    /// <summary>The quoted placeholder in the template; replaced by the exe path as a JSON (= JS) string literal.</summary>
    public const string ExePlaceholder = "\"__AGENTHUB_HOOK_EXE__\"";

    private const string TemplateResource = "Hub.Infrastructure.OpenCode.plugin.js";

    private static readonly Lazy<string> Template = new(LoadTemplate);

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public string ConfigPath => Path.Combine(pluginsDir, FileName);

    /// <summary>The plugin source Kotilo writes for <c>hookExePath</c>.</summary>
    public string Render() => Template.Value.Replace(ExePlaceholder, JsonSerializer.Serialize(hookExePath), StringComparison.Ordinal);

    public HookStatus GetStatus()
    {
        string? text;
        try
        {
            text = ReadOrNull();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new HookStatus(HookInstallState.InvalidConfig, ConfigPath);
        }

        var state = text switch
        {
            null => HookInstallState.Missing,
            _ when !HookCommand.IsOwn(text) => HookInstallState.InvalidConfig,
            _ when text == Render() => HookInstallState.Installed,
            _ => HookInstallState.Outdated,
        };
        return new HookStatus(state, ConfigPath);
    }

    public string? Install() => Guarded(() =>
    {
        var text = ReadOrNull();
        var expected = Render();
        if (text == expected)
        {
            return null;
        }

        var backup = Backup();
        if (text is not null && !HookCommand.IsOwn(text))
        {
            throw new HookConfigException($"{ConfigPath} exists and is not {Brand.Current.Name}'s plugin; it was left untouched (copy: {backup}).");
        }

        Directory.CreateDirectory(pluginsDir);
        // The temp name doesn't end in .js, so OpenCode never loads a half-written plugin.
        var temp = ConfigPath + ".agenthub-tmp";
        File.WriteAllText(temp, expected, new UTF8Encoding(false));
        File.Move(temp, ConfigPath, overwrite: true);
        return backup;
    });

    public string? Uninstall() => Guarded(() =>
    {
        if (ReadOrNull() is not { } text || !HookCommand.IsOwn(text))
        {
            return null;
        }

        var backup = Backup();
        File.Delete(ConfigPath);
        return backup;
    });

    public IReadOnlyList<string> ReferencedHookExes() => Guarded<IReadOnlyList<string>>(() =>
    {
        if (ReadOrNull() is not { } text || !HookCommand.IsOwn(text) || HookConstant().Match(text) is not { Success: true } match)
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<string>(match.Groups[1].Value) is { Length: > 0 } exe ? [exe] : [];
        }
        catch (JsonException)
        {
            return [];
        }
    });

    private string? ReadOrNull() => File.Exists(ConfigPath) ? File.ReadAllText(ConfigPath) : null;

    /// <summary>Copies the current file to <c>agenthub.js.&lt;exePrefix&gt;-backup-&lt;stamp&gt;</c> (not a <c>.js</c> name, so never loaded).</summary>
    private string? Backup()
    {
        if (!File.Exists(ConfigPath))
        {
            return null;
        }

        var stamp = _time.GetLocalNow().ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var backup = $"{ConfigPath}.{Brand.Current.ExePrefix}-backup-{stamp}";
        File.Copy(ConfigPath, backup, overwrite: true);
        return backup;
    }

    private T Guarded<T>(Func<T> action)
    {
        try
        {
            return action();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new HookConfigException($"{ConfigPath} could not be updated: {ex.Message}", ex);
        }
    }

    private static string LoadTemplate()
    {
        using var stream = typeof(OpenCodePluginInstaller).Assembly.GetManifestResourceStream(TemplateResource)
            ?? throw new InvalidOperationException($"Missing embedded resource {TemplateResource}.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    [GeneratedRegex("""^const HOOK = ("(?:[^"\\]|\\.)*")""", RegexOptions.Multiline)]
    private static partial Regex HookConstant();
}
