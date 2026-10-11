import { describe, expect, it } from "vitest";
import type { AiSettings, HubSettings } from "../../lib/hubTypes";
import { strings } from "../../app/strings";
import {
  endpointErrors,
  enabledFeatures,
  featuresUsing,
  isFullyLocal,
  isLoopbackUrl,
  isValidBaseUrl,
  parseProviderId,
  removeEndpoint,
  upsertEndpoint,
  validateAi,
} from "./aiSettings";

const AI: AiSettings = {
  providers: [
    { name: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", hasKey: false },
    { name: "remote", kind: "openai", baseUrl: "https://api.example.com/v1", model: null, hasKey: true },
  ],
  assistant: { provider: "cli:claude-code", model: "haiku" },
  dailySummary: { provider: "openai:ollama", model: null },
  dictationCleanup: { provider: "openai:ollama", model: null },
};

function settings(ai: AiSettings, toggles: { buddy?: boolean; summary?: boolean; withoutAi?: boolean; dictation?: boolean; cleanup?: boolean } = {}): HubSettings {
  return {
    buddy: { enabled: toggles.buddy ?? false },
    insights: { dailySummaryEnabled: toggles.summary ?? true, dailySummaryWithoutAi: toggles.withoutAi ?? false },
    dictation: { enabled: toggles.dictation ?? true, aiCleanup: toggles.cleanup ?? true },
    ai,
  } as unknown as HubSettings;
}

const v = strings.ai.validation;

describe("aiSettings", () => {
  it("parses provider ids", () => {
    expect(parseProviderId("cli:codex")).toEqual({ kind: "cli", name: "codex" });
    expect(parseProviderId("openai:ollama")).toEqual({ kind: "openai", name: "ollama" });
    expect(parseProviderId("haiku")).toBeNull();
  });

  it("loopback hosts match the hub's rule", () => {
    for (const url of ["http://localhost:11434", "http://127.0.0.1:1234/v1", "http://127.8.0.1", "http://[::1]:8080/v1", "http://ai.localhost/v1"]) expect(isLoopbackUrl(url), url).toBe(true);
    for (const url of ["http://192.168.1.5:11434", "https://api.example.com/v1", "not a url", "http://localhost.example.com"]) expect(isLoopbackUrl(url), url).toBe(false);
  });

  it("base URLs: http(s) only, no credentials, query or fragment", () => {
    expect(isValidBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isValidBaseUrl("ftp://host")).toBe(false);
    expect(isValidBaseUrl("http://user:pw@host")).toBe(false);
    expect(isValidBaseUrl("http://host/v1?x=1")).toBe(false);
    expect(isValidBaseUrl("http://host/v1#a")).toBe(false);
  });

  it("enabled features follow the toggles", () => {
    expect(enabledFeatures(settings(AI, { buddy: true }))).toEqual(["assistant", "dailySummary", "dictationCleanup"]);
    expect(enabledFeatures(settings(AI, { withoutAi: true, cleanup: false }))).toEqual([]);
    expect(enabledFeatures(settings(AI, { summary: false, dictation: false }))).toEqual([]);
  });

  it("fully local only when every enabled feature uses a loopback endpoint", () => {
    expect(isFullyLocal(settings(AI))).toBe(true);
    // The assistant on an agent CLI counts once it is on.
    expect(isFullyLocal(settings(AI, { buddy: true }))).toBe(false);
    expect(isFullyLocal(settings({ ...AI, dailySummary: { provider: "openai:remote", model: "gpt" } }))).toBe(false);
    // Nothing enabled: nothing leaves the computer.
    expect(isFullyLocal(settings(AI, { summary: false, cleanup: false }))).toBe(true);
  });

  it("validates endpoints and feature choices with the hub's field keys", () => {
    const bad: AiSettings = {
      ...AI,
      providers: [...AI.providers, { name: "OLLAMA", kind: "openai", baseUrl: "localhost", model: "bad model", hasKey: false }],
      assistant: { provider: "openai:remote", model: null },
      dailySummary: { provider: "openai:gone", model: null },
      dictationCleanup: { provider: "cli:codex", model: "x y" },
    };
    expect(validateAi(bad, v)).toEqual({
      "ai.providers[2].name": v.nameTaken,
      "ai.providers[2].baseUrl": v.baseUrlInvalid,
      "ai.providers[2].model": v.modelInvalid,
      "ai.assistant.model": v.modelRequired,
      "ai.dailySummary.provider": v.providerMissing,
      "ai.dictationCleanup.model": v.modelInvalid,
    });
    expect(validateAi(AI, v)).toEqual({});
  });

  it("upsert keeps the name and key flag of an existing endpoint", () => {
    const next = upsertEndpoint(AI, { name: "renamed", kind: "openai", baseUrl: "http://localhost:1234/v1", model: "m", hasKey: false }, "remote");
    expect(next.providers[1]).toEqual({ name: "remote", kind: "openai", baseUrl: "http://localhost:1234/v1", model: "m", hasKey: true });
    expect(upsertEndpoint(AI, { name: "lm", kind: "openai", baseUrl: "http://localhost:1234/v1", model: null, hasKey: false }, null).providers).toHaveLength(3);
  });

  it("removing an endpoint moves its features to the fallback", () => {
    expect(featuresUsing(AI, "OLLAMA")).toEqual(["dailySummary", "dictationCleanup"]);
    const next = removeEndpoint(AI, "ollama", { provider: "cli:codex", model: null });
    expect(next.providers.map((p) => p.name)).toEqual(["remote"]);
    expect(next.dailySummary).toEqual({ provider: "cli:codex", model: null });
    expect(next.dictationCleanup).toEqual({ provider: "cli:codex", model: null });
    expect(next.assistant).toEqual(AI.assistant);
  });

  it("picks one endpoint's errors out of the settings errors", () => {
    expect(endpointErrors({ "ai.providers[1].baseUrl": "bad", "ai.providers[0].name": "x", "ai.assistant.model": "y" }, 1)).toEqual({ baseUrl: "bad" });
  });
});
