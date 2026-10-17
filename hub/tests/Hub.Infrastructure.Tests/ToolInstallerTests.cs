namespace Hub.Infrastructure.Tests;

public sealed class ToolInstallerTests : IDisposable
{
    private readonly TempDir _dir = new();

    // The tools' file names on this OS (`kotilo-hook.exe` on Windows, `kotilo-hook` elsewhere).
    private static readonly string Hook = Platform.Executable.Name("kotilo-hook");
    private static readonly string StatusLine = Platform.Executable.Name("kotilo-statusline");

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Copies_tool_files_once_and_refreshes_changed_ones()
    {
        var source = Directory.CreateDirectory(_dir.File("app")).FullName;
        var target = _dir.File("bin");
        File.WriteAllText(Path.Combine(source, Hook), "v1");
        File.WriteAllText(Path.Combine(source, "kotilo-hook.dll"), "dll");
        File.WriteAllText(Path.Combine(source, StatusLine), "sl");
        File.WriteAllText(Path.Combine(source, "Hub.Service.exe"), "not a tool");

        ToolInstaller.Sync(source, target, out var failures).Should().BeTrue();
        failures.Should().BeEmpty();
        Directory.GetFiles(target).Select(Path.GetFileName).Should().BeEquivalentTo([Hook, "kotilo-hook.dll", StatusLine]);

        File.WriteAllText(Path.Combine(source, Hook), "v2-longer");
        ToolInstaller.Sync(source, target, out _).Should().BeTrue();
        File.ReadAllText(Path.Combine(target, Hook)).Should().Be("v2-longer");
    }

    [Fact]
    public void Locked_target_is_reported_not_thrown()
    {
        // FileShare.None locks the file only on Windows.
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var source = Directory.CreateDirectory(_dir.File("app")).FullName;
        var target = Directory.CreateDirectory(_dir.File("bin")).FullName;
        File.WriteAllText(Path.Combine(source, Hook), "new content");
        File.WriteAllText(Path.Combine(target, Hook), "old");

        using (new FileStream(Path.Combine(target, Hook), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            ToolInstaller.Sync(source, target, out var failures).Should().BeFalse();
            failures.Should().ContainSingle().Which.Should().StartWith(Hook);
        }
    }

    [Fact]
    public void Switching_to_native_aot_removes_the_old_managed_files()
    {
        var source = Directory.CreateDirectory(_dir.File("app")).FullName;
        var target = Directory.CreateDirectory(_dir.File("bin")).FullName;
        foreach (var f in new[] { "kotilo-hook.dll", "kotilo-hook.runtimeconfig.json", "kotilo-hook.deps.json", "kotilo-statusline.dll" })
        {
            File.WriteAllText(Path.Combine(target, f), "jit");
        }

        File.WriteAllText(Path.Combine(source, Hook), "native");
        File.WriteAllText(Path.Combine(source, StatusLine), "managed host");
        File.WriteAllText(Path.Combine(source, "kotilo-statusline.dll"), "still managed");

        ToolInstaller.Sync(source, target, out _).Should().BeTrue();

        Directory.GetFiles(target).Select(Path.GetFileName).Should().BeEquivalentTo(
            [Hook, StatusLine, "kotilo-statusline.dll"], "only the AOT tool loses its managed files");
    }

    [Fact]
    public void Same_folder_is_a_no_op() =>
        ToolInstaller.Sync(_dir.Path, _dir.Path + "\\", out _).Should().BeTrue();
}
