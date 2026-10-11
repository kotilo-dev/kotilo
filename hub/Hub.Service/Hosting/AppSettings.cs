using System.Text.Json;
using System.Text.Json.Serialization;
using Hub.Core.Ai;
using Hub.Core.Notifications;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>The hub's own settings (<c>%LOCALAPPDATA%\kotilo\hub\settings.json</c>, spec §13).</summary>
public sealed record AppSettings
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    /// <summary>UI language: Turkish (spec header) on a Turkish Windows, English otherwise.</summary>
    public string Language { get; init; } =
        System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "tr" ? "tr-TR" : "en-US";

    public RuleOptions Rules { get; init; } = new();

    public UsageRuleOptions UsageRules { get; init; } = new();

    /// <summary>The user's own statusLine command that kotilo-statusline chains (spec §9).</summary>
    public string? StatusLineWrappedCommand { get; init; }

    /// <summary>Daily quiet period for all toasts (spec §11.2).</summary>
    public QuietHours QuietHours { get; init; } = new();

    /// <summary>"Rahatsız etme" from the tray menu; persisted so it survives a restart.</summary>
    public DateTimeOffset? DoNotDisturbUntil { get; init; }

    /// <summary>Skip <c>session.waiting_*</c> toasts when that session's terminal is the foreground window (spec §11.2).</summary>
    public bool SuppressWhenTerminalFocused { get; init; } = true;

    /// <summary>Bip: chat window and mascot (spec §17.6).</summary>
    public BuddySettings Buddy { get; init; } = new();

    /// <summary>Görevlerim: quick task shortcut and deadline reminders (spec §21).</summary>
    public TaskSettings Tasks { get; init; } = new();

    /// <summary>Dikte: speech to text with local Whisper, optional AI cleanup (spec §22).</summary>
    public DictationSettings Dictation { get; init; } = new();

    /// <summary>Project-relative glob for todo files (spec §8.2).</summary>
    public string TasksGlob { get; init; } = Core.Projects.GlobPattern.Default;

    /// <summary>Faz 6 options (spec §18.8). Context threshold and error toasts live in <see cref="Rules"/>.</summary>
    public InsightSettings Insights { get; init; } = new();

    /// <summary>AI providers and the provider per feature (M3). Keys are in the platform vault, never here.</summary>
    public AiSettings Ai { get; init; } = new();

    public static AppSettings Load(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                return (JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path), JsonOptions) ?? new AppSettings()).MigrateAi();
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warning(ex, "Could not read settings from {Path}; using defaults", path);
        }

        return new AppSettings();
    }

    /// <summary>
    /// Pre-M3 files carry a Claude model alias per feature (<c>Buddy.Model</c>, <c>Insights.DailySummaryModel</c>,
    /// <c>Dictation.AiModel</c>): they become <c>cli:claude-code</c> with that model and the old fields are dropped.
    /// The on/off toggles (<c>DailySummaryWithoutAi</c>, <c>Dictation.AiCleanup</c>) stay where they are.
    /// </summary>
    public AppSettings MigrateAi()
    {
        if (Buddy.Model is null && Insights.DailySummaryModel is null && Dictation.AiModel is null)
        {
            return this;
        }

        var legacy = AiSettings.FromLegacy(Buddy.Model, Insights.DailySummaryModel, Dictation.AiModel);
        return this with
        {
            Ai = Ai with { Assistant = legacy.Assistant, DailySummary = legacy.DailySummary, DictationCleanup = legacy.DictationCleanup },
            Buddy = Buddy with { Model = null },
            Insights = Insights with { DailySummaryModel = null },
            Dictation = Dictation with { AiModel = null },
        };
    }

    public void Save(string path)
    {
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(this, JsonOptions));
        File.Move(temp, path, overwrite: true);
    }
}

/// <summary>Spec §18.8.</summary>
public sealed record InsightSettings
{
    public bool GitEnabled { get; init; } = true;

    /// <summary>The "completed" toast says "N değişiklik commit edilmedi" from this many changed files (spec §18.3).</summary>
    public int UncommittedThreshold { get; init; } = 1;

    public bool UncommittedInToast { get; init; } = true;

    public bool DailySummaryEnabled { get; init; } = true;

    /// <summary>Local time of day, "HH:mm".</summary>
    public string DailySummaryTime { get; init; } = "18:30";

    /// <summary>Pre-M3 Claude model alias of the AI summary; moved to <c>Ai.DailySummary</c> on load, then null.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? DailySummaryModel { get; init; }

    /// <summary>"AI'sız mod": always the deterministic template.</summary>
    public bool DailySummaryWithoutAi { get; init; }

    /// <summary>Lowest health severity shown as an InfoBar: "Info", "Warning" or "Error".</summary>
    public string HealthInfoBarLevel { get; init; } = "Info";

    /// <summary>Day the scheduled summary last ran, so it runs once a day.</summary>
    public DateOnly? DailySummaryLastAuto { get; init; }

    /// <summary>Claude Code version last seen in transcripts, for the "updated" notice.</summary>
    public string? ClaudeVersion { get; init; }

    public string? PreviousClaudeVersion { get; init; }

    public DateTimeOffset? ClaudeVersionChangedAt { get; init; }

    /// <summary>Per health check: the day its error toast was last shown (at most one a day, spec §18.6).</summary>
    public IReadOnlyDictionary<string, DateOnly> HealthToastShown { get; init; } = new Dictionary<string, DateOnly>();
}

/// <summary>Spec §22.7.</summary>
public sealed record DictationSettings
{
    public bool Enabled { get; init; } = true;

    /// <summary>Hold to talk, or tap to start and tap again to stop.</summary>
    public string Hotkey { get; init; } = "Ctrl+Alt+D";

    /// <summary>Pastes the last dictation into the focused field again.</summary>
    public string PasteLastHotkey { get; init; } = "Ctrl+Alt+Shift+D";

    /// <summary>"large" (large-v3-turbo) or "small".</summary>
    public string Model { get; init; } = "large";

    /// <summary>"tr", "en" or "auto".</summary>
    public string Language { get; init; } = "tr";

    /// <summary>Vulkan GPU when available; the CPU otherwise.</summary>
    public bool UseGpu { get; init; } = true;

    /// <summary>AI cleanup (text only) through the provider in <c>Ai.DictationCleanup</c>.</summary>
    public bool AiCleanup { get; init; }

    /// <summary><see cref="Hub.Core.Dictation.DictationMode"/> name.</summary>
    public string Mode { get; init; } = "Clean";

    public string CustomPrompt { get; init; } = "";

    /// <summary>Pre-M3 Claude model alias of the cleanup; moved to <c>Ai.DictationCleanup</c> on load, then null.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? AiModel { get; init; }

    /// <summary>Terms separated by new lines or commas.</summary>
    public string Vocabulary { get; init; } = "";

    /// <summary>Insert into the field that had focus when dictation started.</summary>
    public bool OutputFocused { get; init; } = true;

    /// <summary>"paste" (clipboard + Ctrl+V, clipboard restored) or "type" (key events).</summary>
    public string InsertMethod { get; init; } = "paste";

    public bool OutputClipboard { get; init; }

    public bool OutputFile { get; init; }

    /// <summary>Markdown file the text is appended to with a timestamp heading.</summary>
    public string FilePath { get; init; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), $"{Hub.Core.Brand.Current.Name} Dikte.md");

    public bool SoundCues { get; init; } = true;

    /// <summary>Recording stops by itself after this many minutes.</summary>
    public int MaxMinutes { get; init; } = 5;

    public bool KeepHistory { get; init; } = true;
}

/// <summary>Spec §21.4.</summary>
public sealed record TaskSettings
{
    /// <summary>Opens the quick task window; parsed by <see cref="Hub.Core.Buddy.HotkeyGesture"/>.</summary>
    public string Hotkey { get; init; } = "Ctrl+Alt+N";

    /// <summary>Toast when a task's deadline arrives (date-only deadlines at 09:00).</summary>
    public bool Reminders { get; init; } = true;
}

/// <summary>Spec §17.6.</summary>
public sealed record BuddySettings
{
    public bool Enabled { get; init; } = true;

    public bool MascotEnabled { get; init; } = true;

    /// <summary>"Ctrl+Alt+Space" style; parsed by <see cref="Hub.Core.Buddy.HotkeyGesture"/>.</summary>
    public string Hotkey { get; init; } = "Ctrl+Alt+Space";

    /// <summary>Pre-M3 Claude model alias of Bip; moved to <c>Ai.Assistant</c> on load, then null.</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Model { get; init; }

    /// <summary>Nearest-neighbor scale of the 16 px sprite: 2, 3 or 4.</summary>
    public int MascotScale { get; init; } = 3;

    /// <summary>"taskbar" walks along the taskbar; "corner" stays in the bottom-right corner.</summary>
    public string WalkArea { get; init; } = "taskbar";

    public bool Celebrate { get; init; } = true;

    /// <summary>Off by default: Bip's own Claude runs stay out of sessions, notifications and the mascot (spec §17.2).</summary>
    public bool ShowBuddySessions { get; init; }

    /// <summary>"1 saat gizle" from the mascot menu.</summary>
    public DateTimeOffset? MascotHiddenUntil { get; init; }

    /// <summary>The mascot's position along the walking axis, 0..1, kept after a drag.</summary>
    public double MascotPosition { get; init; } = 0.85;
}
