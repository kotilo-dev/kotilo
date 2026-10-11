/**
 * Settings → AI (M3, PRD §5.5, D-026): which provider runs Kotilo's own AI jobs. Agent CLIs
 * come from `GET /v1/ai/providers`; OpenAI-compatible endpoints live in `settings.ai.providers`
 * and are saved right away (a key can only be stored for a saved endpoint). The per-feature
 * choices edit the page draft like every other hub section. An API key exists only in the
 * endpoint form's local state until it is sent to the vault, and is cleared right after.
 */
import { useId, useState } from "react";
import { useStrings, type Strings } from "../../app/i18n";
import { ConfirmModal } from "../../app/ConfirmModal";
import { AgentAvatar } from "../../app/ui/AgentAvatar";
import { hubRequest } from "../../lib/ipc";
import type { AiErrorKind, AiFeatureChoice, AiModelsResponse, AiProviderInfo, AiProviderSettings, AiProvidersResponse, AiSettings, AiTestResult } from "../../lib/hubTypes";
import { useToastStore } from "../../stores/toastStore";
import {
  AI_FEATURES,
  ENDPOINT_PRESETS,
  endpointErrors,
  endpointIndex,
  featuresUsing,
  isFullyLocal,
  isLoopbackUrl,
  normalizeModel,
  openAiId,
  parseProviderId,
  removeEndpoint,
  upsertEndpoint,
  validateEndpoint,
  type AiFeature,
} from "./aiSettings";
import { Button, Card, Checkbox, Dialog, Field, Notice, SectionLabel, Select, TextInput } from "./controls";
import type { HubSectionProps } from "./HubSections";
import { asAppError, useHubResource } from "./hubData";

type T = Strings["ai"];

type TestState = { kind: "running" } | { kind: "done"; result: AiTestResult } | { kind: "error"; message: string };

/** Small label chip (tokens only): tone picks the status tint. */
export function Badge({ tone = "neutral", title, children }: { tone?: "neutral" | "local" | "warning"; title?: string; children: React.ReactNode }) {
  const toneClass = tone === "local" ? "bg-idle-bg text-idle-ink" : tone === "warning" ? "bg-working-bg text-working-ink" : "bg-surface-5 text-text-3";
  return (
    <span title={title} className={`inline-flex h-5 items-center whitespace-nowrap rounded-full px-2 text-label font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

function errorKindText(t: T, kind: AiErrorKind): string {
  return t.errorKinds[kind];
}

function TestOutcome({ state, t }: { state: TestState | undefined; t: T }) {
  if (!state) return null;
  if (state.kind === "running") return <span className="text-small text-muted">{t.testing}</span>;
  if (state.kind === "error")
    return (
      <span role="alert" className="text-small text-blocked-ink">
        {state.message}
      </span>
    );
  const r = state.result;
  return r.ok ? (
    <span role="status" className="font-mono text-small text-idle-ink">
      {t.testOk(r.latencyMs)}
    </span>
  ) : (
    <span role="alert" className="text-small text-blocked-ink">
      {t.testFailed(errorKindText(t, r.errorKind))}
    </span>
  );
}

export function AiSection({ draft, update, errors, commitAi }: HubSectionProps) {
  const s = useStrings();
  const t = s.ai;
  const res = useHubResource<AiProvidersResponse>("/v1/ai/providers");
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [editing, setEditing] = useState<{ endpoint: AiProviderSettings | null } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const ai = draft.ai;
  if (!ai) return <Notice tone="warning">{t.hubTooOld}</Notice>;

  const infos = res.data?.providers ?? [];
  const cli = infos.filter((p) => p.kind === "cli");
  const vault = res.data?.secretStoreAvailable ?? true;
  const fullyLocal = isFullyLocal(draft);

  async function runTest(key: string, provider: string, model: string | null) {
    setTests((m) => ({ ...m, [key]: { kind: "running" } }));
    try {
      const result = await hubRequest<AiTestResult>("POST", "/v1/ai/test", { provider, model });
      setTests((m) => ({ ...m, [key]: { kind: "done", result } }));
    } catch (e) {
      setTests((m) => ({ ...m, [key]: { kind: "error", message: asAppError(e).message } }));
    }
  }

  async function removeKey(name: string) {
    try {
      await hubRequest("DELETE", `/v1/ai/providers/${encodeURIComponent(name)}/key`);
      useToastStore.getState().show(t.keyRemoved);
      await res.reload();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  /** Where features using a deleted endpoint go: the first installed agent CLI. */
  const fallback: AiFeatureChoice = { provider: cli[0]?.id ?? "cli:claude-code", model: null };

  async function deleteEndpoint(name: string) {
    setDeleting(null);
    try {
      await commitAi?.((a) => removeEndpoint(a, name, fallback));
      await res.reload();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  const setChoice = (feature: AiFeature, patch: Partial<AiFeatureChoice>) =>
    update((d) => (d.ai ? { ...d, ai: { ...d.ai, [feature]: { ...d.ai[feature], ...patch } } } : d));

  const featureName = (f: AiFeature) => t.featureNames[f];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <span className="min-w-0 flex-1 text-body text-text-2">{t.intro}</span>
        <span tabIndex={0} aria-describedby="ai-local-tip" className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {fullyLocal ? (
            <Badge tone="local" title={t.fullyLocalTooltip}>
              {t.fullyLocal}
            </Badge>
          ) : (
            <Badge title={t.notFullyLocalTooltip}>{t.notFullyLocal}</Badge>
          )}
          <span id="ai-local-tip" className="sr-only">
            {fullyLocal ? t.fullyLocalTooltip : t.notFullyLocalTooltip}
          </span>
        </span>
      </div>

      {res.unavailable && <Notice tone="warning">{s.settingsPage.hubUnavailable}</Notice>}
      {res.error && !res.unavailable && <Notice tone="error">{t.loadFailed(res.error.message)}</Notice>}

      <section aria-labelledby="ai-features" className="flex flex-col gap-3">
        <SectionLabel id="ai-features">{t.features}</SectionLabel>
        {AI_FEATURES.map((f) => (
          <FeatureRow
            key={f}
            feature={f}
            choice={ai[f]}
            ai={ai}
            cli={cli}
            errors={errors}
            t={t}
            test={tests[`f:${f}`]}
            onTest={() => void runTest(`f:${f}`, ai[f].provider, ai[f].model)}
            onChange={(patch) => setChoice(f, patch)}
          >
            {f === "assistant" && !draft.buddy.enabled && <span className="text-small text-muted">{t.assistantOff}</span>}
            {f === "dailySummary" && (
              <>
                <Checkbox
                  checked={!draft.insights.dailySummaryWithoutAi}
                  onChange={(v) => update((d) => ({ ...d, insights: { ...d.insights, dailySummaryWithoutAi: !v } }))}
                  label={t.dailySummaryUseAi}
                />
                {!draft.insights.dailySummaryEnabled && <span className="text-small text-muted">{t.dailySummaryOff}</span>}
              </>
            )}
            {f === "dictationCleanup" && (
              <>
                <Checkbox checked={draft.dictation.aiCleanup} onChange={(aiCleanup) => update((d) => ({ ...d, dictation: { ...d.dictation, aiCleanup } }))} label={s.settingsPage.dictation.aiCleanup} />
                {!draft.dictation.enabled && <span className="text-small text-muted">{t.dictationOff}</span>}
              </>
            )}
          </FeatureRow>
        ))}
      </section>

      <section aria-labelledby="ai-cli" className="flex flex-col gap-3">
        <SectionLabel id="ai-cli">{t.cliProviders}</SectionLabel>
        <span className="text-small text-muted">{t.cliHint}</span>
        {res.data && cli.length === 0 && <span className="text-body text-muted">{t.noCli}</span>}
        {cli.length > 0 && (
          <Card>
            <ul className="m-0 list-none p-0">
              {cli.map((p, i) => (
                <li key={p.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-border-subtle" : ""}`}>
                  <AgentAvatar agent={parseProviderId(p.id)?.name ?? p.id} size={24} />
                  <span className="text-ui font-medium text-text">{p.displayName}</span>
                  <span className="font-mono text-meta text-muted">{p.id}</span>
                  {!p.verified && (
                    <Badge tone="warning" title={t.notVerifiedTooltip}>
                      {t.notVerified}
                    </Badge>
                  )}
                  <span className="flex-1" />
                  <TestOutcome state={tests[`p:${p.id}`]} t={t} />
                  <Button small onClick={() => void runTest(`p:${p.id}`, p.id, null)} disabled={tests[`p:${p.id}`]?.kind === "running"} ariaLabel={t.testNamed(p.displayName)}>
                    {t.test}
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section aria-labelledby="ai-endpoints" className="flex flex-col gap-3">
        <SectionLabel id="ai-endpoints">{t.endpoints}</SectionLabel>
        <span className="text-small text-muted">{t.endpointsHint}</span>
        {ai.providers.length === 0 ? (
          <span className="text-body text-muted">{t.noEndpoints}</span>
        ) : (
          <Card>
            <ul className="m-0 list-none p-0">
              {ai.providers.map((p, i) => {
                const info = infos.find((x) => x.id.toLowerCase() === openAiId(p.name).toLowerCase());
                const hasKey = info?.hasKey ?? p.hasKey;
                const rowErrors = Object.values(endpointErrors(errors, i));
                const id = openAiId(p.name);
                return (
                  <li key={p.name} className={`flex flex-col gap-2 px-4 py-3 ${i > 0 ? "border-t border-border-subtle" : ""}`}>
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-ui font-medium text-text">{p.name}</span>
                      {(info?.isLoopback ?? isLoopbackUrl(p.baseUrl)) && (
                        <Badge tone="local" title={t.localTooltip}>
                          {t.local}
                        </Badge>
                      )}
                      {hasKey && <Badge>{t.keySaved}</Badge>}
                      <span className="flex-1" />
                      <TestOutcome state={tests[`p:${id}`]} t={t} />
                      <Button small onClick={() => void runTest(`p:${id}`, id, null)} disabled={tests[`p:${id}`]?.kind === "running"} ariaLabel={t.testNamed(p.name)}>
                        {t.test}
                      </Button>
                      {hasKey && (
                        <Button small variant="ghost" onClick={() => void removeKey(p.name)} ariaLabel={t.removeKeyNamed(p.name)}>
                          {t.removeKey}
                        </Button>
                      )}
                      <Button small variant="ghost" onClick={() => setEditing({ endpoint: p })} ariaLabel={t.editNamed(p.name)}>
                        {t.edit}
                      </Button>
                      <Button small variant="danger" onClick={() => setDeleting(p.name)} ariaLabel={t.deleteNamed(p.name)}>
                        {t.delete}
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-small text-muted">
                      <span className="font-mono">{p.baseUrl}</span>
                      <span>
                        {t.defaultModel}: <span className="font-mono text-text-2">{p.model ?? "—"}</span>
                      </span>
                    </div>
                    {rowErrors.map((e) => (
                      <span key={e} role="alert" className="text-meta text-blocked-ink">
                        {e}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        <div>
          <Button onClick={() => setEditing({ endpoint: null })} disabled={!commitAi}>
            {t.addEndpoint}
          </Button>
        </div>
      </section>

      {editing && commitAi && (
        <EndpointDialog
          t={t}
          ai={ai}
          endpoint={editing.endpoint}
          vault={vault}
          hasKey={editing.endpoint ? (infos.find((x) => x.id.toLowerCase() === openAiId(editing.endpoint!.name).toLowerCase())?.hasKey ?? editing.endpoint.hasKey) : false}
          commitAi={commitAi}
          onDone={() => {
            setEditing(null);
            void res.reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {deleting !== null && (
        <ConfirmModal
          title={t.deleteTitle(deleting)}
          body={t.deleteBody(featuresUsing(ai, deleting).map(featureName), cli[0]?.displayName ?? fallback.provider)}
          confirmLabel={t.delete}
          onCancel={() => setDeleting(null)}
          onConfirm={() => void deleteEndpoint(deleting)}
        />
      )}
    </div>
  );
}

function FeatureRow({
  feature,
  choice,
  ai,
  cli,
  errors,
  t,
  test,
  onTest,
  onChange,
  children,
}: {
  feature: AiFeature;
  choice: AiFeatureChoice;
  ai: AiSettings;
  cli: AiProviderInfo[];
  errors: Record<string, string>;
  t: T;
  test: TestState | undefined;
  onTest: () => void;
  onChange: (patch: Partial<AiFeatureChoice>) => void;
  children?: React.ReactNode;
}) {
  const options: { value: string; label: string }[] = [
    ...cli.map((p) => ({ value: p.id, label: p.verified ? t.cliOption(p.displayName) : t.cliOptionUnverified(p.displayName) })),
    ...ai.providers.map((p) => ({ value: openAiId(p.name), label: t.endpointOption(p.name) })),
  ];
  if (!options.some((o) => o.value.toLowerCase() === choice.provider.toLowerCase())) options.unshift({ value: choice.provider, label: t.unavailableOption(choice.provider) });
  const id = parseProviderId(choice.provider);
  const endpoint = id?.kind === "openai" ? ai.providers.find((p) => p.name.toLowerCase() === id.name.toLowerCase()) : undefined;
  const placeholder = endpoint?.model ? t.modelDefault(endpoint.model) : t.modelPlaceholder;
  return (
    <Card className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-ui font-medium text-text">
          {t.featureNames[feature]}
        </span>
        <span className="text-small text-muted">{t.featureHints[feature]}</span>
      </div>
      {children}
      <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field label={t.provider} error={errors[`ai.${feature}.provider`]}>
          {(ids) => <Select {...ids} value={choice.provider} onChange={(provider) => onChange({ provider })} options={options} />}
        </Field>
        <Field label={t.model} error={errors[`ai.${feature}.model`]}>
          {(ids) => (
            <TextInput
              {...ids}
              value={choice.model ?? ""}
              placeholder={placeholder}
              onChange={(v) => onChange({ model: v.trim() === "" ? null : v })}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5 sm:pt-[22px]">
          <Button small onClick={onTest} disabled={test?.kind === "running"} ariaLabel={t.testNamed(t.featureNames[feature])}>
            {t.test}
          </Button>
        </div>
      </div>
      <TestOutcome state={test} t={t} />
    </Card>
  );
}

function EndpointDialog({
  t,
  ai,
  endpoint,
  vault,
  hasKey,
  commitAi,
  onDone,
  onCancel,
}: {
  t: T;
  ai: AiSettings;
  endpoint: AiProviderSettings | null;
  vault: boolean;
  hasKey: boolean;
  commitAi: NonNullable<HubSectionProps["commitAi"]>;
  onDone: () => void;
  onCancel: () => void;
}) {
  // After a first save the form keeps editing that endpoint (e.g. to retry a rejected key).
  const [savedName, setSavedName] = useState<string | null>(endpoint?.name ?? null);
  const [name, setName] = useState(endpoint?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
  const [model, setModel] = useState(endpoint?.model ?? "");
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const listId = useId();

  const others = ai.providers.filter((p) => savedName === null || p.name.toLowerCase() !== savedName.toLowerCase());
  const clientErrors = validateEndpoint({ name, baseUrl, model }, others, t.validation);
  const shownErrors = { ...serverErrors, ...clientErrors };
  const touched = name !== "" || baseUrl !== "";

  async function loadModels() {
    if (savedName === null) return;
    setModelsNote(t.loadingModels);
    try {
      const r = await hubRequest<AiModelsResponse>("GET", `/v1/ai/providers/${encodeURIComponent(savedName)}/models`);
      setModels(r.models);
      setModelsNote(r.errorKind === "none" ? t.modelsLoaded(r.models.length) : t.modelsFailed(t.errorKinds[r.errorKind]));
    } catch (e) {
      setModelsNote(t.modelsFailed(asAppError(e).message));
    }
  }

  async function submit() {
    if (Object.keys(clientErrors).length > 0) return;
    setBusy(true);
    setMessage(null);
    const entry: AiProviderSettings = { name: name.trim(), kind: "openai", baseUrl: baseUrl.trim(), model: normalizeModel(model), hasKey };
    const change = (a: AiSettings) => upsertEndpoint(a, entry, savedName);
    try {
      await commitAi(change);
    } catch (e) {
      const err = asAppError(e);
      const index = savedName === null ? ai.providers.length : endpointIndex(ai, savedName);
      const fields = Object.fromEntries(Object.entries(err.fields ?? {}).map(([k, v]) => [k, v.join("; ")]));
      setServerErrors(endpointErrors(fields, index));
      setMessage(err.message);
      setBusy(false);
      return;
    }
    setSavedName(entry.name);
    // The key goes straight to the vault and is dropped from memory whatever the outcome.
    const secret = key.trim();
    setKey("");
    if (secret !== "") {
      try {
        await hubRequest("PUT", `/v1/ai/providers/${encodeURIComponent(entry.name)}/key`, { key: secret });
      } catch (e) {
        const err = asAppError(e);
        setServerErrors(err.fields?.key ? { key: err.fields.key.join("; ") } : {});
        setMessage(t.keyFailed(err.message));
        setBusy(false);
        return;
      }
    }
    setBusy(false);
    onDone();
  }

  return (
    <Dialog
      title={endpoint ? t.editTitle(endpoint.name) : t.addTitle}
      onCancel={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t.cancel}
          </Button>
          <Button variant="primary" disabled={busy || Object.keys(clientErrors).length > 0} onClick={() => void submit()}>
            {busy ? t.saving : t.save}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t.name} hint={savedName === null ? t.nameHint : t.nameFixed} error={touched || serverErrors.name ? shownErrors.name : null}>
          {(ids) =>
            savedName === null ? (
              <TextInput {...ids} value={name} onChange={setName} placeholder="ollama" />
            ) : (
              <span id={ids.id} aria-describedby={ids.describedBy} className="text-ui font-medium text-text">
                {name}
              </span>
            )
          }
        </Field>
        <Field label={t.baseUrl} hint={t.baseUrlHint} error={touched || serverErrors.baseUrl ? shownErrors.baseUrl : null}>
          {(ids) => <TextInput {...ids} value={baseUrl} onChange={setBaseUrl} placeholder={ENDPOINT_PRESETS[0].baseUrl} />}
        </Field>
        <div className="-mt-2 flex flex-wrap items-center gap-2" role="group" aria-label={t.presets}>
          <span className="text-meta text-muted">{t.presets}:</span>
          {ENDPOINT_PRESETS.map((p) => (
            <Button key={p.id} small variant="ghost" onClick={() => setBaseUrl(p.baseUrl)} title={p.baseUrl}>
              {p.label}
            </Button>
          ))}
        </div>
        <Field label={t.defaultModel} hint={modelsNote ?? (savedName === null ? t.modelsSaveFirst : t.defaultModelHint)} error={shownErrors.model}>
          {(ids) => (
            <div className="flex gap-2">
              <input
                id={ids.id}
                list={listId}
                value={model}
                aria-describedby={ids.describedBy}
                aria-invalid={ids.invalid || undefined}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-control border border-border bg-surface-3 px-2 py-1.5 font-mono text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[invalid=true]:border-blocked"
              />
              <datalist id={listId}>{models?.map((m) => <option key={m} value={m} />)}</datalist>
              <span className="shrink-0 whitespace-nowrap">
                <Button small onClick={() => void loadModels()} disabled={savedName === null}>
                  {t.loadModels}
                </Button>
              </span>
            </div>
          )}
        </Field>
        <Field label={t.apiKey} hint={!vault ? t.apiKeyUnavailable : hasKey ? t.apiKeyReplace : t.apiKeyHint} error={serverErrors.key}>
          {(ids) => (
            <input
              id={ids.id}
              type="password"
              autoComplete="off"
              value={key}
              disabled={!vault}
              aria-describedby={ids.describedBy}
              aria-invalid={ids.invalid || undefined}
              onChange={(e) => setKey(e.target.value)}
              className="w-full rounded-control border border-border bg-surface-3 px-2 py-1.5 text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 aria-[invalid=true]:border-blocked"
            />
          )}
        </Field>
        {message && <Notice tone="error">{message}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
