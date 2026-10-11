using System.Globalization;
using System.Runtime.InteropServices;
using Hub.Infrastructure;
using Hub.Service.Hosting;
using Serilog;

// Headless hub (ARCHITECTURE §2.2): started and supervised by the desktop app, stopped with Ctrl+C / SIGTERM or,
// with --parent-pid, when that process exits.
var paths = AppPaths.FromEnvironment();
using var instance = new Mutex(initiallyOwned: true, AppPaths.InstanceMutexName, out var createdNew);

// After a rename, take over the legacy-named data folder before anything creates the new one. While a hub under the
// old name still runs, exit 2 so the supervisor retries later (the folder must not be created empty meanwhile).
var migration = createdNew ? LegacyData.MigrateHubDataDir(paths, Hub.Core.Brand.Current) : LegacyMove.NotNeeded;
if (migration.State == LegacyMoveState.LegacyHubRunning)
{
    return 2;
}

paths.EnsureCreated();
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.File(Path.Combine(paths.LogsDir, "hub-.log"), formatProvider: CultureInfo.InvariantCulture, rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14)
    .CreateLogger();

if (migration.State == LegacyMoveState.Moved)
{
    Log.Information("Moved the legacy data folder {From} to {DataDir}", migration.From, paths.DataDir);
}
else if (migration.State == LegacyMoveState.Failed)
{
    Log.Warning("Could not move the legacy data folder {From}: {Error}", migration.From, migration.Error);
}

if (!createdNew)
{
    Log.Warning("Another hub instance is already running; exiting");
    await Log.CloseAndFlushAsync();
    return 2;
}

using var stop = new CancellationTokenSource();
void RequestStop(PosixSignalContext context)
{
    context.Cancel = true;
    stop.Cancel();
}

using var sigint = PosixSignalRegistration.Create(PosixSignal.SIGINT, RequestStop);
using var sigterm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, RequestStop);

if (ParentWatch.ParsePid(args) is { } parentPid)
{
    var parentAlive = ParentWatch.ProcessProbe(parentPid);
    _ = Task.Run(async () =>
    {
        try
        {
            await ParentWatch.WaitForExitAsync(parentAlive, TimeProvider.System, stop.Token);
            Log.Information("Parent process {Pid} exited", parentPid);
            await stop.CancelAsync();
        }
        catch (OperationCanceledException)
        {
        }
    });
}

try
{
    Log.Information("Hub starting (data: {DataDir})", paths.DataDir);
    await using var host = AppHost.Create();
    await host.StartAsync(stop.Token);
    if (host.Ingest.Port is null)
    {
        return 1;
    }

    // Health checks run on their own clock now that there is no UI timer (spec §18.6: every 30 s).
    host.Health.Check(DateTimeOffset.UtcNow);
    using var clock = new PeriodicTimer(TimeSpan.FromSeconds(30));
    try
    {
        while (await clock.WaitForNextTickAsync(stop.Token))
        {
            host.Health.Check(DateTimeOffset.UtcNow);
        }
    }
    catch (OperationCanceledException)
    {
    }

    Log.Information("Hub stopping");
    return 0;
}
#pragma warning disable CA1031 // Last-chance handler: log and exit non-zero so the supervisor restarts us.
catch (Exception ex)
#pragma warning restore CA1031
{
    Log.Fatal(ex, "Hub failed");
    return 1;
}
finally
{
    await Log.CloseAndFlushAsync();
}
