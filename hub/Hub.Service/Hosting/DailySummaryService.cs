using Hub.Core.Ai;
using Hub.Core.Insights;
using Hub.Core.Projects;
using Hub.Core.Sessions;
using Hub.Infrastructure.Data;
using Serilog;

namespace Hub.Service.Hosting;

/// <summary>
/// Daily summary (spec §18.7): gathers the day's metadata, asks the daily-summary AI provider (an agent CLI with tools off, or an
/// OpenAI-compatible endpoint) for a short summary in the UI language and falls back to the deterministic template when the
/// provider is missing, fails or AI is switched off. Transcript content is
/// never used. A stored summary is reused while its source data is unchanged.
/// </summary>
public sealed class DailySummaryService(
    InsightsService insights,
    UsageRepository usage,
    BuddyService buddy,
    Func<IReadOnlyList<ProjectProgress>> projects,
    Func<IReadOnlyList<SessionInfo>> liveSessions,
    Func<InsightSettings> settings,
    Func<SummaryLabels> labels,
    Func<string> language) : IDisposable
{
    /// <summary>Stored in <c>daily_summaries.model</c> for the AI-free template.</summary>
    public const string TemplateModel = "template";

    private readonly SemaphoreSlim _gate = new(1, 1);

    /// <summary>Raised after an automatic (scheduled) summary was generated.</summary>
    public event Action<DailySummaryRecord, DailySummaryInput>? ScheduledSummaryReady;

    public DailySummaryRecord? Get(DateOnly date) => insights.Summaries.Get(date);

    /// <summary>
    /// Builds (or reuses) the summary for <paramref name="date"/>. Null when the day had no activity.
    /// </summary>
    /// <param name="force">"Yeniden oluştur": regenerate even if the source is unchanged.</param>
    public async Task<(DailySummaryRecord? Summary, DailySummaryInput Input)> GenerateAsync(DateOnly date, bool force, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var input = await BuildInputAsync(date, ct);
            if (!input.HasActivity)
            {
                return (null, input);
            }

            var hash = input.SourceHash(language());
            var existing = insights.Summaries.Get(date);
            var options = settings();
            if (!force && existing is not null && existing.SourceHash == hash)
            {
                return (existing, input);
            }

            string markdown;
            string model;
            if (options.DailySummaryWithoutAi)
            {
                (markdown, model) = (DailySummaryTemplate.Render(input, labels()), TemplateModel);
            }
            else
            {
                var answer = await buddy.GenerateAsync(
                    AiFeature.DailySummary, input.ToJson(), DailySummaryTemplate.SystemPromptFor(language()), BuddyService.GenerateTimeout, ct);
                if (answer.IsOk)
                {
                    (markdown, model) = (answer.Text!.Trim() + "\n", answer.Model ?? "ai");
                }
                else
                {
                    Log.Warning("Daily summary via the AI provider failed ({Kind}); using the template", answer.ErrorKind);
                    (markdown, model) = (DailySummaryTemplate.Render(input, labels()), TemplateModel);
                }
            }

            var record = new DailySummaryRecord(date, markdown, model, DateTimeOffset.UtcNow, hash);
            insights.Summaries.Save(record);
            Log.Information("Daily summary for {Date} generated ({Model}, {Projects} projects)", date, model, input.Projects.Count);
            return (record, input);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Called by the UI clock: runs today's summary once, at or after the configured time.</summary>
    public async Task<bool> RunScheduledAsync(DateTimeOffset now, Action<DateOnly> markDone, CancellationToken ct)
    {
        var options = settings();
        if (!options.DailySummaryEnabled || !TimeOnly.TryParse(options.DailySummaryTime, System.Globalization.CultureInfo.InvariantCulture, out var at))
        {
            return false;
        }

        var local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local);
        var today = DateOnly.FromDateTime(local.DateTime);
        if (options.DailySummaryLastAuto == today || TimeOnly.FromDateTime(local.DateTime) < at)
        {
            return false;
        }

        markDone(today);
        var (summary, input) = await GenerateAsync(today, force: false, ct);
        if (summary is not null)
        {
            ScheduledSummaryReady?.Invoke(summary, input);
        }

        return summary is not null;
    }

    /// <summary>The day's source data without generating anything (Raporlar shows its numbers next to a stored summary).</summary>
    public Task<DailySummaryInput> InputAsync(DateOnly date, CancellationToken ct) => BuildInputAsync(date, ct);

    private async Task<DailySummaryInput> BuildInputAsync(DateOnly date, CancellationToken ct)
    {
        var zone = TimeZoneInfo.Local;
        var from = WaitMetricsCalculator.StartOfDay(date, zone);
        var to = WaitMetricsCalculator.StartOfDay(date.AddDays(1), zone);
        var now = DateTimeOffset.UtcNow;

        var known = projects().ToDictionary(p => p.Root, StringComparer.OrdinalIgnoreCase);
        string Name(string root) => known.TryGetValue(root, out var p) ? p.Name : SessionInfo.ProjectNameFrom(root);
        // Only discovered, visible projects: discovery already leaves out %TEMP% experiments and Bip's folder (D-052, §17.2).
        bool Include(string root) =>
            !string.IsNullOrEmpty(root) && !buddy.Filter.IsBuddy(root) && known.TryGetValue(root, out var p) && !p.Hidden;

        var activity = insights.Activity(from, to, now);
        var waits = WaitMetricsCalculator.Calculate(insights.WaitSpans(from, to, now).Where(s => Include(s.ProjectRoot)).ToList(), from, to, zone);

        var usageByRoot = usage.Load(from)
            .Where(e => e.Timestamp < to && e.ProjectRoot is not null)
            .GroupBy(e => e.ProjectRoot!, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                g => g.Key,
                g => (g.Sum(e => e.TotalTokens), g.Any(e => e.CostUsd is not null) ? (decimal?)g.Sum(e => e.CostUsd ?? 0) : null),
                StringComparer.OrdinalIgnoreCase);

        var completed = TodoDiff.CompletedBetween(insights.TodoSnapshots.Around(from, to), from, to);

        // Commit subjects for every project that was active or is known; git is cheap for a handful of repos.
        var commits = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase);
        if (settings().GitEnabled && insights.GitAvailable)
        {
            var candidates = activity.Keys.Concat(known.Keys).Where(Include).Distinct(StringComparer.OrdinalIgnoreCase);
            foreach (var root in candidates)
            {
                var subjects = await insights.Git.SubjectsSinceAsync(root, from, to, DailySummaryInputBuilder.MaxCommitsPerProject, ct);
                if (subjects.Count > 0)
                {
                    commits[root] = subjects;
                }
            }
        }

        var next = known.Values
            .Where(p => !p.Hidden && p.Next is not null)
            .ToDictionary(p => p.Root, p => p.Next!.Value.Item.Text, StringComparer.OrdinalIgnoreCase);
        var threshold = Math.Max(1, settings().UncommittedThreshold);
        var uncommitted = insights.GitStatuses
            .Where(g => g.Value.Changed >= threshold)
            .ToDictionary(g => g.Key, g => g.Value.Changed, StringComparer.OrdinalIgnoreCase);
        var waiting = liveSessions().Where(s => s.State.NeedsAttention()).Select(s => s.ProjectRoot)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        return DailySummaryInputBuilder.Build(date, activity, usageByRoot, waits, completed, commits, next, uncommitted, waiting, Name, Include);
    }

    public void Dispose() => _gate.Dispose();
}
