import { describe, expect, it } from "vitest";
import { getRenderer } from "./getRenderer";

describe("getRenderer", () => {
  it("maps markdown extensions", () => {
    expect(getRenderer("README.md")).toBe("markdown");
    expect(getRenderer("notes/a.markdown")).toBe("markdown");
  });

  it("maps html extensions", () => {
    expect(getRenderer("index.html")).toBe("html");
    expect(getRenderer("index.htm")).toBe("html");
  });

  it("maps pdf", () => {
    expect(getRenderer("report.pdf")).toBe("pdf");
  });

  it("maps svg to its own kind (not plain image)", () => {
    expect(getRenderer("icon.svg")).toBe("svg");
  });

  it("maps raster image extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]) {
      expect(getRenderer(`a.${ext}`)).toBe("image");
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(getRenderer("REPORT.PDF")).toBe("pdf");
    expect(getRenderer("Icon.SVG")).toBe("svg");
  });

  it("maps known code/text extensions to text", () => {
    for (const ext of ["json", "xml", "txt", "yaml", "yml", "ini", "csv", "log", "js", "ts", "css", "sql", "ps1", "bat"]) {
      expect(getRenderer(`file.${ext}`)).toBe("text");
    }
  });

  it("falls back to text for unknown extensions (fs_sniff removed, §5.3)", () => {
    expect(getRenderer("weird.xyz123")).toBe("text");
    expect(getRenderer("no-extension-at-all")).toBe("text");
  });

  it("treats dotfiles without a further extension as text, not as an extension match", () => {
    expect(getRenderer(".gitignore")).toBe("text");
    expect(getRenderer("dir/.env")).toBe("text");
  });

  it("looks only at the final path segment's extension", () => {
    expect(getRenderer("a/b.md/c.txt")).toBe("text");
    expect(getRenderer("a.md/README")).toBe("text");
  });
});
