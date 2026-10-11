import { describe, expect, it } from "vitest";
import { filterNotices, loadThirdPartyNotices } from "./licenses";

const TEXT = "SUMMARY\r\n  tokio   1.0  MIT\r\n  ring    0.17 ISC AND OpenSSL\n  Serde   1.0  MIT OR Apache-2.0";

describe("filterNotices", () => {
  it("returns the whole text for an empty or blank query", () => {
    expect(filterNotices(TEXT, "")).toEqual({ text: TEXT, matches: null });
    expect(filterNotices(TEXT, "   ")).toEqual({ text: TEXT, matches: null });
  });

  it("keeps the matching lines, case-insensitive", () => {
    expect(filterNotices(TEXT, "serde")).toEqual({ text: "  Serde   1.0  MIT OR Apache-2.0", matches: 1 });
    expect(filterNotices(TEXT, "mit").matches).toBe(2);
    expect(filterNotices(TEXT, "gpl")).toEqual({ text: "", matches: 0 });
  });
});

describe("loadThirdPartyNotices", () => {
  it("loads the generated repo-root notices through the Vite virtual module", async () => {
    const text = await loadThirdPartyNotices();
    expect(text.startsWith("THIRD-PARTY SOFTWARE NOTICES")).toBe(true);
    expect(await loadThirdPartyNotices()).toBe(text);
  });
});
