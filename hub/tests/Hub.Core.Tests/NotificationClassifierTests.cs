using Hub.Core.Sessions;

namespace Hub.Core.Tests;

public class NotificationClassifierTests
{
    [Theory]
    [InlineData("permission_prompt", NotificationKind.Permission)]
    [InlineData("PERMISSION_PROMPT", NotificationKind.Permission)]
    [InlineData("idle_prompt", NotificationKind.Input)]
    [InlineData("elicitation_dialog", NotificationKind.Input)]
    [InlineData("elicitation_url_dialog", NotificationKind.Input)]
    [InlineData("agent_needs_input", NotificationKind.Input)]
    [InlineData("auth_success", NotificationKind.Other)]
    [InlineData("elicitation_complete", NotificationKind.Other)]
    [InlineData("quota_auto_resume_fired", NotificationKind.Other)]
    public void Type_decides_when_present(string type, NotificationKind expected) =>
        NotificationClassifier.Classify(type, "Claude needs your permission to use Bash").Should().Be(
            expected == NotificationKind.Other ? NotificationKind.Other : expected);

    [Theory]
    [InlineData("Claude needs your permission to use Bash", NotificationKind.Permission)]
    [InlineData("Claude needs your permission to use mcp__github__create_issue", NotificationKind.Permission)]
    [InlineData("Claude is waiting for your input", NotificationKind.Input)]
    [InlineData("Claude Code is waiting for your input", NotificationKind.Input)]
    [InlineData("Task finished", NotificationKind.Other)]
    [InlineData("", NotificationKind.Other)]
    [InlineData(null, NotificationKind.Other)]
    public void Message_keywords_are_the_fallback(string? message, NotificationKind expected) =>
        NotificationClassifier.Classify(null, message).Should().Be(expected);
}
