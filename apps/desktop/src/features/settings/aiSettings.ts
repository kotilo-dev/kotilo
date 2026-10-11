/**
 * Pure helpers for Settings → AI (M3, PRD §5.5, D-026): provider ids, the "fully local" rule
 * and client-side checks mirroring the hub's `ValidateAi`, so the save bar catches a bad value
 * before the whole settings object goes back. Field keys are the hub's dotted paths.
 */
import type { AiFeatureChoice, AiProviderSettings, AiSettings, HubSettings } from "../../lib/hubTypes";

export const AI_FEATURES = ["assistant", "dailySummary", "dictationCleanup"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Base URL presets offered as hints in the endpoint form; they only fill the URL. */
export const ENDPOINT_PRESETS = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
] as const;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@#+\-[\]]{0,127}$/;

export function openAiId(name: string): string {
  return `openai:${name}`;
}

/** `cli:codex` → `{kind: "cli", name: "codex"}`; null for anything else. */
export function parseProviderId(id: string): { kind: "cli" | "openai"; name: string } | null {
  const m = /^(cli|openai):(.+)$/.exec(id.trim());
  return m ? { kind: m[1] as "cli" | "openai", name: m[2]! } : null;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isValidModel(model: string): boolean {
  return MODEL_RE.test(model);
}

/** An absolute http(s) URL without credentials, query or fragment. */
export function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && !value.includes("?") && !value.includes("#");
}

/** `localhost`, `*.localhost`, 127.0.0.0/8 or ::1 (the hub's `IsLoopback`). */
export function isLoopbackUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1";
}

export function findEndpoint(ai: AiSettings, name: string): AiProviderSettings | undefined {
  return ai.providers.find((p) => p.name.toLowerCase() === name.toLowerCase());
}

/** The features that would call a provider with the current toggles (hub `EnabledFeatures`). */
export function enabledFeatures(s: HubSettings): AiFeature[] {
  const out: AiFeature[] = [];
  if (s.buddy.enabled) out.push("assistant");
  if (s.insights.dailySummaryEnabled && !s.insights.dailySummaryWithoutAi) out.push("dailySummary");
  if (s.dictation.enabled && s.dictation.aiCleanup) out.push("dictationCleanup");
  return out;
}

/**
 * Every enabled AI feature uses an `openai:` endpoint on a loopback host (hub `IsFullyLocal`).
 * Computed from the draft so the badge follows unsaved edits; agent CLIs never count as local.
 */
export function isFullyLocal(s: HubSettings): boolean {
  const ai = s.ai;
  if (!ai) return false;
  return enabledFeatures(s).every((f) => {
    const id = parseProviderId(ai[f].provider);
    if (id?.kind !== "openai") return false;
    const endpoint = findEndpoint(ai, id.name);
    return endpoint !== undefined && isLoopbackUrl(endpoint.baseUrl);
  });
}

export interface AiValidationText {
  nameInvalid: string;
  nameTaken: string;
  baseUrlInvalid: string;
  modelInvalid: string;
  providerMissing: string;
  modelRequired: string;
}

/** Endpoint fields only (the add/edit form and the settings check share it). Keys: `name`, `baseUrl`, `model`. */
export function validateEndpoint(p: Pick<AiProviderSettings, "name" | "baseUrl" | "model">, others: readonly AiProviderSettings[], t: AiValidationText): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = p.name.trim();
  if (!isValidName(name)) errors.name = t.nameInvalid;
  else if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) errors.name = t.nameTaken;
  if (!isValidBaseUrl(p.baseUrl)) errors.baseUrl = t.baseUrlInvalid;
  const model = p.model?.trim() ?? "";
  if (model !== "" && !isValidModel(model)) errors.model = t.modelInvalid;
  return errors;
}

/** Client-side checks of `settings.ai`, keyed like the hub's `fields`. Empty object = valid. */
export function validateAi(ai: AiSettings | undefined, t: AiValidationText): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!ai) return errors;
  ai.providers.forEach((p, i) => {
    const own = validateEndpoint(p, ai.providers.slice(0, i), t);
    for (const [k, v] of Object.entries(own)) errors[`ai.providers[${i}].${k}`] = v;
  });
  for (const f of AI_FEATURES) {
    const choice = ai[f];
    const model = choice.model?.trim() ?? "";
    if (model !== "" && !isValidModel(model)) errors[`ai.${f}.model`] = t.modelInvalid;
    const id = parseProviderId(choice.provider);
    if (id?.kind === "openai") {
      const endpoint = findEndpoint(ai, id.name);
      if (!endpoint) errors[`ai.${f}.provider`] = t.providerMissing;
      else if (model === "" && !endpoint.model?.trim()) errors[`ai.${f}.model`] ??= t.modelRequired;
    }
  }
  return errors;
}

/** Empty model text → null (the provider's default). */
export function normalizeModel(text: string): string | null {
  const v = text.trim();
  return v === "" ? null : v;
}

/** Adds or replaces an endpoint (matched by `originalName`); the name of an existing endpoint never changes. */
export function upsertEndpoint(ai: AiSettings, endpoint: AiProviderSettings, originalName: string | null): AiSettings {
  if (originalName === null) return { ...ai, providers: [...ai.providers, endpoint] };
  return { ...ai, providers: ai.providers.map((p) => (p.name.toLowerCase() === originalName.toLowerCase() ? { ...endpoint, name: p.name, hasKey: p.hasKey } : p)) };
}

/**
 * Removes an endpoint; features that used it fall back to `fallback` (default model), so the
 * saved settings stay valid. The hub deletes the endpoint's stored key.
 */
export function removeEndpoint(ai: AiSettings, name: string, fallback: AiFeatureChoice): AiSettings {
  const id = openAiId(name).toLowerCase();
  const next: AiSettings = { ...ai, providers: ai.providers.filter((p) => p.name.toLowerCase() !== name.toLowerCase()) };
  for (const f of AI_FEATURES) if (next[f].provider.toLowerCase() === id) next[f] = fallback;
  return next;
}

/** Features that currently use the endpoint `name`. */
export function featuresUsing(ai: AiSettings, name: string): AiFeature[] {
  const id = openAiId(name).toLowerCase();
  return AI_FEATURES.filter((f) => ai[f].provider.toLowerCase() === id);
}

/** Index of an endpoint in `ai.providers` (for `ai.providers[i].*` field errors). */
export function endpointIndex(ai: AiSettings, name: string): number {
  return ai.providers.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
}

/** Field errors of one endpoint, from the settings errors (`ai.providers[i].baseUrl` → `baseUrl`). */
export function endpointErrors(errors: Record<string, string>, index: number): Record<string, string> {
  const prefix = `ai.providers[${index}].`;
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}
