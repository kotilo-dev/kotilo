using Hub.Infrastructure.Projects;

namespace Hub.Infrastructure.Tests;

public sealed class ProjectRootResolverTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly ProjectRootResolver _resolver = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Subfolder_of_git_repo_resolves_to_repo_root()
    {
        var repo = Directory.CreateDirectory(_dir.File("repo")).FullName;
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        var deep = Directory.CreateDirectory(Path.Combine(repo, "src", "App", "Views")).FullName;

        _resolver.Resolve(deep).Should().Be(repo);
        _resolver.Resolve(repo + Path.DirectorySeparatorChar).Should().Be(repo);
    }

    [Fact]
    public void Worktree_git_file_also_marks_a_root()
    {
        var wt = Directory.CreateDirectory(_dir.File("wt")).FullName;
        File.WriteAllText(Path.Combine(wt, ".git"), "gitdir: elsewhere");

        _resolver.Resolve(Path.Combine(wt, "sub")).Should().Be(wt);
    }

    [Fact]
    public void Folder_outside_any_repo_stays_as_is()
    {
        var plain = Directory.CreateDirectory(_dir.File("plain")).FullName;
        _resolver.Resolve(plain).Should().Be(plain);
    }

    [Fact]
    public void Fixed_root_inside_a_repo_stays_its_own_root()
    {
        var repo = Directory.CreateDirectory(_dir.File("repo")).FullName;
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        var buddy = Directory.CreateDirectory(Path.Combine(repo, "data", "buddy")).FullName;

        _resolver.Resolve(buddy).Should().Be(repo, "before it is registered");
        _resolver.AddFixedRoot(buddy);
        _resolver.Resolve(buddy).Should().Be(buddy);
        _resolver.Resolve(Path.Combine(buddy, "sub")).Should().Be(buddy);
        _resolver.Resolve(buddy + "2").Should().Be(repo, "a sibling with a longer name is not inside the fixed root");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Empty_input_passes_through(string? cwd) => _resolver.Resolve(cwd).Should().Be(cwd);
}
