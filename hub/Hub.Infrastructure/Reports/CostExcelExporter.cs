using Hub.Core.Insights;
using ClosedXML.Excel;

namespace Hub.Infrastructure.Reports;

/// <summary>Column headers and sheet names in the UI language.</summary>
public sealed record CostExcelLabels(
    string CustomerSheet,
    string ProjectSheet,
    string ModelSheet,
    string DailySheet,
    string Customer,
    string Project,
    string Model,
    string Projects,
    string Sessions,
    string Tokens,
    string Cost,
    string Share,
    string Date,
    string Total,
    string Note,
    string AgentSheet = "Agents",
    string Agent = "Agent");

/// <summary>
/// Excel export of the monthly cost report (spec §18.2): one sheet per grouping plus the raw daily data.
/// Numbers are written as numbers so totals can be checked in Excel.
/// </summary>
public static class CostExcelExporter
{
    /// <param name="reports">The same month built with each grouping.</param>
    /// <param name="rowName">Display name per row (resolves "Atanmamış" / "Buddy").</param>
    public static void Export(string path, IReadOnlyDictionary<CostGrouping, CostReport> reports, Func<CostRow, string> rowName, CostExcelLabels l)
    {
        using var book = new XLWorkbook();
        foreach (var (grouping, sheet, first) in new[]
                 {
                     (CostGrouping.Customer, l.CustomerSheet, l.Customer),
                     (CostGrouping.Project, l.ProjectSheet, l.Project),
                     (CostGrouping.Model, l.ModelSheet, l.Model),
                     (CostGrouping.Agent, l.AgentSheet, l.Agent),
                 })
        {
            if (reports.TryGetValue(grouping, out var report))
            {
                WriteGroupSheet(book.Worksheets.Add(sheet), report, first, rowName, l);
            }
        }

        if (reports.Values.FirstOrDefault() is { } any)
        {
            WriteDailySheet(book.Worksheets.Add(l.DailySheet), any, l);
        }

        book.SaveAs(path);
    }

    private static void WriteGroupSheet(IXLWorksheet ws, CostReport report, string firstHeader, Func<CostRow, string> rowName, CostExcelLabels l)
    {
        string[] headers = [firstHeader, l.Projects, l.Sessions, l.Tokens, l.Cost, l.Share];
        for (var i = 0; i < headers.Length; i++)
        {
            ws.Cell(1, i + 1).Value = headers[i];
        }

        var row = 2;
        foreach (var r in report.Rows)
        {
            ws.Cell(row, 1).Value = rowName(r);
            ws.Cell(row, 2).Value = string.Join(", ", r.Projects);
            ws.Cell(row, 3).Value = r.Sessions;
            ws.Cell(row, 4).Value = r.Totals.TotalTokens;
            ws.Cell(row, 5).Value = r.Totals.CostUsd;
            ws.Cell(row, 6).Value = r.Share;
            row++;
        }

        ws.Cell(row, 1).Value = l.Total;
        ws.Cell(row, 3).Value = report.Sessions;
        ws.Cell(row, 4).Value = report.Totals.TotalTokens;
        ws.Cell(row, 5).Value = report.Totals.CostUsd;
        ws.Row(row).Style.Font.Bold = true;
        ws.Cell(row + 2, 1).Value = l.Note;

        ws.Row(1).Style.Font.Bold = true;
        ws.Column(4).Style.NumberFormat.Format = "#,##0";
        ws.Column(5).Style.NumberFormat.Format = "\"$\"#,##0.00";
        ws.Column(6).Style.NumberFormat.Format = "0.0%";
        ws.SheetView.FreezeRows(1);
        ws.Columns(1, 6).AdjustToContents(1, row);
    }

    private static void WriteDailySheet(IXLWorksheet ws, CostReport report, CostExcelLabels l)
    {
        string[] headers = [l.Date, l.Project, l.Customer, l.Model, l.Tokens, l.Cost];
        for (var i = 0; i < headers.Length; i++)
        {
            ws.Cell(1, i + 1).Value = headers[i];
        }

        var row = 2;
        foreach (var d in report.Daily)
        {
            ws.Cell(row, 1).Value = d.Date.ToDateTime(TimeOnly.MinValue);
            ws.Cell(row, 2).Value = d.Project;
            ws.Cell(row, 3).Value = d.Customer;
            ws.Cell(row, 4).Value = d.Model;
            ws.Cell(row, 5).Value = d.Totals.TotalTokens;
            ws.Cell(row, 6).Value = d.Totals.CostUsd;
            row++;
        }

        ws.Row(1).Style.Font.Bold = true;
        ws.Column(1).Style.NumberFormat.Format = "yyyy-mm-dd";
        ws.Column(5).Style.NumberFormat.Format = "#,##0";
        ws.Column(6).Style.NumberFormat.Format = "\"$\"#,##0.00";
        ws.SheetView.FreezeRows(1);
        if (row > 2)
        {
            ws.Range(1, 1, row - 1, 6).SetAutoFilter();
        }

        ws.Columns(1, 6).AdjustToContents(1, Math.Min(row, 500));
    }
}
