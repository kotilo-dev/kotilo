using Hub.Core;
using Hub.Core.Adapters;

namespace Hub.Core.Tests;

public sealed class BrandTests
{
    private const string Renamed = """
        {
          "name": "New Name", "slug": "new-name", "identifier": "dev.newname.app", "publisher": "New Co",
          "exePrefix": "newname", "website": "https://new.example", "supportEmail": "", "updateEndpoint": "",
          "legacy": { "slugs": ["old-name"], "hookMarkers": ["oldname-hook", "odd-marker"], "credentialPrefixes": ["old-name/ai/"] }
        }
        """;

    [Fact]
    public void Embedded_brand_is_loaded_and_consistent()
    {
        var brand = Brand.Current;
        brand.Name.Should().NotBeEmpty();
        brand.Slug.Should().MatchRegex("^[a-z0-9-]+$");
        brand.ExePrefix.Should().MatchRegex("^[a-z0-9-]+$");
        brand.HookMarker.Should().Be(brand.ExePrefix + "-hook");
        brand.OwnedHookMarkers[0].Should().Be(brand.HookMarker);
        HookCommand.ExeMarker.Should().Be(brand.HookMarker);
    }

    [Fact]
    public void Parse_reads_every_field_and_derives_names()
    {
        var brand = Brand.Parse(Renamed);

        brand.Name.Should().Be("New Name");
        brand.Identifier.Should().Be("dev.newname.app");
        brand.Website.Should().Be("https://new.example");
        brand.HookMarker.Should().Be("newname-hook");
        brand.CredentialPrefix.Should().Be("new-name/ai/");
        brand.OwnedHookMarkers.Should().Equal("newname-hook", "oldname-hook", "odd-marker");
        brand.LegacyExePrefixes.Should().Equal("oldname");
        brand.LegacySlugs.Should().Equal("old-name");
        brand.LegacyCredentialPrefixes.Should().Equal("old-name/ai/");
    }

    [Fact]
    public void Missing_legacy_block_means_no_legacy_names_and_a_missing_name_is_an_error()
    {
        var brand = Brand.Parse("""{ "name": "n", "slug": "s", "identifier": "i", "publisher": "p", "exePrefix": "e" }""");
        brand.LegacySlugs.Should().BeEmpty();
        brand.OwnedHookMarkers.Should().Equal("e-hook");
        brand.SupportEmail.Should().BeEmpty();

        FluentActions.Invoking(() => Brand.Parse("""{ "name": "", "slug": "s", "identifier": "i", "publisher": "p", "exePrefix": "e" }"""))
            .Should().Throw<FormatException>();
    }

    [Fact]
    public void Unknown_fields_are_ignored()
    {
        var brand = Brand.Parse("""
            { "name": "n", "slug": "s", "identifier": "i", "publisher": "p", "exePrefix": "e",
              "repository": "https://example.invalid/repo", "future": { "nested": [1, 2] }, "legacy": { "slugs": ["o"], "extra": true } }
            """);

        brand.Name.Should().Be("n");
        brand.LegacySlugs.Should().Equal("o");
    }

    [Fact]
    public void Legacy_markers_make_an_entry_ours()
    {
        var markers = Brand.Parse(Renamed).OwnedHookMarkers;

        HookCommand.IsOwn(@"C:\new\newname-hook.exe --agent x --event y", markers).Should().BeTrue();
        HookCommand.IsOwn(@"C:\old\OLDNAME-HOOK.exe --agent x --event y", markers).Should().BeTrue();
        HookCommand.IsOwn(@"C:\tools\guard.exe --event y", markers).Should().BeFalse();
        HookCommand.IsOwn(null, markers).Should().BeFalse();
    }
}
