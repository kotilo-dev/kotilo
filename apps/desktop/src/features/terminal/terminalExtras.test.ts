import { describe, expect, it } from "vitest";
import { OSC52_MAX_BYTES, parseOsc52, recentOutputText, RESET_MODES_SEQUENCE } from "./terminalExtras";

function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

describe("parseOsc52", () => {
  it("decodes a clipboard write, UTF-8 included", () => {
    expect(parseOsc52(`c;${b64("hello")}`)).toBe("hello");
    expect(parseOsc52(`;${b64("çalışma ✓")}`)).toBe("çalışma ✓");
    expect(parseOsc52(`pc;${b64("a\nb")}`)).toBe("a\nb");
  });

  it("ignores queries, clearing, bad base64 and invalid UTF-8", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("c;")).toBeNull();
    expect(parseOsc52("nope")).toBeNull();
    expect(parseOsc52("c;not base64!")).toBeNull();
    expect(parseOsc52(`c;${btoa("\xff\xfe")}`)).toBeNull();
  });

  it("refuses writes over the size limit", () => {
    const big = "A".repeat(Math.ceil(((OSC52_MAX_BYTES + 10) * 4) / 3));
    expect(parseOsc52(`c;${big}`)).toBeNull();
  });
});

describe("recentOutputText", () => {
  it("drops blank rows around the output", () => {
    expect(recentOutputText(["", "  ", "a", "", "b", "", ""])).toBe("a\n\nb");
    expect(recentOutputText(["", ""])).toBe("");
  });
});

describe("RESET_MODES_SEQUENCE", () => {
  it("turns mouse reporting and the alternate screen off but leaves bracketed paste alone", () => {
    expect(RESET_MODES_SEQUENCE).toContain("\x1b[?1000l");
    expect(RESET_MODES_SEQUENCE).toContain("\x1b[?1049l");
    expect(RESET_MODES_SEQUENCE).not.toContain("2004");
    expect(RESET_MODES_SEQUENCE).not.toContain("9001");
  });
});
