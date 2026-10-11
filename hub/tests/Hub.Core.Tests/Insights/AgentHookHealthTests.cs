using Hub.Core.Insights;

namespace Hub.Core.Tests.Insights;

public class AgentHookHealthTests
{
    private static readonly DateTimeOffset Now = TestData.T0;

    [Fact]
    public void Each_broken_agent_integration_is_its_own_issue_with_the_agent_id()
    {
        var issues = HealthEvaluator.Evaluate(new HealthInputs(Now)
        {
            AgentHooks = [new AgentHookSetup("codex", HookSetup.WrongPath), new AgentHookSetup("gemini", HookSetup.Ok)],
        });

        var issue = issues.Should().ContainSingle().Subject;
        (issue.Check, issue.Severity).Should().Be((HealthCheck.HooksBroken, HealthSeverity.Error));
        issue.Detail.Should().Equal("WrongPath", "codex");
    }

    [Fact]
    public void Another_agent_does_not_mask_the_claude_silence_check()
    {
        var issues = HealthEvaluator.Evaluate(new HealthInputs(Now)
        {
            LastTranscriptWriteAt = Now.AddMinutes(-1),
            AgentHooks = [new AgentHookSetup("codex", HookSetup.WrongPath)],
        });

        issues.Select(i => i.Check).Should().BeEquivalentTo([HealthCheck.HooksBroken, HealthCheck.HooksSilent]);
    }
}
