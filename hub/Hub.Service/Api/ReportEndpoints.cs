using System.Globalization;
using Hub.Core.Insights;
using Hub.Infrastructure.Data;
using Hub.Infrastructure.Reports;
using Hub.Service.Hosting;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Hub.Service.Api;

public sealed record WaitSpanDto(string SessionId, string ProjectRoot, string ProjectName, WaitKind Kind, DateTimeOffset Start, DateTimeOffset End, double Seconds, string? Tool, bool IsOpen);

public sealed record WaitDayDto(DateOnly Date, double PermissionSeconds, double InputSeconds);

public sealed record WaitProjectDto(string ProjectRoot, string ProjectName, double Seconds);

public sealed record WaitReportDto(
    DateOnly From,
    DateOnly To,
    double TotalSeconds,
    int Count,
    double AverageSeconds,
    double MedianSeconds,
    double PermissionSeconds,
    double InputSeconds,
    double DuringQuietHoursSeconds,
    string? TopPermissionTool,
    WaitSpanDto? Longest,
    IReadOnlyList<double> ByHourSeconds,
    IReadOnlyList<WaitProjectDto> ByProject,
    IReadOnlyList<WaitDayDto> ByDay,
    IReadOnlyList<WaitSpanDto> LongestSpans);

public sealed record CostRowDto(CostRowKind Kind, string Key, string Name, string? Color, IReadOnlyList<string> Projects, int Sessions, TotalsDto Totals, double Share);

public sealed record CostReportDto(DateOnly From, DateOnly To, CostGrouping GroupBy, int Sessions, TotalsDto Totals, IReadOnlyList<CostRowDto> Rows);

public sealed record DailySummaryDto(DateOnly Date, string Markdown, string? Model, DateTimeOffset GeneratedAt);

public sealed record DailySummaryInputDto(DateOnly Date, int ActiveMinutes, int Sessions, long Tokens, decimal CostUsd, int WaitMinutes, bool HasActivity);

public sealed record DailySummaryDetailDto(DailySummaryDto? Summary, DailySummaryInputDto Input);

/// <summary>Generation needs the AI runner and localized template labels from a client; until then the hub only serves stored summaries.</summary>
public sealed record DailySummaryStatusDto(bool Enabled, string ScheduledAt, bool WithoutAi, string Model, bool GenerationAvailable, string? Reason);

public sealed record CustomerDto(long Id, string Name, string Color, bool Archived);

public sealed record CustomerBody(string? Name, string? Color, bool? Archived);

/// <summary>Reports: waits, cost (+ CSV/XLSX), daily summaries, customers (docs/hub-api.md §Reports).</summary>
internal static class ReportEndpoints
{
    public static void Map(IEndpointRouteBuilder app, AppHost host)
    {
        app.MapGet("/v1/reports/waits", (string? from, string? to) =>
        {
            if (Range(from, to, 7) is not { } r)
            {
                return RangeError();
            }

            var zone = TimeZoneInfo.Local;
            var start = UsageEndpoints.StartOf(r.From, zone);
            var end = UsageEndpoints.StartOf(r.To.AddDays(1), zone);
            var now = DateTimeOffset.UtcNow;
            var spans = host.Insights.WaitSpans(start, end, now);
            var m = WaitMetricsCalculator.Calculate(spans, start, end, zone, host.Settings.QuietHours);
            var names = UsageEndpoints.ProjectNames(host);
            WaitSpanDto Span(WaitSpan s) =>
                new(s.SessionId, s.ProjectRoot, names(s.ProjectRoot), s.Kind, s.Start, s.End, s.Duration.TotalSeconds, s.Tool, s.IsOpen);
            return ApiJson.Ok(new WaitReportDto(
                r.From, r.To, m.Total.TotalSeconds, m.Count, m.Average.TotalSeconds, m.Median.TotalSeconds,
                m.PermissionTotal.TotalSeconds, m.InputTotal.TotalSeconds, m.DuringQuietHours.TotalSeconds, m.TopPermissionTool,
                m.Longest is { } l ? Span(l) : null,
                m.ByHour.Select(h => h.TotalSeconds).ToList(),
                m.ByProject.Select(p => new WaitProjectDto(p.Key, names(p.Key), p.Value.TotalSeconds)).ToList(),
                m.ByDay.Select(d => new WaitDayDto(d.Date, d.Permission.TotalSeconds, d.Input.TotalSeconds)).ToList(),
                spans.Where(s => s.Start >= start && s.Start < end).OrderByDescending(s => s.Duration).Take(50).Select(Span).ToList()));
        });

        app.MapGet("/v1/reports/cost", (string? from, string? to, string? groupBy, string? format, string? lang) =>
        {
            if (Range(from, to, 30) is not { } r)
            {
                return RangeError();
            }

            if (Grouping(groupBy) is not { } grouping)
            {
                return ApiJson.BadRequest(
                    "'groupBy' must be customer, project, agent or model.",
                    new Dictionary<string, string[]> { ["groupBy"] = ["customer | project | agent | model"] });
            }

            var tr = NotificationFeed.IsTurkish(lang ?? host.Settings.Language);
            var report = Build(host, r.From, r.To, grouping);
            switch (format?.ToLowerInvariant())
            {
                case null or "" or "json":
                    return ApiJson.Ok(new CostReportDto(
                        r.From, r.To, grouping, report.Sessions, TotalsDto.From(report.Totals),
                        report.Rows.Select(x => new CostRowDto(x.Kind, x.Key, RowName(x, tr), x.Color, x.Projects, x.Sessions, TotalsDto.From(x.Totals), x.Share)).ToList()));
                case "csv":
                    var culture = tr ? CultureInfo.GetCultureInfo("tr-TR") : CultureInfo.InvariantCulture;
                    var csv = CostCsvExporter.Export(report, CsvHeaders(grouping, tr), x => RowName(x, tr), culture);
                    return Results.File(csv, "text/csv; charset=utf-8", FileName(r, "csv"));
                case "xlsx":
                    var reports = Enum.GetValues<CostGrouping>().ToDictionary(g => g, g => g == grouping ? report : Build(host, r.From, r.To, g));
                    var path = Path.Combine(Path.GetTempPath(), "agenthub-cost-" + Guid.NewGuid().ToString("N") + ".xlsx");
                    try
                    {
                        CostExcelExporter.Export(path, reports, x => RowName(x, tr), ExcelLabels(tr));
                        return Results.File(File.ReadAllBytes(path), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", FileName(r, "xlsx"));
                    }
                    finally
                    {
                        File.Delete(path);
                    }

                default:
                    return ApiJson.BadRequest("'format' must be json, csv or xlsx.", new Dictionary<string, string[]> { ["format"] = ["json | csv | xlsx"] });
            }
        });

        app.MapGet("/v1/reports/daily-summaries", (int? limit) =>
            ApiJson.Ok(host.Insights.Summaries.List(Math.Clamp(limit ?? 30, 1, 365)).Select(Summary).ToList()));

        app.MapGet("/v1/reports/daily-summaries/status", () =>
        {
            var o = host.Settings.Insights;
            return ApiJson.Ok(new DailySummaryStatusDto(
                o.DailySummaryEnabled, o.DailySummaryTime, o.DailySummaryWithoutAi, host.Settings.Ai.DailySummary.Model ?? host.Settings.Ai.DailySummary.Provider, false,
                "clientRequired"));
        });

        app.MapGet("/v1/reports/daily-summaries/{date}", async (string date, CancellationToken ct) =>
        {
            if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
            {
                return ApiJson.BadRequest("'date' must be yyyy-MM-dd.", new Dictionary<string, string[]> { ["date"] = ["yyyy-MM-dd"] });
            }

            var input = await host.DailySummaries.InputAsync(day, ct);
            return ApiJson.Ok(new DailySummaryDetailDto(
                host.DailySummaries.Get(day) is { } s ? Summary(s) : null,
                new DailySummaryInputDto(input.Date, input.ActiveMinutes, input.Sessions, input.Tokens, input.CostUsd, input.WaitMinutes, input.HasActivity)));
        });

        app.MapGet("/v1/customers", () => ApiJson.Ok(host.Insights.Customers.LoadAll().Select(Customer).ToList()));

        app.MapPost("/v1/customers", async (HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<CustomerBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (string.IsNullOrWhiteSpace(body!.Name))
            {
                return ApiJson.BadRequest("A name is required.", new Dictionary<string, string[]> { ["name"] = ["required"] });
            }

            return ApiJson.Created(Customer(host.Insights.AddCustomer(body.Name.Trim(), body.Color ?? "#7c9cff")));
        });

        app.MapPut("/v1/customers/{id:long}", async (long id, HttpRequest request) =>
        {
            var (body, error) = await ApiJson.ReadAsync<CustomerBody>(request);
            if (error is not null)
            {
                return error;
            }

            if (host.Insights.Customers.LoadAll().FirstOrDefault(c => c.Id == id) is not { } existing)
            {
                return ApiJson.NotFound($"No customer {id}.");
            }

            var updated = existing with
            {
                Name = string.IsNullOrWhiteSpace(body!.Name) ? existing.Name : body.Name.Trim(),
                Color = body.Color ?? existing.Color,
                Archived = body.Archived ?? existing.Archived,
            };
            host.Insights.UpdateCustomer(updated);
            return ApiJson.Ok(Customer(updated));
        });

        app.MapDelete("/v1/customers/{id:long}", (long id) =>
        {
            if (!host.Insights.Customers.LoadAll().Any(c => c.Id == id))
            {
                return ApiJson.NotFound($"No customer {id}.");
            }

            host.Insights.DeleteCustomer(id);
            return Results.NoContent();
        });
    }

    private static CostReport Build(AppHost host, DateOnly from, DateOnly to, CostGrouping grouping)
    {
        var zone = TimeZoneInfo.Local;
        var builder = new CostReportBuilder(host.Insights.CustomerOfProject(), host.Buddy.Filter.IsBuddy, UsageEndpoints.ProjectNames(host));
        return builder.Build(host.Usage.Repository.Load(UsageEndpoints.StartOf(from, zone)), from, to, grouping, zone);
    }

    private static CostGrouping? Grouping(string? value) => (value ?? "project").ToLowerInvariant() switch
    {
        "customer" => CostGrouping.Customer,
        "project" => CostGrouping.Project,
        "agent" => CostGrouping.Agent,
        "model" => CostGrouping.Model,
        _ => null,
    };

    private static string RowName(CostRow row, bool tr) => row.Kind switch
    {
        CostRowKind.Unassigned => tr ? "Atanmamış" : "Unassigned",
        CostRowKind.Buddy => "Buddy",
        _ => row.Name,
    };

    private static string[] CsvHeaders(CostGrouping grouping, bool tr)
    {
        var first = grouping switch
        {
            CostGrouping.Customer => tr ? "Müşteri" : "Customer",
            CostGrouping.Model => "Model",
            CostGrouping.Agent => tr ? "Ajan" : "Agent",
            _ => tr ? "Proje" : "Project",
        };
        return tr
            ? [first, "Projeler", "Oturum", "Token", "Maliyet (USD)", "Pay (%)"]
            : [first, "Projects", "Sessions", "Tokens", "Cost (USD)", "Share (%)"];
    }

    private static CostExcelLabels ExcelLabels(bool tr) => tr
        ? new("Müşteriler", "Projeler", "Modeller", "Günlük", "Müşteri", "Proje", "Model", "Projeler", "Oturum", "Token", "Maliyet (USD)", "Pay", "Tarih", "Toplam",
            "Tutarlar yerel API fiyatı tahminidir.", "Ajanlar", "Ajan")
        : new("Customers", "Projects", "Models", "Daily", "Customer", "Project", "Model", "Projects", "Sessions", "Tokens", "Cost (USD)", "Share", "Date", "Total",
            "Amounts are local API-price estimates.", "Agents", "Agent");

    private static string FileName((DateOnly From, DateOnly To) r, string extension) =>
        string.Create(CultureInfo.InvariantCulture, $"{Hub.Core.Brand.Current.Slug}-cost-{r.From:yyyy-MM-dd}-{r.To:yyyy-MM-dd}.{extension}");

    private static DailySummaryDto Summary(DailySummaryRecord s) => new(s.Date, s.Markdown, s.Model, s.GeneratedAt);

    private static CustomerDto Customer(Customer c) => new(c.Id, c.Name, c.Color, c.Archived);

    /// <summary>Inclusive local-date range from <c>yyyy-MM-dd</c> strings; defaults to the last <paramref name="days"/> days.</summary>
    private static (DateOnly From, DateOnly To)? Range(string? from, string? to, int days)
    {
        var today = DateOnly.FromDateTime(DateTime.Now);
        DateOnly f, t;
        if (to is null)
        {
            t = today;
        }
        else if (!DateOnly.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out t))
        {
            return null;
        }

        if (from is null)
        {
            f = t.AddDays(-(days - 1));
        }
        else if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out f))
        {
            return null;
        }

        return f <= t && t.DayNumber - f.DayNumber < 366 ? (f, t) : null;
    }

    private static IResult RangeError() => ApiJson.BadRequest(
        "'from'/'to' must be yyyy-MM-dd, from ≤ to, at most 366 days.",
        new Dictionary<string, string[]> { ["from"] = ["yyyy-MM-dd"], ["to"] = ["yyyy-MM-dd"] });
}
