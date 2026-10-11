using Hub.Service.Hosting;

namespace Hub.Service.Tests;

public sealed class ParentWatchTests
{
    [Theory]
    [InlineData(new[] { "--parent-pid", "1234" }, 1234)]
    [InlineData(new[] { "--other", "x", "--parent-pid", "7" }, 7)]
    [InlineData(new[] { "--parent-pid" }, null)]
    [InlineData(new[] { "--parent-pid", "-3" }, null)]
    [InlineData(new[] { "--parent-pid", "abc" }, null)]
    [InlineData(new string[0], null)]
    public void Parses_the_parent_pid(string[] args, int? expected) =>
        ParentWatch.ParsePid(args).Should().Be(expected);

    [Fact]
    public async Task Returns_at_once_when_the_parent_is_already_gone()
    {
        var wait = ParentWatch.WaitForExitAsync(() => false, TimeProvider.System, CancellationToken.None);

        (await Task.WhenAny(wait, Task.Delay(TimeSpan.FromSeconds(5)))).Should().BeSameAs(wait);
    }

    [Fact]
    public void Our_own_process_is_alive_and_a_bogus_pid_is_not()
    {
        ParentWatch.ProcessProbe(Environment.ProcessId)().Should().BeTrue();
        ParentWatch.ProcessProbe(int.MaxValue)().Should().BeFalse();
    }
}
