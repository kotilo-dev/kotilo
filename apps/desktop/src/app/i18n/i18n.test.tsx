import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, saveStateSlice: vi.fn().mockResolvedValue(undefined) };
});

import * as ipc from "../../lib/ipc";
import { en } from "./en";
import { tr } from "./tr";
import { dictionary, formatTokens, hydrateLanguage, resolveLanguage, strings, useI18nStore, useStrings } from "./index";

/** Every leaf path of a dictionary with its runtime type. */
function leaves(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, type] of leaves(child, prefix ? `${prefix}.${key}` : key)) out.set(path, type);
    }
  } else {
    out.set(prefix, typeof value);
  }
  return out;
}

function emptyStrings(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return value.trim() === "" ? [prefix] : [];
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => emptyStrings(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

afterEach(() => {
  act(() => useI18nStore.setState({ preference: "en", language: "en" }));
});

describe("dictionaries", () => {
  it("TR has exactly the EN keys, with the same kinds of values", () => {
    expect(leaves(tr)).toEqual(leaves(en));
  });

  it("no TR string is empty", () => {
    expect(emptyStrings(tr)).toEqual([]);
  });

  it("TR functions return translated text for sample arguments", () => {
    expect(tr.commandTitles.switchToWorkspace(3)).toContain("3");
    expect(tr.confirm.removeWorkspaceBody(2)).toContain("2");
    expect(tr.viewer.readOnlyNotice("too_large")).not.toBe(en.viewer.readOnlyNotice("too_large"));
  });

  it("uses the DESIGN_SYSTEM §10 status names", () => {
    expect(en.status.needsPermission).toBe("Needs permission");
    expect(tr.status.needsPermission).toBe("İzin bekliyor");
    expect(tr.status.working).toBe("Çalışıyor");
  });
});

describe("language selection", () => {
  it("resolves 'system' from the OS language list", () => {
    expect(resolveLanguage("system", ["tr-TR", "en-US"])).toBe("tr");
    expect(resolveLanguage("system", ["de-DE", "en-GB"])).toBe("en");
    expect(resolveLanguage("system", ["de-DE"])).toBe("en");
    expect(resolveLanguage("tr", ["en-US"])).toBe("tr");
  });

  it("hydrates the saved preference from the ui slice", () => {
    hydrateLanguage({ ui: { language: "tr" } });
    expect(useI18nStore.getState()).toMatchObject({ preference: "tr", language: "tr" });
    expect(document.documentElement.lang).toBe("tr");
    hydrateLanguage({ ui: { language: "nonsense" } });
    expect(useI18nStore.getState().preference).toBe("system");
  });

  it("`strings` follows the active language and the choice is persisted", () => {
    act(() => useI18nStore.getState().setPreference("tr"));
    expect(strings.nav.overview).toBe(dictionary("tr").nav.overview);
    expect(ipc.saveStateSlice).toHaveBeenCalledWith("ui", { language: "tr" });
    act(() => useI18nStore.getState().setPreference("en"));
    expect(strings.nav.overview).toBe("Overview");
  });

  it("re-renders components using useStrings on a language switch", () => {
    function Label() {
      const s = useStrings();
      return <span>{s.nav.usage}</span>;
    }
    render(<Label />);
    expect(screen.getByText("Usage")).toBeInTheDocument();
    act(() => useI18nStore.getState().setPreference("tr"));
    expect(screen.getByText("Kullanım")).toBeInTheDocument();
  });
});

describe("formatting", () => {
  it("formats token counts per DESIGN_SYSTEM §10", () => {
    expect(formatTokens(312_400)).toBe("312k");
    expect(formatTokens(1_240_000)).toBe("1.24 M");
    expect(formatTokens(950)).toBe("950");
    act(() => useI18nStore.setState({ language: "tr" }));
    expect(formatTokens(1_240_000)).toBe("1,24 M");
  });
});
