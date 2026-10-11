import { describe, expect, it } from "vitest";
import { adfsUrl } from "./ipc";

describe("adfsUrl", () => {
  it("builds a plain path with the workspace id as the first segment", () => {
    expect(adfsUrl("ws1", "docs/readme.md")).toBe("http://adfs.localhost/ws1/docs/readme.md");
  });

  it("returns just the workspace id for the root ('')", () => {
    expect(adfsUrl("ws1", "")).toBe("http://adfs.localhost/ws1/");
  });

  it("percent-encodes Turkish characters per segment", () => {
    expect(adfsUrl("ws1", "İşler/dosyağüşıöç.txt")).toBe(
      `http://adfs.localhost/ws1/${encodeURIComponent("İşler")}/${encodeURIComponent("dosyağüşıöç.txt")}`,
    );
  });

  it("percent-encodes '#', '?' and '%' so they can't reinterpret the URL", () => {
    const rel = "a#b?c%d.txt";
    const url = adfsUrl("ws1", rel);
    expect(url).toBe(`http://adfs.localhost/ws1/${encodeURIComponent(rel)}`);
    expect(url).not.toContain("#");
    expect(url).not.toContain("?");
    // '%' itself becomes %25, so the only remaining '%' chars are part of escape sequences.
    expect(url.match(/%(?![0-9A-Fa-f]{2})/)).toBeNull();
  });

  it("keeps '/' as the segment separator, encoding each segment independently", () => {
    const url = adfsUrl("ws1", "a/b/c.txt");
    expect(url).toBe("http://adfs.localhost/ws1/a/b/c.txt");
    expect(url.split("/")).toHaveLength(7); // "http:", "", "adfs.localhost", "ws1", "a", "b", "c.txt"
  });

  it("percent-encodes the workspace id too", () => {
    expect(adfsUrl("ws with space", "f.txt")).toBe(`http://adfs.localhost/${encodeURIComponent("ws with space")}/f.txt`);
  });
});
