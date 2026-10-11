using Hub.Core.Projects;

namespace Hub.Core.Tests.Projects;

public class TodoParserTests
{
    [Theory]
    [InlineData("- [ ] a", TodoItemState.Open)]
    [InlineData("- [x] a", TodoItemState.Done)]
    [InlineData("- [X] a", TodoItemState.Done)]
    [InlineData("* [ ] a", TodoItemState.Open)]
    [InlineData("+ [x] a", TodoItemState.Done)]
    [InlineData("1. [ ] a", TodoItemState.Open)]
    [InlineData("12) [x] a", TodoItemState.Done)]
    [InlineData("    - [ ] a", TodoItemState.Open)]
    [InlineData("\t* [x] a", TodoItemState.Done)]
    [InlineData("- [~] a", TodoItemState.InProgress)]
    [InlineData("- [-] a", TodoItemState.InProgress)]
    [InlineData("-   [ ]   a  ", TodoItemState.Open)]
    public void Recognizes_checkbox_variants(string line, TodoItemState expected)
    {
        var item = TodoParser.Parse(line).Groups.Should().ContainSingle().Subject.Items.Should().ContainSingle().Subject;
        item.State.Should().Be(expected);
        item.Text.Should().Be("a");
        item.Line.Should().Be(1);
    }

    [Theory]
    [InlineData("[ ] no bullet")]
    [InlineData("-[ ] no space")]
    [InlineData("- [ ]no space after")]
    [InlineData("- [y] unknown mark")]
    [InlineData("- [] empty")]
    [InlineData("- plain bullet")]
    [InlineData("1 [ ] missing dot")]
    [InlineData("a. [ ] letter")]
    public void Ignores_non_checkboxes(string line) => TodoParser.Parse(line).Total.Should().Be(0);

    [Fact]
    public void Checkbox_without_text_counts()
    {
        var doc = TodoParser.Parse("- [x]");
        doc.Total.Should().Be(1);
        doc.Groups[0].Items[0].Text.Should().BeEmpty();
    }

    [Fact]
    public void Checkboxes_inside_code_fences_are_ignored()
    {
        const string md = """
            - [ ] real
            ```markdown
            - [ ] example
            - [x] example
            ```
            ~~~
            - [ ] tilde fence
            ~~~
            - [x] real too
            """;

        var doc = TodoParser.Parse(md);
        doc.Total.Should().Be(2);
        doc.Done.Should().Be(1);
    }

    [Fact]
    public void Unclosed_fence_hides_the_rest()
    {
        TodoParser.Parse("- [ ] a\n```\n- [ ] b").Total.Should().Be(1);
    }

    [Fact]
    public void Groups_by_nearest_heading_up_to_level_three()
    {
        const string md = """
            - [x] loose
            # Plan
            ## Faz 1
            ### 1.0 Hazırlık
            - [x] a
            - [ ] b
            #### detail
            - [ ] c
            ## Faz 2 ##
            - [~] d
            ## Empty
            text
            """;

        var doc = TodoParser.Parse(md);
        doc.Groups.Select(g => (g.Title, g.Level, g.Total)).Should().Equal(
            (null, 0, 1),
            ("1.0 Hazırlık", 3, 3),
            ("Faz 2", 2, 1));
        doc.Done.Should().Be(2);
        doc.InProgress.Should().Be(1);
        doc.Total.Should().Be(5);
    }

    [Fact]
    public void Hash_without_space_is_not_a_heading()
    {
        var doc = TodoParser.Parse("## A\n#hashtag\n- [ ] x");
        doc.Groups.Should().ContainSingle().Which.Title.Should().Be("A");
    }

    [Fact]
    public void Next_is_first_item_not_done_including_in_progress()
    {
        var doc = TodoParser.Parse("## A\n- [x] one\n## B\n- [~] two\n- [ ] three");
        var next = doc.Next!.Value;
        next.Item.Text.Should().Be("two");
        next.Group.Title.Should().Be("B");
    }

    [Fact]
    public void Next_is_null_when_all_done()
    {
        TodoParser.Parse("- [x] a\n- [X] b").Next.Should().BeNull();
    }

    [Fact]
    public void Nested_items_are_counted_and_crlf_is_handled()
    {
        var doc = TodoParser.Parse("- [x] parent\r\n  - [ ] child\r\n    1. [x] grandchild\r\n");
        doc.Total.Should().Be(3);
        doc.Done.Should().Be(2);
        doc.Groups[0].Items[1].Line.Should().Be(2);
    }

    [Fact]
    public void Empty_text_parses_to_empty_document() => TodoParser.Parse("").Groups.Should().BeEmpty();
}
