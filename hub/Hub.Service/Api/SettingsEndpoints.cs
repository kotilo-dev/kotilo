using System.Globalization;
using Hub.Core.Ai;
using Hub.Core.Buddy;
using Hub.Core.Notifications;
using Hub.Core.Usage;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

/// <summary>User-editable insight options; the hub's own bookkeeping (last scheduled run, seen versions, toast days) stays out.</summary>
public sealed record InsightSettingsDto(
    bool GitEnabled, int UncommittedThreshold, bool UncommittedInToast, bool DailySummaryEnabled, string DailySummaryTime,
    bool DailySummaryWithoutAi, string HealthInfoBarLevel);

/// <summary>An OpenAI-compatible endpoint. <c>hasKey</c> is read-only (the key itself goes through <c>PUT /v1/ai/providers/{name}/key</c>).</summary>
public sealed record AiProviderSettingsDto(string Name, string Kind, string BaseUrl, string? Model, bool HasKey = false);

/// <summary><c>settings.ai</c>; optional on PUT (left out = unchanged).</summary>
public sealed record AiSettingsDto(
    IReadOnlyList<AiProviderSettingsDto> Providers, AiFeatureChoice Assistant, AiFeatureChoice DailySummary, AiFeatureChoice DictationCleanup)
{
    public static AiSettingsDto From(AiSettings s, Func<string, bool> hasKey) => new(
        s.Providers.Select(p => new AiProviderSettingsDto(p.Name, p.Kind, p.BaseUrl, p.Model, hasKey(p.Name))).ToList(),
        s.Assistant, s.DailySummary, s.DictationCleanup);

    public AiSettings ToSettings() => new()
    {
        Providers = Providers
            .Select(p => new AiProviderConfig
            {
                Name = p.Name.Trim(),
                Kind = p.Kind,
                BaseUrl = p.BaseUrl.Trim(),
                Model = string.IsNullOrWhiteSpace(p.Model) ? null : p.Model.Trim(),
            })
            .ToList(),
        Assistant = Normalize(Assistant),
        DailySummary = Normalize(DailySummary),
        DictationCleanup = Normalize(DictationCleanup),
    };

    private static AiFeatureChoice Normalize(AiFeatureChoice c) =>
        c with { Provider = c.Provider.Trim(), Model = string.IsNullOrWhiteSpace(c.Model) ? null : c.Model.Trim() };
}

/// <summary><c>GET/PUT /v1/settings</c>. No secrets live here (provider keys go to the platform vault).</summary>
public sealed record HubSettingsDto(
    string Language,
    RuleOptions Rules,
    UsageRuleOptions UsageRules,
    QuietHours QuietHours,
    DateTimeOffset? DoNotDisturbUntil,
    bool SuppressWhenTerminalFocused,
    BuddySettings Buddy,
    TaskSettings Tasks,
    DictationSettings Dictation,
    string TasksGlob,
    InsightSettingsDto Insights,
    AiSettingsDto? Ai = null)
{
    public static HubSettingsDto From(AppSettings s, Func<string, bool> hasKey) => new(
        s.Language, s.Rules, s.UsageRules, s.QuietHours, s.DoNotDisturbUntil, s.SuppressWhenTerminalFocused, s.Buddy, s.Tasks, s.Dictation, s.TasksGlob,
        new InsightSettingsDto(
            s.Insights.GitEnabled, s.Insights.UncommittedThreshold, s.Insights.UncommittedInToast, s.Insights.DailySummaryEnabled,
            s.Insights.DailySummaryTime, s.Insights.DailySummaryWithoutAi, s.Insights.HealthInfoBarLevel),
        AiSettingsDto.From(s.Ai, hasKey));

    public AppSettings ApplyTo(AppSettings current) => current with
    {
        Language = Language,
        Rules = Rules,
        UsageRules = UsageRules,
        QuietHours = QuietHours,
        DoNotDisturbUntil = DoNotDisturbUntil,
        SuppressWhenTerminalFocused = SuppressWhenTerminalFocused,

        // A pre-M3 client may still echo the old model aliases; `ai` replaced them.
        Buddy = Buddy with { Model = null },
        Tasks = Tasks,
        Dictation = Dictation with { AiModel = null },
        TasksGlob = TasksGlob,
        Insights = current.Insights with
        {
            GitEnabled = Insights.GitEnabled,
            UncommittedThreshold = Insights.UncommittedThreshold,
            UncommittedInToast = Insights.UncommittedInToast,
            DailySummaryEnabled = Insights.DailySummaryEnabled,
            DailySummaryTime = Insights.DailySummaryTime,
            DailySummaryWithoutAi = Insights.DailySummaryWithoutAi,
            HealthInfoBarLevel = Insights.HealthInfoBarLevel,
        },
        Ai = Ai?.ToSettings() ?? current.Ai,
    };
}

public sealed record PricingDto(string Path, string? Error, IReadOnlyDictionary<string, ModelPrice> Models);

internal static class SettingsEndpoints
{
    private static readonly string[] Languages = ["en-US", "tr-TR"];
    private static readonly string[] DictationModels = ["large", "small"];
    private static readonly string[] DictationLanguages = ["tr", "en", "auto"];
    private static readonly string[] InsertMethods = ["paste", "type"];
    private static readonly string[] Severities = ["Info", "Warning", "Error"];
    private static readonly string[] WalkAreas = ["taskbar", "corner"];

    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/settings", () => ApiJson.Ok(HubSettingsDto.From(host.Settings, host.AiProviders.HasKey)));

        app.MapPut("/v1/settings", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<HubSettingsDto>(request);
            if (error is not null)
            {
                return error;
            }

            var fields = Validate(body!);
            if (fields.Count > 0)
            {
                return ApiJson.BadRequest("Some settings are not valid.", fields);
            }

            var removed = host.Settings.Ai.Providers.Select(p => p.Name).ToList();
            host.UpdateSettings(body!.ApplyTo(host.Settings));
            AiEndpoints.ForgetRemovedKeys(host, removed);
            return ApiJson.Ok(HubSettingsDto.From(host.Settings, host.AiProviders.HasKey));
        });

        app.MapGet("/v1/pricing", () => ApiJson.Ok(new PricingDto(host.Usage.Pricing.Path, host.Usage.Pricing.Error, host.Usage.Pricing.Current.Models)));
    }

    /// <summary>Per-field messages; empty when the settings can be saved.</summary>
    internal static Dictionary<string, string[]> Validate(HubSettingsDto s)
    {
        var f = new Dictionary<string, string[]>(StringComparer.Ordinal);
        void Fail(string field, string message) => f[field] = [message];

        // Nested records arrive null when the client leaves them out; that is an error, not "use defaults".
        if (s.Rules is null || s.UsageRules is null || s.QuietHours is null || s.Buddy is null || s.Tasks is null || s.Dictation is null || s.Insights is null)
        {
            Fail("settings", "every section is required (send back what GET returned)");
            return f;
        }

        if (!Languages.Contains(s.Language))
        {
            Fail("language", "en-US | tr-TR");
        }

        var r = s.Rules;
        if (r.ContextThresholdPercent is < 1 or > 100)
        {
            Fail("rules.contextThresholdPercent", "1..100");
        }

        if (r.ContextRearmPercent < 0 || r.ContextRearmPercent >= r.ContextThresholdPercent)
        {
            Fail("rules.contextRearmPercent", "0 ≤ value < contextThresholdPercent");
        }

        foreach (var (name, value) in new[]
                 {
                     ("rules.errorDebounce", r.ErrorDebounce), ("rules.minTurnForCompleted", r.MinTurnForCompleted), ("rules.reminderAfter", r.ReminderAfter),
                     ("rules.debounce", r.Debounce), ("rules.settle", r.Settle),
                 })
        {
            if (value < TimeSpan.Zero || value > TimeSpan.FromDays(1))
            {
                Fail(name, "between 00:00:00 and 1.00:00:00");
            }
        }

        var u = s.UsageRules;
        if (u.BlockTokenThresholds is null || u.BlockTokenThresholds.Any(t => t <= 0))
        {
            Fail("usageRules.blockTokenThresholds", "positive numbers");
        }

        if (u.ResetMargin is < 0 or >= 1)
        {
            Fail("usageRules.resetMargin", "0 ≤ value < 1");
        }

        if (u.DailyCostThresholdUsd < 0 || (u.DailyCostEnabled && u.DailyCostThresholdUsd == 0))
        {
            Fail("usageRules.dailyCostThresholdUsd", "> 0 when enabled");
        }

        if (string.IsNullOrWhiteSpace(s.TasksGlob))
        {
            Fail("tasksGlob", "required");
        }

        if (!TimeOnly.TryParseExact(s.Insights.DailySummaryTime, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
        {
            Fail("insights.dailySummaryTime", "HH:mm");
        }

        if (s.Insights.UncommittedThreshold < 1)
        {
            Fail("insights.uncommittedThreshold", "≥ 1");
        }

        if (!Severities.Contains(s.Insights.HealthInfoBarLevel))
        {
            Fail("insights.healthInfoBarLevel", "Info | Warning | Error");
        }

        var d = s.Dictation;
        if (!DictationModels.Contains(d.Model))
        {
            Fail("dictation.model", "large | small");
        }

        if (!DictationLanguages.Contains(d.Language))
        {
            Fail("dictation.language", "tr | en | auto");
        }

        if (!InsertMethods.Contains(d.InsertMethod))
        {
            Fail("dictation.insertMethod", "paste | type");
        }

        if (d.MaxMinutes is < 1 or > 30)
        {
            Fail("dictation.maxMinutes", "1..30");
        }

        if (!Enum.TryParse<Hub.Core.Dictation.DictationMode>(d.Mode, out _))
        {
            Fail("dictation.mode", string.Join(" | ", Enum.GetNames<Hub.Core.Dictation.DictationMode>()));
        }

        if (d.OutputFile && string.IsNullOrWhiteSpace(d.FilePath))
        {
            Fail("dictation.filePath", "required when the file output is on");
        }

        foreach (var (name, gesture) in new[]
                 {
                     ("dictation.hotkey", d.Hotkey), ("dictation.pasteLastHotkey", d.PasteLastHotkey), ("tasks.hotkey", s.Tasks.Hotkey), ("buddy.hotkey", s.Buddy.Hotkey),
                 })
        {
            if (HotkeyGesture.Parse(gesture) is null)
            {
                Fail(name, "a shortcut like Ctrl+Alt+D");
            }
        }

        // The assistant's shortcut is registered next to the others: compared after parsing ("alt+ctrl+space" = "Ctrl+Alt+Space").
        if (HotkeyGesture.Parse(s.Buddy.Hotkey) is { } assistant)
        {
            foreach (var (name, gesture) in new[] { ("dictation.hotkey", d.Hotkey), ("dictation.pasteLastHotkey", d.PasteLastHotkey), ("tasks.hotkey", s.Tasks.Hotkey) })
            {
                if (HotkeyGesture.Parse(gesture) is { } other && (other.Modifiers, other.VirtualKey) == (assistant.Modifiers, assistant.VirtualKey))
                {
                    Fail("buddy.hotkey", $"already used by {name}");
                    break;
                }
            }
        }

        if (s.Buddy.MascotScale is < 2 or > 4)
        {
            Fail("buddy.mascotScale", "2..4");
        }

        if (!WalkAreas.Contains(s.Buddy.WalkArea))
        {
            Fail("buddy.walkArea", "taskbar | corner");
        }

        if (s.Ai is not null)
        {
            ValidateAi(s.Ai, Fail);
        }

        return f;
    }

    /// <summary><c>ai.providers[i].*</c> and <c>ai.&lt;feature&gt;.*</c>.</summary>
    private static void ValidateAi(AiSettingsDto ai, Action<string, string> fail)
    {
        if (ai.Providers is null || ai.Assistant is null || ai.DailySummary is null || ai.DictationCleanup is null)
        {
            fail("ai", "providers, assistant, dailySummary and dictationCleanup are required");
            return;
        }

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < ai.Providers.Count; i++)
        {
            var p = ai.Providers[i];
            var at = $"ai.providers[{i}]";
            if (p is null)
            {
                fail(at, "required");
                continue;
            }

            if (!AiProviderIds.IsValidName(p.Name?.Trim()))
            {
                fail(at + ".name", "1–48 letters, digits, '.', '_' or '-'");
            }
            else if (!names.Add(p.Name!.Trim()))
            {
                fail(at + ".name", "already used by another provider");
            }

            if (p.Kind != AiProviderIds.OpenAiKind)
            {
                fail(at + ".kind", AiProviderIds.OpenAiKind);
            }

            if (!AiProviderIds.IsValidBaseUrl(p.BaseUrl?.Trim()))
            {
                fail(at + ".baseUrl", "an http(s) URL without credentials, query or fragment");
            }

            if (!string.IsNullOrWhiteSpace(p.Model) && !AiProviderIds.IsValidModel(p.Model.Trim()))
            {
                fail(at + ".model", "letters, digits and . _ : / @ # + - [ ]");
            }
        }

        foreach (var (field, choice) in new[] { ("assistant", ai.Assistant), ("dailySummary", ai.DailySummary), ("dictationCleanup", ai.DictationCleanup) })
        {
            var at = "ai." + field;
            var model = string.IsNullOrWhiteSpace(choice.Model) ? null : choice.Model.Trim();
            if (model is not null && !AiProviderIds.IsValidModel(model))
            {
                fail(at + ".model", "letters, digits and . _ : / @ # + - [ ]");
            }

            if (!AiProviderIds.TryParse(choice.Provider?.Trim(), out var kind, out var name))
            {
                fail(at + ".provider", "cli:<agent id> or openai:<provider name>");
            }
            else if (kind == "cli" && CliAgentSpecs.Find(name) is null)
            {
                fail(at + ".provider", "agents: " + string.Join(", ", CliAgentSpecs.All.Select(a => a.AdapterId)));
            }
            else if (kind == AiProviderIds.OpenAiKind)
            {
                var provider = ai.Providers.FirstOrDefault(x => string.Equals(x?.Name?.Trim(), name, StringComparison.OrdinalIgnoreCase));
                if (provider is null)
                {
                    fail(at + ".provider", "no provider with this name in ai.providers");
                }
                else if (model is null && string.IsNullOrWhiteSpace(provider.Model))
                {
                    fail(at + ".model", "required: the provider has no default model");
                }
            }
        }
    }
}
