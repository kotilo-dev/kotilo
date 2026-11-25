import { describe, expect, it } from "vitest";
import { applyUiFont, uiFontStack } from "./applyTheme";

describe("uiFontStack", () => {
  it("is null for empty input", () => {
    expect(uiFontStack("")).toBeNull();
    expect(uiFontStack("   ")).toBeNull();
    expect(uiFontStack(undefined)).toBeNull();
  });
  it("quotes the family and keeps the fallbacks", () => {
    expect(uiFontStack("Inter")).toBe('"Inter", "Geist", "Segoe UI", system-ui, sans-serif');
  });
  it("quotes each name of a list and keeps generic families bare", () => {
    expect(uiFontStack("Inter, Segoe UI,, system-ui")).toBe('"Inter", "Segoe UI", system-ui, "Geist", "Segoe UI", system-ui, sans-serif');
  });
  it("strips characters that could break the declaration", () => {
    const v = uiFontStack(`Evil";} body{x:y\ 'a'`);
    expect(v).toBe('"Evil bodyx:y a", "Geist", "Segoe UI", system-ui, sans-serif');
  });
  it("sets and removes the CSS variable", () => {
    const root = document.createElement("div");
    applyUiFont("Inter", root);
    expect(root.style.getPropertyValue("--font-ui")).toContain('"Inter"');
    applyUiFont("", root);
    expect(root.style.getPropertyValue("--font-ui")).toBe("");
  });
});
