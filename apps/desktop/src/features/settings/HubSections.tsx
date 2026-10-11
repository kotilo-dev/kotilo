/**
 * Settings sections stored by the hub (`/v1/settings`): notifications, usage, projects,
 * tasks, dictation. They edit a shared draft; the page's save bar sends it back as a whole.
 */
import { useEffect, useState } from "react";
import { formatCurrencyUsd, formatDateTime, useStrings } from "../../app/i18n";
import { hubRequest, pickFolders } from "../../lib/ipc";
import type { AiSettings, DictationSettings, HubSettings, PricingDto } from "../../lib/hubTypes";
import { useToastStore } from "../../stores/toastStore";
import { Button, Card, Checkbox, Field, Notice, SectionLabel, Select, TextArea, TextInput } from "./controls";
import { asAppError, useHubResource } from "./hubData";
import { useSettingsPageStore } from "./SettingsPage";
import { dndUntil, formatTimeSpan, INVALID_TIMESPAN, inputToTimeOnly, parseNumberList, parseTimeSpan, timeOnlyToInput } from "./hubSettings";

export interface HubSectionProps {
  draft: HubSettings;
  update: (change: (draft: HubSettings) => HubSettings) => void;
  errors: Record<string, string>;
  /**
   * Saves a change of `settings.ai` right away (on top of the last saved settings) and applies
   * it to the draft too; rejects with the hub's error. Used for AI endpoints, whose keys can
   * only be stored once the endpoint is saved.
   */
  commitAi?: (change: (ai: AiSettings) => AiSettings) => Promise<void>;
}

/** Number input over a string, so a half-typed or empty value is visible as invalid instead of becoming 0. */
function NumberInput({ value, onChange, id, describedBy, invalid, step }: { value: number; onChange: (n: number) => void; id?: string; describedBy?: string; invalid?: boolean; step?: string }) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : Number.isFinite(value) ? String(value) : current));
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      step={step}
      value={text}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value));
      }}
      className="w-28 rounded-control border border-border bg-surface-3 px-2 py-1.5 font-mono text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-[invalid=true]:border-blocked"
    />
  );
}

/** A TimeSpan edited as a number of `unit` seconds (e.g. minutes). */
function SpanField({ label, value, unit, error, onChange }: { label: string; value: string; unit: number; error?: string; onChange: (span: string) => void }) {
  const seconds = parseTimeSpan(value);
  return (
    <Field label={label} error={error}>
      {(ids) => (
        <NumberInput
          {...ids}
          value={seconds === null ? Number.NaN : seconds / unit}
          onChange={(n) => onChange(Number.isFinite(n) ? (formatTimeSpan(n * unit) ?? INVALID_TIMESPAN) : INVALID_TIMESPAN)}
        />
      )}
    </Field>
  );
}

export function NotificationsSection({ draft, update, errors }: HubSectionProps) {
  const s = useStrings();
  const t = s.settingsPage.notifications;
  const rules = draft.rules;
  const setRules = (patch: Partial<HubSettings["rules"]>) => update((d) => ({ ...d, rules: { ...d.rules, ...patch } }));
  const dnd = draft.doNotDisturbUntil && new Date(draft.doNotDisturbUntil).getTime() > Date.now() ? draft.doNotDisturbUntil : null;

  return (
    <div className="flex flex-col gap-6">
      <Field label={t.language}>
        {(ids) => (
          <Select<HubSettings["language"]>
            {...ids}
            value={draft.language}
            onChange={(language) => update((d) => ({ ...d, language }))}
            options={[
              { value: "en-US", label: s.settings.appearance.languageEnglish },
              { value: "tr-TR", label: s.settings.appearance.languageTurkish },
            ]}
          />
        )}
      </Field>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.rules}</SectionLabel>
        <Checkbox checked={rules.waitingPermissionEnabled} onChange={(v) => setRules({ waitingPermissionEnabled: v })} label={t.waitingPermission} />
        <Checkbox checked={rules.waitingInputEnabled} onChange={(v) => setRules({ waitingInputEnabled: v })} label={t.waitingInput} />
        <Checkbox checked={rules.completedEnabled} onChange={(v) => setRules({ completedEnabled: v })} label={t.completed} />
        {rules.completedEnabled && (
          <div className="pl-6">
            <SpanField label={t.minTurn} value={rules.minTurnForCompleted} unit={1} error={errors["rules.minTurnForCompleted"]} onChange={(minTurnForCompleted) => setRules({ minTurnForCompleted })} />
          </div>
        )}
        <Checkbox checked={rules.staleEnabled} onChange={(v) => setRules({ staleEnabled: v })} label={t.stale} />
        <Checkbox checked={rules.waitingReminderEnabled} onChange={(v) => setRules({ waitingReminderEnabled: v })} label={t.reminder} />
        {rules.waitingReminderEnabled && (
          <div className="pl-6">
            <SpanField label={t.reminderAfter} value={rules.reminderAfter} unit={60} error={errors["rules.reminderAfter"]} onChange={(reminderAfter) => setRules({ reminderAfter })} />
          </div>
        )}
        <Checkbox checked={rules.unseenReminderEnabled} onChange={(v) => setRules({ unseenReminderEnabled: v })} label={t.unseenReminder} />
        {rules.unseenReminderEnabled && (
          <div className="pl-6">
            <SpanField
              label={t.unseenReminderAfter}
              value={rules.unseenReminderAfter}
              unit={60}
              error={errors["rules.unseenReminderAfter"]}
              onChange={(unseenReminderAfter) => setRules({ unseenReminderAfter })}
            />
          </div>
        )}
        <Checkbox checked={rules.errorEnabled} onChange={(v) => setRules({ errorEnabled: v })} label={t.error} />
        <Checkbox checked={rules.todoCompletedEnabled} onChange={(v) => setRules({ todoCompletedEnabled: v })} label={t.todoCompleted} />
        <Checkbox checked={rules.contextHighEnabled} onChange={(v) => setRules({ contextHighEnabled: v })} label={t.contextHigh} />
        {rules.contextHighEnabled && (
          <div className="grid gap-4 pl-6 sm:grid-cols-2">
            <Field label={t.contextThreshold} error={errors["rules.contextThresholdPercent"]}>
              {(ids) => <NumberInput {...ids} value={rules.contextThresholdPercent} onChange={(n) => setRules({ contextThresholdPercent: n })} />}
            </Field>
            <Field label={t.contextRearm} error={errors["rules.contextRearmPercent"]}>
              {(ids) => <NumberInput {...ids} value={rules.contextRearmPercent} onChange={(n) => setRules({ contextRearmPercent: n })} />}
            </Field>
          </div>
        )}
        <Checkbox checked={draft.suppressWhenTerminalFocused} onChange={(v) => update((d) => ({ ...d, suppressWhenTerminalFocused: v }))} label={t.suppressFocused} />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.quietHours}</SectionLabel>
        <Checkbox checked={draft.quietHours.enabled} onChange={(enabled) => update((d) => ({ ...d, quietHours: { ...d.quietHours, enabled } }))} label={t.quietEnabled} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.quietStart} error={errors["quietHours.start"]}>
            {(ids) => (
              <TextInput {...ids} type="time" value={timeOnlyToInput(draft.quietHours.start)} onChange={(v) => update((d) => ({ ...d, quietHours: { ...d.quietHours, start: inputToTimeOnly(v) } }))} />
            )}
          </Field>
          <Field label={t.quietEnd} error={errors["quietHours.end"]}>
            {(ids) => (
              <TextInput {...ids} type="time" value={timeOnlyToInput(draft.quietHours.end)} onChange={(v) => update((d) => ({ ...d, quietHours: { ...d.quietHours, end: inputToTimeOnly(v) } }))} />
            )}
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.dnd}</SectionLabel>
        <span className="text-ui text-text-2">{dnd ? t.dndUntil(formatDateTime(new Date(dnd), { dateStyle: "medium", timeStyle: "short" })) : t.dndOff}</span>
        <div className="flex flex-wrap gap-2">
          <Button small onClick={() => update((d) => ({ ...d, doNotDisturbUntil: dndUntil("hour") }))}>{t.dndHour}</Button>
          <Button small onClick={() => update((d) => ({ ...d, doNotDisturbUntil: dndUntil("tomorrow") }))}>{t.dndTomorrow}</Button>
          {dnd && (
            <Button small variant="ghost" onClick={() => update((d) => ({ ...d, doNotDisturbUntil: null }))}>
              {t.dndClear}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function UsageSection({ draft, update, errors }: HubSectionProps) {
  const s = useStrings();
  const t = s.settingsPage.usage;
  const u = draft.usageRules;
  const setU = (patch: Partial<HubSettings["usageRules"]>) => update((d) => ({ ...d, usageRules: { ...d.usageRules, ...patch } }));
  const [listText, setListText] = useState(u.blockTokenThresholds.join(", "));
  const listInvalid = parseNumberList(listText) === null;
  const pricing = useHubResource<PricingDto>("/v1/pricing");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <SectionLabel>{t.rules}</SectionLabel>
        <Checkbox checked={u.blockThresholdEnabled} onChange={(v) => setU({ blockThresholdEnabled: v })} label={t.blockThreshold} />
        {u.blockThresholdEnabled && (
          <div className="pl-6">
            <Field label={t.blockThresholds} error={listInvalid ? t.blockThresholdsInvalid : null}>
              {(ids) => (
                <TextInput
                  {...ids}
                  value={listText}
                  onChange={(text) => {
                    setListText(text);
                    const parsed = parseNumberList(text);
                    if (parsed) setU({ blockTokenThresholds: parsed });
                  }}
                />
              )}
            </Field>
          </div>
        )}
        <Checkbox checked={u.dailyCostEnabled} onChange={(v) => setU({ dailyCostEnabled: v })} label={t.dailyCost} />
        {u.dailyCostEnabled && (
          <div className="pl-6">
            <Field label={t.dailyCostThreshold} error={errors["usageRules.dailyCostThresholdUsd"]}>
              {(ids) => <NumberInput {...ids} step="0.5" value={u.dailyCostThresholdUsd} onChange={(n) => setU({ dailyCostThresholdUsd: n })} />}
            </Field>
          </div>
        )}
        <Checkbox checked={u.burnProjectionEnabled} onChange={(v) => setU({ burnProjectionEnabled: v })} label={t.burnProjection} />
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.dailySummary}</SectionLabel>
        <Checkbox checked={draft.insights.dailySummaryEnabled} onChange={(v) => update((d) => ({ ...d, insights: { ...d.insights, dailySummaryEnabled: v } }))} label={t.dailySummaryEnabled} />
        <Field label={t.dailySummaryTime} error={errors["insights.dailySummaryTime"]}>
          {(ids) => <TextInput {...ids} type="time" className="w-32" value={draft.insights.dailySummaryTime} onChange={(v) => update((d) => ({ ...d, insights: { ...d.insights, dailySummaryTime: v } }))} />}
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.pricing}</SectionLabel>
        <span className="text-small text-muted">{t.pricingHint}</span>
        {pricing.data && (
          <>
            <span className="truncate font-mono text-meta text-muted" title={pricing.data.path}>
              {t.pricingFile}: {pricing.data.path}
            </span>
            {pricing.data.error && <Notice tone="error">{pricing.data.error}</Notice>}
            {Object.keys(pricing.data.models).length === 0 ? (
              <span className="text-small text-muted">{t.pricingEmpty}</span>
            ) : (
              <Card className="overflow-x-auto">
                <table className="w-full border-collapse text-small">
                  <thead>
                    <tr className="text-left text-text-3">
                      <th className="px-3 py-2 font-medium">{t.pricingModel}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.pricingInput}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.pricingOutput}</th>
                      <th className="px-3 py-2 text-right font-medium">{t.pricingCacheRead}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(pricing.data.models).map(([model, price]) => (
                      <tr key={model} className="border-t border-border-subtle text-text-2">
                        <td className="px-3 py-1.5 font-mono">{model}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCurrencyUsd(price.input)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCurrencyUsd(price.output)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCurrencyUsd(price.cacheRead)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ProjectsSection({ draft, update, errors }: HubSectionProps) {
  const s = useStrings();
  const t = s.settingsPage.projects;

  async function addFolder() {
    const [folder] = await pickFolders(s.projects.addFolderTitle);
    if (!folder) return;
    try {
      const { root } = await hubRequest<{ root: string }>("POST", "/v1/projects/folders", { path: folder });
      useToastStore.getState().show(t.added(root));
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Field label={t.tasksGlob} hint={t.tasksGlobHint} error={errors.tasksGlob}>
        {(ids) => <TextInput {...ids} value={draft.tasksGlob} onChange={(tasksGlob) => update((d) => ({ ...d, tasksGlob }))} />}
      </Field>
      <div className="flex flex-col gap-3">
        <SectionLabel>{t.folders}</SectionLabel>
        <span className="text-small text-muted">{t.foldersHint}</span>
        <div>
          <Button onClick={() => void addFolder()}>{t.addFolder}</Button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <SectionLabel>{t.git}</SectionLabel>
        <Checkbox checked={draft.insights.gitEnabled} onChange={(v) => update((d) => ({ ...d, insights: { ...d.insights, gitEnabled: v } }))} label={t.gitEnabled} />
        <Field label={t.uncommittedThreshold} error={errors["insights.uncommittedThreshold"]}>
          {(ids) => <NumberInput {...ids} value={draft.insights.uncommittedThreshold} onChange={(n) => update((d) => ({ ...d, insights: { ...d.insights, uncommittedThreshold: n } }))} />}
        </Field>
      </div>
    </div>
  );
}

export function TasksSection({ draft, update, errors }: HubSectionProps) {
  const t = useStrings().settingsPage.tasks;
  return (
    <div className="flex flex-col gap-6">
      <Field label={t.hotkey} hint={t.hotkeyHint} error={errors["tasks.hotkey"]}>
        {(ids) => <TextInput {...ids} value={draft.tasks.hotkey} onChange={(hotkey) => update((d) => ({ ...d, tasks: { ...d.tasks, hotkey } }))} />}
      </Field>
      <Checkbox checked={draft.tasks.reminders} onChange={(reminders) => update((d) => ({ ...d, tasks: { ...d.tasks, reminders } }))} label={t.reminders} />
    </div>
  );
}

export function DictationSection({ draft, update, errors }: HubSectionProps) {
  const s = useStrings();
  const t = s.settingsPage.dictation;
  const d = draft.dictation;
  const set = (patch: Partial<DictationSettings>) => update((x) => ({ ...x, dictation: { ...x.dictation, ...patch } }));

  return (
    <div className="flex flex-col gap-6">
      <Checkbox checked={d.enabled} onChange={(enabled) => set({ enabled })} label={t.enabled} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.hotkey} error={errors["dictation.hotkey"]}>
          {(ids) => <TextInput {...ids} value={d.hotkey} onChange={(hotkey) => set({ hotkey })} />}
        </Field>
        <Field label={t.pasteLastHotkey} error={errors["dictation.pasteLastHotkey"]}>
          {(ids) => <TextInput {...ids} value={d.pasteLastHotkey} onChange={(pasteLastHotkey) => set({ pasteLastHotkey })} />}
        </Field>
        <Field label={t.model}>
          {(ids) => (
            <Select<DictationSettings["model"]>
              {...ids}
              value={d.model}
              onChange={(model) => set({ model })}
              options={[
                { value: "large", label: s.dictation.modelNames.large },
                { value: "small", label: s.dictation.modelNames.small },
              ]}
            />
          )}
        </Field>
        <Field label={t.language}>
          {(ids) => (
            <Select<DictationSettings["language"]>
              {...ids}
              value={d.language}
              onChange={(language) => set({ language })}
              options={[
                { value: "tr", label: t.languages.tr },
                { value: "en", label: t.languages.en },
                { value: "auto", label: t.languages.auto },
              ]}
            />
          )}
        </Field>
      </div>
      <Checkbox checked={d.useGpu} onChange={(useGpu) => set({ useGpu })} label={t.useGpu} />
      <Field label={t.vocabulary} hint={t.vocabularyHint}>
        {(ids) => <TextArea {...ids} value={d.vocabulary} onChange={(vocabulary) => set({ vocabulary })} />}
      </Field>

      <div className="flex flex-col gap-3">
        <Checkbox checked={d.aiCleanup} onChange={(aiCleanup) => set({ aiCleanup })} label={t.aiCleanup} hint={t.aiCleanupHint} />
        {d.aiCleanup && (
          <div className="flex flex-col gap-4 pl-6">
            {draft.ai && (
              <div className="flex flex-wrap items-center gap-2 text-body text-text-2">
                <span>{s.ai.dictationProvider(draft.ai.dictationCleanup.model ? `${draft.ai.dictationCleanup.provider} · ${draft.ai.dictationCleanup.model}` : draft.ai.dictationCleanup.provider)}</span>
                <Button small variant="ghost" onClick={() => useSettingsPageStore.getState().setSection("ai")}>
                  {s.ai.openAiSettings}
                </Button>
              </div>
            )}
            <Field label={t.mode}>
              {(ids) => (
                <Select<DictationSettings["mode"]>
                  {...ids}
                  value={d.mode}
                  onChange={(mode) => set({ mode })}
                  options={(["Clean", "Message", "Email", "Custom"] as const).map((m) => ({ value: m, label: t.modes[m] }))}
                />
              )}
            </Field>
            {d.mode === "Custom" && (
              <Field label={t.customPrompt}>
                {(ids) => <TextArea {...ids} value={d.customPrompt} onChange={(customPrompt) => set({ customPrompt })} />}
              </Field>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SectionLabel>{t.outputs}</SectionLabel>
        <Checkbox checked={d.outputFocused} onChange={(outputFocused) => set({ outputFocused })} label={t.outputFocused} />
        {d.outputFocused && (
          <div className="w-48 pl-6">
            <Field label={t.insertMethod}>
              {(ids) => (
                <Select<DictationSettings["insertMethod"]>
                  {...ids}
                  value={d.insertMethod}
                  onChange={(insertMethod) => set({ insertMethod })}
                  options={[
                    { value: "paste", label: t.insertMethods.paste },
                    { value: "type", label: t.insertMethods.type },
                  ]}
                />
              )}
            </Field>
          </div>
        )}
        <Checkbox checked={d.outputClipboard} onChange={(outputClipboard) => set({ outputClipboard })} label={t.outputClipboard} />
        <Checkbox checked={d.outputFile} onChange={(outputFile) => set({ outputFile })} label={t.outputFile} />
        {d.outputFile && (
          <div className="pl-6">
            <Field label={t.filePath} error={errors["dictation.filePath"]}>
              {(ids) => <TextInput {...ids} value={d.filePath} onChange={(filePath) => set({ filePath })} />}
            </Field>
          </div>
        )}
      </div>

      <Checkbox checked={d.soundCues} onChange={(soundCues) => set({ soundCues })} label={t.soundCues} />
      <Field label={t.maxMinutes} error={errors["dictation.maxMinutes"]}>
        {(ids) => <NumberInput {...ids} value={d.maxMinutes} onChange={(maxMinutes) => set({ maxMinutes })} />}
      </Field>
      <Checkbox checked={d.keepHistory} onChange={(keepHistory) => set({ keepHistory })} label={t.keepHistory} />
    </div>
  );
}
