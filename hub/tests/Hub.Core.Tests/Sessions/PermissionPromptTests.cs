using System.Text;
using Hub.Core.Hooks;
using Hub.Core.Sessions;

namespace Hub.Core.Tests.Sessions;

public class PermissionPromptTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 4, 9, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("rm -rf build", PermissionRisk.DeletesFiles)]
    [InlineData("Remove-Item -Recurse .\\dist", PermissionRisk.DeletesFiles)]
    [InlineData("cmd /c del /q out.txt", PermissionRisk.DeletesFiles)]
    [InlineData("git clean -fdx", PermissionRisk.DeletesFiles)]
    [InlineData("dotnet ef database update --project Payments.Gateway", PermissionRisk.WritesDatabase)]
    [InlineData("psql -c \"select 1\"", PermissionRisk.WritesDatabase)]
    [InlineData("sqlcmd -S . -Q \"DELETE FROM Orders\"", PermissionRisk.WritesDatabase)]
    [InlineData("npx prisma migrate deploy", PermissionRisk.WritesDatabase)]
    [InlineData("curl -s https://example.com", PermissionRisk.Network)]
    [InlineData("Invoke-WebRequest https://example.com -OutFile x", PermissionRisk.Network)]
    [InlineData("scp a.txt host:/tmp", PermissionRisk.Network)]
    [InlineData("npm install left-pad", PermissionRisk.InstallsPackages)]
    [InlineData("pip install requests", PermissionRisk.InstallsPackages)]
    [InlineData("dotnet add package Dapper", PermissionRisk.InstallsPackages)]
    [InlineData("winget install Git.Git", PermissionRisk.InstallsPackages)]
    [InlineData("git push origin main", PermissionRisk.GitPush)]
    [InlineData("npm test", PermissionRisk.Other)]
    [InlineData("dotnet format", PermissionRisk.Other)]
    [InlineData("echo modeled", PermissionRisk.Other)]
    public void Classifier_labels_commands(string command, PermissionRisk expected)
    {
        PermissionRiskClassifier.Classify(command).Should().Be(expected);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void Classifier_has_no_opinion_without_a_command(string? command)
    {
        PermissionRiskClassifier.Classify(command).Should().BeNull();
    }

    [Fact]
    public void Permission_request_sets_the_prompt_and_leaving_the_state_clears_it()
    {
        var start = Codex("UserPromptSubmit", "{}", T0);
        var (s, _) = SessionStateMachine.Apply(null, start);

        (s, var change) = SessionStateMachine.Apply(s, Codex("PermissionRequest", """{"tool_name":"Bash","tool_input":{"command":"rm -rf build"}}""", T0.AddSeconds(5)));

        change!.To.Should().Be(SessionState.WaitingPermission);
        s.PendingPermission.Should().Be(new PermissionPrompt("Bash", "rm -rf build", null, PermissionRisk.DeletesFiles, T0.AddSeconds(5)));

        (s, change) = SessionStateMachine.Apply(s, Codex("PostToolUse", """{"tool_name":"Bash"}""", T0.AddSeconds(9)));

        change!.To.Should().Be(SessionState.Working);
        s.PendingPermission.Should().BeNull();
    }

    [Fact]
    public void Edit_tools_carry_the_file_path_and_no_risk()
    {
        var (s, _) = SessionStateMachine.Apply(null, Claude("PermissionRequest", """{"tool_name":"Write","tool_input":{"file_path":"C:\\src\\a.cs","content":"x"}}""", T0));

        s.PendingPermission!.Path.Should().Be(@"C:\src\a.cs");
        s.PendingPermission.Command.Should().BeNull();
        s.PendingPermission.Risk.Should().BeNull();
    }

    [Fact]
    public void Claude_permission_notification_without_a_request_still_records_the_tool()
    {
        var (s, _) = SessionStateMachine.Apply(null, Claude("PreToolUse", """{"tool_name":"Bash","tool_input":{"command":"ls"}}""", T0));

        (s, _) = SessionStateMachine.Apply(s, Claude("Notification", """{"notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"}""", T0.AddSeconds(2)));

        s.State.Should().Be(SessionState.WaitingPermission);
        s.PendingPermission.Should().Be(new PermissionPrompt("Bash", null, null, null, T0.AddSeconds(2)));
    }

    [Fact]
    public void A_stop_clears_the_prompt()
    {
        var (s, _) = SessionStateMachine.Apply(null, Codex("PermissionRequest", """{"tool_name":"Bash","tool_input":{"command":"git push"}}""", T0));
        s.PendingPermission!.Risk.Should().Be(PermissionRisk.GitPush);

        (s, _) = SessionStateMachine.Apply(s, Codex("Stop", "{}", T0.AddSeconds(1)));

        s.PendingPermission.Should().BeNull();
    }

    private static HookEvent Codex(string name, string extra, DateTimeOffset at) => Event("codex", name, extra, at);

    private static HookEvent Claude(string name, string extra, DateTimeOffset at) => Event("claude-code", name, extra, at);

    private static HookEvent Event(string agent, string name, string extra, DateTimeOffset at)
    {
        var payload = extra.Trim() == "{}" ? """{"session_id":"s1","cwd":"C:\\src"}""" : """{"session_id":"s1","cwd":"C:\\src",""" + extra.Trim()[1..];
        var json = $$"""{"agent":"{{agent}}","event":"{{name}}","receivedAt":"{{at.UtcDateTime:yyyy-MM-ddTHH:mm:ss.fffZ}}","payload":{{payload}}}""";
        var e = HookEventParser.Parse(Encoding.UTF8.GetBytes(json), TestAdapters.BuiltIn, out var error);
        error.Should().Be(HookParseError.None);
        return e!;
    }
}
