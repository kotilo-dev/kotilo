using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class ArchitectureTests
{
    private static readonly string[] ForbiddenPrefixes =
    [
        "Microsoft.UI",
        "Microsoft.WinUI",
        "Microsoft.Windows",
        "Microsoft.AspNetCore",
        "Microsoft.Data.Sqlite",
        "Dapper",
        "Hub.Infrastructure",
        "Hub.Service",
    ];

    [Fact]
    public void Core_does_not_reference_ui_web_or_storage_assemblies()
    {
        var references = typeof(SessionInfo).Assembly.GetReferencedAssemblies().Select(a => a.Name!);

        references.Should().NotContain(name => ForbiddenPrefixes.Any(p => name.StartsWith(p, StringComparison.Ordinal)));
    }
}
