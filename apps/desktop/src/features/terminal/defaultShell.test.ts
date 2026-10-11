import { describe, expect, it } from "vitest";
import { resolveDefaultProfileId } from "./defaultShell";
import type { ShellProfile } from "../../lib/ipc";

const profiles: ShellProfile[] = [
  { id: "pwsh", name: "PowerShell 7", program: "pwsh.exe", args: [] },
  { id: "cmd", name: "Command Prompt", program: "cmd.exe", args: [] },
];

describe("resolveDefaultProfileId", () => {
  it("returns null (automatic) when defaultShell is null", () => {
    expect(resolveDefaultProfileId(profiles, null)).toBeNull();
  });

  it("returns the configured shell when it's present on this machine", () => {
    expect(resolveDefaultProfileId(profiles, "cmd")).toBe("cmd");
  });

  it("falls back to automatic when the configured shell isn't detected on this machine", () => {
    expect(resolveDefaultProfileId(profiles, "wsl")).toBeNull();
  });

  it("falls back to automatic when the profile list is empty", () => {
    expect(resolveDefaultProfileId([], "pwsh")).toBeNull();
  });
});
