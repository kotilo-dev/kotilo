using FluentAssertions;
using Hub.Infrastructure.Platform;

namespace Hub.Infrastructure.Tests;

public sealed class CommandLinePathsTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Path_without_spaces_is_returned_unchanged()
    {
        CommandLinePaths.WithoutSpaces(@"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe")
            .Should().Be(@"C:\Users\u\AppData\Local\agent-hub\hub\bin\agenthub-hook.exe");
    }

    [Fact]
    public void Directory_with_spaces_is_shortened_but_the_file_name_is_kept()
    {
        var dir = Path.Combine(_dir.Path, "with some spaces");
        Directory.CreateDirectory(dir);
        var exe = Path.Combine(dir, "agenthub-hook.exe");
        File.WriteAllBytes(exe, []);

        var result = CommandLinePaths.WithoutSpaces(exe);

        // Null is valid where 8.3 names are disabled; otherwise the result must be usable unquoted.
        if (result is not null)
        {
            result.Should().NotContainAny(" ", "\t");
            Path.GetFileName(result).Should().Be("agenthub-hook.exe");
            File.Exists(result).Should().BeTrue();
        }
    }
}
