import { describe, expect, it } from "vitest";
import {
  classifyImageSrc,
  classifyLink,
  createHeadingIdFactory,
  flattenText,
  hrefForLink,
  resolveWorkspacePath,
  slugify,
  splitPathFragment,
} from "./mdLinks";

describe("resolveWorkspacePath", () => {
  it("resolves './' against the current file's directory", () => {
    expect(resolveWorkspacePath("docs", "./img.png")).toBe("docs/img.png");
    expect(resolveWorkspacePath("", "./img.png")).toBe("img.png");
  });

  it("resolves '../' one level up", () => {
    expect(resolveWorkspacePath("docs/guide", "../img.png")).toBe("docs/img.png");
    expect(resolveWorkspacePath("docs", "../img.png")).toBe("img.png");
  });

  it("disables (returns null) a path that escapes the workspace root", () => {
    expect(resolveWorkspacePath("docs", "../../../img.png")).toBeNull();
    expect(resolveWorkspacePath("", "../img.png")).toBeNull();
    expect(resolveWorkspacePath("a/b", "../../../etc/passwd")).toBeNull();
  });

  it("treats a leading '/' as workspace-root-relative", () => {
    expect(resolveWorkspacePath("docs/guide", "/assets/img.png")).toBe("assets/img.png");
  });

  it("normalizes Windows backslashes", () => {
    expect(resolveWorkspacePath("docs", "sub\\img.png")).toBe("docs/sub/img.png");
    expect(resolveWorkspacePath("docs", "..\\img.png")).toBe("img.png");
  });

  it("decodes percent-encoded segments and keeps literal spaces", () => {
    expect(resolveWorkspacePath("", "my%20notes/a%C4%9F.md")).toBe("my notes/ağ.md");
    expect(resolveWorkspacePath("", "my notes/a.md")).toBe("my notes/a.md");
  });

  it("collapses redundant './' segments", () => {
    expect(resolveWorkspacePath("docs", "./sub/./img.png")).toBe("docs/sub/img.png");
  });
});

describe("splitPathFragment", () => {
  it("strips a trailing query string", () => {
    expect(splitPathFragment("a/b.md?x=1")).toEqual({ path: "a/b.md", hash: "" });
  });

  it("strips a trailing hash and keeps it separately", () => {
    expect(splitPathFragment("a/b.md#section")).toEqual({ path: "a/b.md", hash: "section" });
  });

  it("strips both query and hash for file links", () => {
    expect(splitPathFragment("a/b.md?x=1&y=2#section")).toEqual({ path: "a/b.md", hash: "section" });
  });

  it("returns the whole string as path when there is no query/hash", () => {
    expect(splitPathFragment("a/b.md")).toEqual({ path: "a/b.md", hash: "" });
  });
});

describe("classifyImageSrc", () => {
  it("resolves a relative image against the markdown file's directory", () => {
    expect(classifyImageSrc("docs/readme.md", "./img.png")).toEqual({ kind: "workspace", rel: "docs/img.png" });
    expect(classifyImageSrc("docs/readme.md", "../assets/img.png")).toEqual({ kind: "workspace", rel: "assets/img.png" });
  });

  it("classifies http(s) image sources as 'remote' (finding #12: CSP blocks a real <img> fetch)", () => {
    expect(classifyImageSrc("docs/readme.md", "https://example.com/a.png")).toEqual({
      kind: "remote",
      src: "https://example.com/a.png",
    });
    expect(classifyImageSrc("readme.md", "http://example.com/a.png")).toEqual({
      kind: "remote",
      src: "http://example.com/a.png",
    });
  });

  it("classifies data: image sources as 'data' (CSP img-src allows data:, renders as a real <img>)", () => {
    const src = "data:image/png;base64,AAAA";
    expect(classifyImageSrc("readme.md", src)).toEqual({ kind: "data", src });
  });

  it("disables an image that escapes the workspace root", () => {
    expect(classifyImageSrc("readme.md", "../outside.png")).toEqual({ kind: "disabled" });
    expect(classifyImageSrc("docs/readme.md", "../../../outside.png")).toEqual({ kind: "disabled" });
  });

  it("disables unsupported schemes (e.g. mailto:, file:)", () => {
    expect(classifyImageSrc("readme.md", "file:///etc/passwd")).toEqual({ kind: "disabled" });
  });

  it("handles percent-encoded and spaced file names", () => {
    expect(classifyImageSrc("docs/readme.md", "my%20assets/a.png")).toEqual({ kind: "workspace", rel: "docs/my assets/a.png" });
    expect(classifyImageSrc("docs/readme.md", "my assets/a.png")).toEqual({ kind: "workspace", rel: "docs/my assets/a.png" });
  });

  it("strips query/hash before resolving the image path", () => {
    expect(classifyImageSrc("docs/readme.md", "img.png?raw=1")).toEqual({ kind: "workspace", rel: "docs/img.png" });
  });
});

describe("classifyLink", () => {
  it("resolves a relative in-workspace link", () => {
    expect(classifyLink("docs/readme.md", "./other.md")).toEqual({ kind: "file", rel: "docs/other.md", hash: "" });
    expect(classifyLink("docs/readme.md", "../top.md")).toEqual({ kind: "file", rel: "top.md", hash: "" });
  });

  it("classifies '#anchor' as an in-page anchor", () => {
    expect(classifyLink("docs/readme.md", "#section-one")).toEqual({ kind: "anchor", id: "section-one" });
  });

  it("classifies http(s) links as external", () => {
    expect(classifyLink("readme.md", "https://example.com")).toEqual({ kind: "external", href: "https://example.com" });
  });

  it("disables a link escaping the workspace root", () => {
    expect(classifyLink("a/b/readme.md", "../../../secret.md")).toEqual({ kind: "disabled" });
  });

  it("disables unsupported schemes like mailto:", () => {
    expect(classifyLink("readme.md", "mailto:someone@example.com")).toEqual({ kind: "disabled" });
  });

  it("disables javascript:, vbscript: and data:text/html link targets (finding #18)", () => {
    expect(classifyLink("readme.md", "javascript:alert(1)")).toEqual({ kind: "disabled" });
    expect(classifyLink("readme.md", "vbscript:msgbox(1)")).toEqual({ kind: "disabled" });
    expect(classifyLink("readme.md", "data:text/html,<script>alert(1)</script>")).toEqual({ kind: "disabled" });
  });

  it("strips a query/hash suffix off a file link but keeps resolving the path (hash is kept separately — faz7-spec §12.7)", () => {
    expect(classifyLink("docs/readme.md", "other.md?x=1#sec")).toEqual({ kind: "file", rel: "docs/other.md", hash: "sec" });
  });

  it("windows backslashes in a relative link are normalized", () => {
    expect(classifyLink("docs\\readme.md".replace(/\\/g, "/"), "sub\\other.md")).toEqual({
      kind: "file",
      rel: "docs/sub/other.md",
      hash: "",
    });
  });

  it("treats a bare '#'-less query-only target as disabled (no path, no hash)", () => {
    expect(classifyLink("readme.md", "?x=1")).toEqual({ kind: "disabled" });
  });
});

describe("hrefForLink (finding #13/#18)", () => {
  it("never exposes the real destination as href — MarkdownView emits '#' for external/file/disabled, never a raw http(s) href", () => {
    expect(hrefForLink({ kind: "external", href: "https://evil.example.com" })).toBe("#");
    expect(hrefForLink({ kind: "external", href: "https://evil.example.com" })).not.toContain("http");
    expect(hrefForLink({ kind: "file", rel: "a.md", hash: "" })).toBe("#");
    expect(hrefForLink({ kind: "disabled" })).toBe("#");
  });

  it("keeps a page-local anchor href for in-page navigation", () => {
    expect(hrefForLink({ kind: "anchor", id: "getting-started" })).toBe("#getting-started");
  });
});

describe("slugify (faz7-spec §12.5: GitHub-compatible, binding exact algorithm)", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
  });

  it("strips punctuation", () => {
    expect(slugify("What's New?!")).toBe("whats-new");
  });

  it("keeps unicode letters (Turkish)", () => {
    expect(slugify("Kurulum ve Başlangıç")).toBe("kurulum-ve-başlangıç");
  });

  it("keeps underscores and does NOT collapse repeated whitespace (unlike the pre-§12 version)", () => {
    expect(slugify("a   b\tc")).toBe("a---b-c");
    expect(slugify("___chkstk_ms")).toBe("___chkstk_ms");
  });

  it("the `___chkstk_ms` build-error heading", () => {
    expect(slugify("Build fails with unresolved external symbol ___chkstk_ms")).toBe(
      "build-fails-with-unresolved-external-symbol-___chkstk_ms",
    );
  });

  it("an em-dash flanked by spaces is stripped, leaving a double dash (GitHub's own behaviour)", () => {
    expect(slugify("Hook errors — use Check status")).toBe("hook-errors--use-check-status");
  });

  it('the "The JSON object…" → Save diagnostic copy first heading', () => {
    expect(slugify('"The JSON object in the request body is malformed" → Save diagnostic copy first')).toBe(
      "the-json-object-in-the-request-body-is-malformed--save-diagnostic-copy-first",
    );
  });

  it("a `.cargo/config.toml`-style path: dots and slashes are stripped, no whitespace to replace", () => {
    expect(slugify(".cargo/config.toml")).toBe("cargoconfigtoml");
  });
});

describe("flattenText (faz7-spec §12.14, extracted from MarkdownView)", () => {
  it("flattens plain strings and numbers", () => {
    expect(flattenText("hello")).toBe("hello");
    expect(flattenText(42)).toBe("42");
  });

  it("flattens arrays and nested element-like children", () => {
    expect(flattenText(["a", "b"])).toBe("ab");
    expect(flattenText({ props: { children: ["x", { props: { children: "y" } }] } } as never)).toBe("xy");
  });

  it("ignores null/undefined/boolean", () => {
    expect(flattenText(null)).toBe("");
    expect(flattenText(undefined)).toBe("");
    expect(flattenText(true)).toBe("");
  });
});

describe("createHeadingIdFactory (faz7-spec §12.14)", () => {
  it("dedupes repeated headings within one factory instance with -1/-2 suffixes", () => {
    const makeId = createHeadingIdFactory();
    expect(makeId("Overview")).toBe("overview");
    expect(makeId("Overview")).toBe("overview-1");
    expect(makeId("Overview")).toBe("overview-2");
  });

  it("a fresh factory instance starts counting over (per-render/per-doc scoping)", () => {
    const first = createHeadingIdFactory();
    const second = createHeadingIdFactory();
    expect(first("Overview")).toBe("overview");
    expect(second("Overview")).toBe("overview");
  });
});
