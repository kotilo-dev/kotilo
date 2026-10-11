/**
 * "Add custom agent" wizard (M3 wave 3), also used to edit a user adapter. Five steps: name +
 * avatar, launch + detection, permission keys, screen rules, and the protocol snippet. Saving
 * goes through `agents_save_user_definition` (the desktop validates and writes
 * `%APPDATA%\kotilo\adapters\<id>\adapter.json`), then the hub reloads its copy.
 */
import { useMemo, useState, type ReactNode } from "react";
import { APP_SLUG, HOOK_COMMAND } from "../../app/constants";
import { useStrings } from "../../app/i18n";
import { agentsSaveUserDefinition, clipboardWriteText, hubRequest, type UserAdapterDefinition } from "../../lib/ipc";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useToastStore } from "../../stores/toastStore";
import { Button, Dialog, Field, Select, TextInput } from "./controls";
import {
  AVATAR_PALETTE,
  SCREEN_STATES,
  WIZARD_STEPS,
  emptyForm,
  errorsForStep,
  fromDefinition,
  httpSnippet,
  newRule,
  sidecarSnippet,
  suggestExecutables,
  toDefinition,
  validateForm,
  type CustomAgentForm,
  type FieldError,
  type RuleForm,
  type WizardStep,
} from "./customAgent";
import { asAppError } from "./hubData";

export interface CustomAgentWizardProps {
  /** The user adapter being edited; null adds a new one. */
  editing: UserAdapterDefinition | null;
  builtinIds: readonly string[];
  userIds: readonly string[];
  onClose: () => void;
  /** Tests / e2e: open on a later step. */
  initialStep?: WizardStep;
  /** Tests / e2e: start from this form. */
  initialForm?: CustomAgentForm;
}

/** `%APPDATA%\kotilo\adapters\<id>\adapter.json`, as the user sees it. */
export function userAdapterPath(id: string): string {
  return `%APPDATA%\\${APP_SLUG}\\adapters\\${id || "<id>"}\\adapter.json`;
}

export function CodeBlock({ code, label }: { code: string; label: string }) {
  const s = useStrings();
  return (
    <div className="relative min-w-0">
      <pre
        aria-label={label}
        className="m-0 overflow-x-auto whitespace-pre rounded-control border border-border-subtle bg-terminal px-3 py-2.5 pr-20 font-mono text-small leading-[1.6] text-text"
      >
        {code}
      </pre>
      <div className="absolute right-1.5 top-1.5">
        <Button
          small
          variant="secondary"
          ariaLabel={`${s.agentSetup.copy}: ${label}`}
          onClick={() => void clipboardWriteText(code).then(() => useToastStore.getState().show(s.agentSetup.copied), () => {})}
        >
          {s.agentSetup.copy}
        </Button>
      </div>
    </div>
  );
}

function Swatch({ bg, ink, letter, size = 30 }: { bg: string; ink: string; letter: string; size?: number }) {
  // User avatar colours are data (adapter.json hex), so they are applied inline.
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-button font-bold"
      style={{ width: size, height: size, background: bg, color: ink, fontSize: Math.round(size * 0.46) }}
    >
      {letter || "?"}
    </span>
  );
}

export function CustomAgentWizard({ editing, builtinIds, userIds, onClose, initialStep = "basics", initialForm }: CustomAgentWizardProps) {
  const s = useStrings();
  const t = s.agentSetup.wizard;
  const [form, setForm] = useState<CustomAgentForm>(() => initialForm ?? (editing ? fromDefinition(editing) : emptyForm()));
  const [step, setStep] = useState<WizardStep>(initialStep);
  const [shown, setShown] = useState<Set<WizardStep>>(() => new Set());
  const [executablesTouched, setExecutablesTouched] = useState(editing !== null || initialForm !== undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const errors = useMemo(
    () => validateForm(form, { builtinIds, userIds, editingId: editing?.id ?? null }),
    [form, builtinIds, userIds, editing],
  );
  const index = WIZARD_STEPS.indexOf(step);

  function set(patch: Partial<CustomAgentForm>) {
    setForm((f) => ({ ...f, ...patch }));
    setSaveError(null);
  }
  function setRule(i: number, patch: Partial<RuleForm>) {
    setForm((f) => ({ ...f, rules: f.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }

  function errorText(err: FieldError | undefined): string | null {
    if (!err) return null;
    if (err.kind === "invalid") return t.errors.invalid(err.message);
    return t.errors[err.kind];
  }
  /** A field's error, shown once the user tried to leave (or save) its step. */
  function fieldError(field: string, owner: WizardStep): string | null {
    return shown.has(owner) ? errorText(errors[field]) : null;
  }

  function next() {
    if (errorsForStep(errors, step).length > 0) {
      setShown((prev) => new Set(prev).add(step));
      return;
    }
    setStep(WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)]!);
  }

  async function save() {
    const blocking = WIZARD_STEPS.find((st) => st !== "finish" && errorsForStep(errors, st).length > 0);
    if (blocking) {
      setShown(new Set(WIZARD_STEPS));
      setStep(blocking);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const definition = toDefinition(form, editing);
    try {
      useDefinitionsStore.getState().apply(await agentsSaveUserDefinition(definition, editing !== null));
    } catch (e) {
      setSaveError(t.saveFailed(asAppError(e).message));
      setSaving(false);
      return;
    }
    const toast = useToastStore.getState();
    try {
      await hubRequest("POST", "/v1/adapters/reload");
      toast.show(s.agentSetup.saved(definition.displayName));
    } catch {
      toast.show(s.agentSetup.hubNotReloaded);
    }
    setSaving(false);
    onClose();
  }

  const swatchName = (key: (typeof AVATAR_PALETTE)[number]["key"]) => t.colors[key];

  let body: ReactNode;
  switch (step) {
    case "basics":
      body = (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.id} hint={t.idHint} error={fieldError("id", "basics")}>
            {(ids) =>
              editing ? (
                <span id={ids.id} className="rounded-control border border-border-subtle bg-surface-3 px-2 py-1.5 font-mono text-ui text-text-2">
                  {form.id}
                </span>
              ) : (
                <TextInput {...ids} value={form.id} onChange={(v) => set({ id: v.toLowerCase() })} placeholder="my-agent" />
              )
            }
          </Field>
          <Field label={t.displayName} error={fieldError("displayName", "basics")}>
            {(ids) => (
              <TextInput
                {...ids}
                value={form.displayName}
                onChange={(v) => set({ displayName: v, ...(form.letter === "" || form.letter === form.displayName.trim().charAt(0).toUpperCase() ? { letter: v.trim().charAt(0).toUpperCase() } : {}) })}
                placeholder="My Agent"
              />
            )}
          </Field>
          <Field label={t.letter} error={fieldError("letter", "basics")}>
            {(ids) => <TextInput {...ids} value={form.letter} onChange={(v) => set({ letter: v.slice(0, 2) })} className="w-16 text-center" />}
          </Field>
          <div className="flex flex-col gap-1.5">
            <span id="wizard-color-label" className="text-small font-medium text-text-3">
              {t.color}
            </span>
            <div role="radiogroup" aria-labelledby="wizard-color-label" className="flex flex-wrap gap-1.5">
              {AVATAR_PALETTE.map((p) => {
                const selected = form.bg === p.bg && form.ink === p.ink;
                return (
                  <button
                    key={p.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={swatchName(p.key)}
                    title={swatchName(p.key)}
                    onClick={() => set({ bg: p.bg, ink: p.ink })}
                    className={`rounded-[11px] border-2 p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${selected ? "border-accent" : "border-transparent"}`}
                  >
                    <Swatch bg={p.bg} ink={p.ink} letter={form.letter.trim()} size={26} />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2.5 sm:col-span-2">
            <span className="text-small font-medium text-text-3">{t.preview}</span>
            <Swatch bg={form.bg} ink={form.ink} letter={form.letter.trim()} />
            <span className="text-[13.5px] font-semibold text-text">{form.displayName.trim() || "My Agent"}</span>
          </div>
        </div>
      );
      break;
    case "launch":
      body = (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.command} hint={t.commandHint} error={fieldError("command", "launch")}>
            {(ids) => (
              <TextInput
                {...ids}
                value={form.command}
                onChange={(v) => set({ command: v, ...(executablesTouched ? {} : { executables: suggestExecutables(v) }) })}
                placeholder="my-agent"
              />
            )}
          </Field>
          <Field label={t.args} hint={t.argsHint}>
            {(ids) => <TextInput {...ids} value={form.args} onChange={(v) => set({ args: v })} placeholder="--yolo=false" />}
          </Field>
          <div className="sm:col-span-2">
            <Field label={t.executables} hint={t.executablesHint} error={fieldError("executables", "launch")}>
              {(ids) => (
                <TextInput
                  {...ids}
                  value={form.executables}
                  onChange={(v) => {
                    setExecutablesTouched(true);
                    set({ executables: v });
                  }}
                  placeholder="my-agent.exe, my-agent"
                />
              )}
            </Field>
          </div>
          <Field label={t.usage}>
            {(ids) => (
              <Select<CustomAgentForm["usage"]>
                {...ids}
                value={form.usage}
                onChange={(v) => set({ usage: v })}
                options={[
                  { value: "protocol", label: t.usageOptions.protocol },
                  { value: "none", label: t.usageOptions.none },
                ]}
              />
            )}
          </Field>
        </div>
      );
      break;
    case "keys":
      body = (
        <div className="flex flex-col gap-4">
          <p className="m-0 text-body text-text-2">{t.keysIntro}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t.allowOnce}>{(ids) => <TextInput {...ids} value={form.allowOnce} onChange={(v) => set({ allowOnce: v })} placeholder="y" />}</Field>
            <Field label={t.alwaysAllow}>{(ids) => <TextInput {...ids} value={form.alwaysAllow} onChange={(v) => set({ alwaysAllow: v })} />}</Field>
            <Field label={t.deny}>{(ids) => <TextInput {...ids} value={form.deny} onChange={(v) => set({ deny: v })} placeholder="Esc" />}</Field>
          </div>
          {fieldError("keys", "keys") && (
            <span role="alert" className="text-meta text-blocked-ink">
              {fieldError("keys", "keys")}
            </span>
          )}
          <p className="m-0 rounded-control border border-border-subtle bg-surface-3 px-3 py-2 text-small text-muted">{t.keyNotation}</p>
        </div>
      );
      break;
    case "rules":
      body = (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-body text-text-2">{t.rulesIntro}</p>
          {form.rules.length === 0 && <span className="text-small italic text-muted">{t.noRules}</span>}
          {form.rules.map((rule, i) => (
            <fieldset key={i} className="m-0 flex min-w-0 flex-col gap-3 rounded-card border border-border-subtle bg-surface-2 p-3">
              <legend className="sr-only">{t.rule(i + 1)}</legend>
              <div className="flex items-center gap-2">
                <span className="text-body font-semibold text-text">{t.rule(i + 1)}</span>
                <div className="flex-1" />
                <Button small variant="danger" ariaLabel={`${t.removeRule}: ${t.rule(i + 1)}`} onClick={() => set({ rules: form.rules.filter((_, j) => j !== i) })}>
                  {t.removeRule}
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_1.1fr_72px_1.2fr]">
                <Field label={t.ruleId} error={fieldError(`rules.${i}.id`, "rules")}>
                  {(ids) => <TextInput {...ids} value={rule.id} onChange={(v) => setRule(i, { id: v })} />}
                </Field>
                <Field label={t.state}>
                  {(ids) => (
                    <Select<RuleForm["state"]> {...ids} value={rule.state} onChange={(v) => setRule(i, { state: v })} options={SCREEN_STATES.map((st) => ({ value: st, label: t.states[st] }))} />
                  )}
                </Field>
                <Field label={t.lines} error={fieldError(`rules.${i}.lines`, "rules")}>
                  {(ids) => <TextInput {...ids} value={rule.lines} onChange={(v) => setRule(i, { lines: v })} placeholder="6" />}
                </Field>
                <Field label={t.clearOn}>
                  {(ids) => (
                    <Select<string>
                      {...ids}
                      value={rule.clearOn}
                      onChange={(v) => setRule(i, { clearOn: v as RuleForm["clearOn"] })}
                      options={[
                        { value: "", label: t.clearOnOptions.none },
                        { value: "output", label: t.clearOnOptions.output },
                        { value: "input", label: t.clearOnOptions.input },
                      ]}
                    />
                  )}
                </Field>
              </div>
              <Field label={t.pattern} hint={t.patternHint} error={fieldError(`rules.${i}.pattern`, "rules")}>
                {(ids) => <TextInput {...ids} value={rule.pattern} onChange={(v) => setRule(i, { pattern: v })} className="w-full font-mono" placeholder="Allow this command\? \(y/n\)" />}
              </Field>
            </fieldset>
          ))}
          <div>
            <Button small onClick={() => set({ rules: [...form.rules, newRule(form.rules)] })}>
              {t.addRule}
            </Button>
          </div>
        </div>
      );
      break;
    case "finish":
      body = (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 text-body text-text-2">{t.finishIntro(userAdapterPath(form.id.trim()))}</p>
          <CodeBlock code={sidecarSnippet(form.id.trim())} label={HOOK_COMMAND} />
          <p className="m-0 text-body text-text-2">{t.httpIntro}</p>
          <CodeBlock code={httpSnippet(form.id.trim())} label="POST /v1/events" />
        </div>
      );
      break;
  }

  return (
    <Dialog
      wide
      title={editing ? t.titleEdit(editing.displayName) : t.titleNew}
      onCancel={onClose}
      footer={
        <>
          {saveError && (
            <span role="alert" className="mr-auto self-center text-small text-blocked-ink">
              {saveError}
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          {index > 0 && <Button onClick={() => setStep(WIZARD_STEPS[index - 1]!)}>{t.back}</Button>}
          {step === "finish" ? (
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? t.saving : t.save}
            </Button>
          ) : (
            <Button variant="primary" onClick={next}>
              {t.next}
            </Button>
          )}
        </>
      }
    >
      <ol aria-label={t.stepsLabel} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {WIZARD_STEPS.map((st, i) => {
          const current = st === step;
          const done = i < index;
          return (
            <li
              key={st}
              aria-current={current ? "step" : undefined}
              className={`flex items-center gap-1.5 rounded-badge px-2 py-1 text-meta ${current ? "bg-accent-soft font-semibold text-text" : done ? "text-text-2" : "text-muted"}`}
            >
              <span className={`inline-flex size-4 items-center justify-center rounded-full font-mono text-label ${current ? "bg-accent text-on-accent" : "bg-surface-5 text-text-3"}`}>{i + 1}</span>
              {t.steps[st]}
            </li>
          );
        })}
      </ol>
      <span className="sr-only" aria-live="polite">
        {t.stepOf(index + 1, WIZARD_STEPS.length)}
      </span>
      {body}
    </Dialog>
  );
}
