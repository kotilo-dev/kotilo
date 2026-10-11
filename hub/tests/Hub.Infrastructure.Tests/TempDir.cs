namespace Hub.Infrastructure.Tests;

internal sealed class TempDir : IDisposable
{
    public TempDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "agenthub-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public string File(string name) => System.IO.Path.Combine(Path, name);

    public void Dispose()
    {
        try
        {
            // Only this folder's databases: a global ClearAllPools would also reach connections that tests running in
            // parallel are still using (suspected cause of two rare, unreproducible failures).
            foreach (var db in Directory.EnumerateFiles(Path, "*.db", SearchOption.AllDirectories))
            {
                using var connection = new Microsoft.Data.Sqlite.SqliteConnection(new Hub.Infrastructure.Data.Database(db).ConnectionString);
                Microsoft.Data.Sqlite.SqliteConnection.ClearPool(connection);
            }

            // git writes its object files read-only.
            foreach (var file in Directory.EnumerateFiles(Path, "*", SearchOption.AllDirectories))
            {
                System.IO.File.SetAttributes(file, FileAttributes.Normal);
            }

            Directory.Delete(Path, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
