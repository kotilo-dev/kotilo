using System.Diagnostics;
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

    [Fact]
    public void Linked_worktree_maps_to_the_main_repository()
    {
        var repo = MainRepo("repo");
        var wt = FakeWorktree(repo, Path.Combine(repo, ".kotilo", "worktrees", "fix-login"), "fix-login", "../..", "ref: refs/heads/kotilo/fix-login");

        _resolver.Resolve(Path.Combine(wt, "src")).Should().Be(repo);
        _resolver.ResolveLocation(Path.Combine(wt, "src")).Should().Be(new ProjectLocation(repo, wt));
        _resolver.ResolveLocation(wt).Should().Be(new ProjectLocation(repo, wt));
        ProjectRootResolver.WorktreeBranch(wt).Should().Be("kotilo/fix-login");
        _resolver.ResolveLocation(repo).Should().Be(new ProjectLocation(repo, null), "the main checkout is not a worktree");
    }

    [Fact]
    public void Worktree_outside_the_repo_with_an_absolute_commondir_and_forward_slashes()
    {
        var repo = MainRepo("repo");
        var common = Path.Combine(repo, ".git").Replace('\\', '/');
        var wt = FakeWorktree(repo, _dir.File("repo-feature"), "repo-feature", common, "ref: refs/heads/feature/x", forwardSlashes: true);

        _resolver.ResolveLocation(Path.Combine(wt, "a", "b")).Should().Be(new ProjectLocation(repo, wt));
        ProjectRootResolver.WorktreeBranch(wt).Should().Be("feature/x");
    }

    [Fact]
    public void Detached_worktree_has_no_branch()
    {
        var repo = MainRepo("repo");
        var wt = FakeWorktree(repo, Path.Combine(repo, ".claude", "worktrees", "w1"), "w1", "../..", "0123456789abcdef0123456789abcdef01234567");

        _resolver.ResolveLocation(wt).Should().Be(new ProjectLocation(repo, wt));
        ProjectRootResolver.WorktreeBranch(wt).Should().BeNull();
        ProjectRootResolver.WorktreeBranch(repo).Should().BeNull("not a worktree");
    }

    [Fact]
    public void Submodule_keeps_its_own_root()
    {
        var repo = MainRepo("repo");
        var moduleGitDir = Directory.CreateDirectory(Path.Combine(repo, ".git", "modules", "lib")).FullName;
        File.WriteAllText(Path.Combine(moduleGitDir, "HEAD"), "ref: refs/heads/main\n");
        var lib = Directory.CreateDirectory(Path.Combine(repo, "lib")).FullName;
        File.WriteAllText(Path.Combine(lib, ".git"), "gitdir: ../.git/modules/lib\n");

        _resolver.ResolveLocation(Path.Combine(lib, "src")).Should().Be(new ProjectLocation(lib, null));
    }

    [Fact]
    public void Worktree_of_a_bare_repository_keeps_its_own_root()
    {
        var bare = Directory.CreateDirectory(_dir.File("repo.git")).FullName;
        var wt = FakeWorktree(bare, _dir.File("bare-wt"), "bare-wt", "../..", "ref: refs/heads/main", commonIsBare: true);

        _resolver.ResolveLocation(wt).Should().Be(new ProjectLocation(wt, null));
    }

    [Fact]
    public void Malformed_or_dangling_git_file_keeps_today_behavior()
    {
        var wt = Directory.CreateDirectory(_dir.File("dangling")).FullName;
        File.WriteAllText(Path.Combine(wt, ".git"), "gitdir: does/not/exist");
        var junk = Directory.CreateDirectory(_dir.File("junk")).FullName;
        File.WriteAllText(Path.Combine(junk, ".git"), "not a git file");

        _resolver.ResolveLocation(wt).Should().Be(new ProjectLocation(wt, null));
        _resolver.ResolveLocation(junk).Should().Be(new ProjectLocation(junk, null));
        ProjectRootResolver.WorktreeBranch(wt).Should().BeNull();
    }

    [Fact]
    public void Real_git_worktree_maps_to_the_main_repository()
    {
        if (FindGit() is not { } git)
        {
            return; // git is optional (spec §18.3)
        }

        var repo = Directory.CreateDirectory(_dir.File("real")).FullName;
        Git(git, repo, "init", "-q", "-b", "main");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "a");
        Git(git, repo, "add", ".");
        Git(git, repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
        var wt = Path.Combine(repo, ".kotilo", "worktrees", "fix");
        Git(git, repo, "worktree", "add", "-q", "-b", "kotilo/fix", wt);
        var sibling = _dir.File("real-sibling");
        Git(git, repo, "worktree", "add", "-q", "--detach", sibling);

        _resolver.ResolveLocation(wt).Should().Be(new ProjectLocation(repo, wt));
        ProjectRootResolver.WorktreeBranch(wt).Should().Be("kotilo/fix");
        _resolver.ResolveLocation(sibling).Should().Be(new ProjectLocation(repo, sibling));
        ProjectRootResolver.WorktreeBranch(sibling).Should().BeNull("detached");
    }

    [Fact]
    public void Worktree_root_keeps_the_cwd_spelling_when_git_records_a_physical_path()
    {
        // Git writes physical paths (macOS /var → /private/var); the agent's cwd uses the other spelling of the same folder.
        // Two trees stand in for the two spellings: "physical" holds the git data, "seen" is where the cwd lives.
        var physicalRepo = MainRepo(Path.Combine("physical", "repo"));
        var physicalWt = Path.Combine(physicalRepo, ".kotilo", "worktrees", "fix");
        var gitDir = Directory.CreateDirectory(Path.Combine(physicalRepo, ".git", "worktrees", "fix")).FullName;
        File.WriteAllText(Path.Combine(gitDir, "HEAD"), "ref: refs/heads/kotilo/fix\n");
        File.WriteAllText(Path.Combine(gitDir, "commondir"), "../..\n");
        File.WriteAllText(Path.Combine(gitDir, "gitdir"), Path.Combine(physicalWt, ".git") + "\n");
        var seenRepo = _dir.File(Path.Combine("seen", "repo"));
        var seenWt = Directory.CreateDirectory(Path.Combine(seenRepo, ".kotilo", "worktrees", "fix")).FullName;
        File.WriteAllText(Path.Combine(seenWt, ".git"), "gitdir: " + gitDir + "\n");

        _resolver.ResolveLocation(Path.Combine(seenWt, "src")).Should().Be(new ProjectLocation(seenRepo, seenWt));
    }

    private string MainRepo(string name)
    {
        var repo = Directory.CreateDirectory(_dir.File(name)).FullName;
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        return repo;
    }

    /// <summary>What <c>git worktree add</c> leaves behind: <c>&lt;common&gt;/worktrees/&lt;id&gt;</c> with HEAD + commondir, and a <c>.git</c> file.</summary>
    private static string FakeWorktree(
        string repo, string path, string id, string commondir, string head, bool forwardSlashes = false, bool commonIsBare = false)
    {
        var commonDir = commonIsBare ? repo : Path.Combine(repo, ".git");
        var gitDir = Directory.CreateDirectory(Path.Combine(commonDir, "worktrees", id)).FullName;
        File.WriteAllText(Path.Combine(gitDir, "HEAD"), head + "\n");
        File.WriteAllText(Path.Combine(gitDir, "commondir"), commondir + "\n");
        var wt = Directory.CreateDirectory(path).FullName;
        File.WriteAllText(Path.Combine(wt, ".git"), "gitdir: " + (forwardSlashes ? gitDir.Replace('\\', '/') : gitDir) + "\n");
        return wt;
    }

    private static string? FindGit()
    {
        var candidate = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "cmd", "git.exe");
        if (File.Exists(candidate))
        {
            return candidate;
        }

        var name = OperatingSystem.IsWindows() ? "git.exe" : "git";
        return (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(dir => Path.Combine(dir, name))
            .FirstOrDefault(File.Exists);
    }

    private static void Git(string git, string repo, params string[] args)
    {
        var psi = new ProcessStartInfo(git) { WorkingDirectory = repo, UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true };
        foreach (var a in args)
        {
            psi.ArgumentList.Add(a);
        }

        using var p = Process.Start(psi)!;
        var error = p.StandardError.ReadToEnd();
        p.WaitForExit();
        p.ExitCode.Should().Be(0, string.Join(' ', args) + ": " + error);
    }
}
