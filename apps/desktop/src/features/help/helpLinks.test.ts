import { describe, expect, it } from "vitest";
import { classifyHelpLink } from "./helpLinks";

describe("classifyHelpLink (faz7-spec §12.7)", () => {
  it("classifies a bare '#anchor' as an in-doc anchor", () => {
    expect(classifyHelpLink("user-guide.md", "#workspaces")).toEqual({ kind: "anchor", id: "workspaces" });
  });

  it("classifies a link to another bundled doc as 'doc', with the hash kept for scrolling", () => {
    expect(classifyHelpLink("troubleshooting.md", "user-guide.md#uninstalling")).toEqual({
      kind: "doc",
      doc: "user-guide.md",
      hash: "uninstalling",
    });
  });

  it("a same-doc link with no hash still resolves to 'doc' (caller scrolls to top)", () => {
    expect(classifyHelpLink("keybindings.md", "user-guide.md")).toEqual({ kind: "doc", doc: "user-guide.md", hash: "" });
  });

  it("classifies http(s) links as external", () => {
    expect(classifyHelpLink("troubleshooting.md", "https://example.com")).toEqual({
      kind: "external",
      href: "https://example.com",
    });
  });

  it("a link to a non-bundled doc (e.g. development.md) is unavailable, not a broken doc switch", () => {
    expect(classifyHelpLink("troubleshooting.md", "development.md#debugging-tip")).toEqual({ kind: "unavailable" });
  });

  it("mailto:/javascript: and other unsupported schemes are unavailable", () => {
    expect(classifyHelpLink("user-guide.md", "mailto:someone@example.com")).toEqual({ kind: "unavailable" });
    expect(classifyHelpLink("user-guide.md", "javascript:alert(1)")).toEqual({ kind: "unavailable" });
  });
});
