/**
 * Settings → Notifications → "Watch rules": master switch, the built-in rules (use / notify),
 * the user's own rules (add / edit / delete), a box that tries a command against the hub's
 * evaluator, and the projects that bring a `.kotilo/watch.json`. Edits go to the shared
 * settings draft (`settings.watch`); the page's save bar sends them. The overview and the
 * test box talk to the hub directly and use the saved rules.
 */
import { useState } from "react";
import { useStrings } from "../../app/i18n";
import { hubRequest } from "../../lib/ipc";
import type { WatchHit, WatchOverview, WatchRule, WatchSettings, WatchTestResult } from "../../lib/hubTypes";
import { Button, Checkbox, Field, Notice, SectionLabel, TextInput } from "./controls";
import { useHubResource } from "./hubData";
import { checkRule, cleanRule, formatList, newRuleId, parseList, watchHitName, watchOf } from "./watchRules";
import type { HubSectionProps } from "./HubSections";

interface RuleForm {
  /** Index into the user rules, or null for a new rule. */
  index: number | null;
  id: string;
  name: string;
  tools: string;
  command: string;
  paths: string;
  notify: boolean;
  enabled: boolean;
}

const NEW_FORM: RuleForm = { index: null, id: "", name: "", tools: "", command: "", paths: "", notify: true, enabled: true };

function toggled(list: readonly string[], id: string, on: boolean): string[] {
  const without = list.filter((x) => x !== id);
  return on ? [...without, id] : without;
}

function RuleEditor({
  form,
  onChange,
  onSave,
  onCancel,
  takenIds,
}: {
  form: RuleForm;
  onChange: (f: RuleForm) => void;
  onSave: (rule: WatchRule) => void;
  onCancel: () => void;
  takenIds: string[];
}) {
  const w = useStrings().watch.settings;
  const [touched, setTouched] = useState(false);
  const rule: WatchRule = {
    id: form.id,
    name: form.name,
    enabled: form.enabled,
    notify: form.notify,
    tools: parseList(form.tools),
    command: form.command,
    paths: parseList(form.paths),
  };
  const issues = checkRule(rule, w);
  const blocked = !!(issues.name || issues.match);
  return (
    <div role="group" aria-label={form.index === null ? w.add : w.edit(form.name)} className="flex flex-col gap-3 rounded-card border border-border bg-surface-3 p-3">
      <Field label={w.name} error={touched ? (issues.name ?? null) : null}>
        {(ids) => <TextInput {...ids} value={form.name} onChange={(name) => onChange({ ...form, name })} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={w.tools} hint={w.toolsHint}>
          {(ids) => <TextInput {...ids} value={form.tools} onChange={(tools) => onChange({ ...form, tools })} />}
        </Field>
        <Field label={w.paths} hint={w.pathsHint}>
          {(ids) => <TextInput {...ids} value={form.paths} onChange={(paths) => onChange({ ...form, paths })} className="w-full font-mono" />}
        </Field>
      </div>
      <Field label={w.command} hint={w.commandHint} error={touched ? (issues.match ?? null) : null}>
        {(ids) => <TextInput {...ids} value={form.command} onChange={(command) => onChange({ ...form, command })} className="w-full font-mono" />}
      </Field>
      {issues.regex && <Notice tone="warning">{issues.regex}</Notice>}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox checked={form.enabled} onChange={(enabled) => onChange({ ...form, enabled })} label={w.ruleEnabledLabel} />
        <Checkbox checked={form.notify} onChange={(notify) => onChange({ ...form, notify })} label={w.ruleNotifyLabel} />
      </div>
      <div className="flex gap-2">
        <Button
          small
          variant="primary"
          onClick={() => {
            setTouched(true);
            if (blocked) return;
            const id = form.index === null ? newRuleId(form.name, takenIds) : form.id;
            onSave(cleanRule({ ...rule, id }));
          }}
        >
          {w.save}
        </Button>
        <Button small variant="ghost" onClick={onCancel}>
          {w.cancel}
        </Button>
      </div>
    </div>
  );
}

function TestBox() {
  const w = useStrings().watch;
  const [tool, setTool] = useState("Bash");
  const [command, setCommand] = useState("");
  const [path, setPath] = useState("");
  const [result, setResult] = useState<WatchHit[] | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const body = { ...(tool.trim() && { tool: tool.trim() }), ...(command.trim() && { command }), ...(path.trim() && { path: path.trim() }) };
      const r = await hubRequest<WatchTestResult>("POST", "/v1/watch/test", body);
      setResult(r?.matches ?? []);
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={w.settings.test}>
      <span className="text-small font-medium text-text-3">{w.settings.test}</span>
      <span className="text-meta text-muted">{w.settings.testIntro}</span>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr]">
        <Field label={w.settings.testTool}>{(ids) => <TextInput {...ids} value={tool} onChange={setTool} />}</Field>
        <Field label={w.settings.testCommand}>{(ids) => <TextInput {...ids} value={command} onChange={setCommand} className="w-full font-mono" />}</Field>
        <Field label={w.settings.testPath}>{(ids) => <TextInput {...ids} value={path} onChange={setPath} className="w-full font-mono" />}</Field>
      </div>
      <div>
        <Button small onClick={() => void run()} disabled={busy}>
          {w.settings.testRun}
        </Button>
      </div>
      <div aria-live="polite">
        {result === "failed" && <Notice tone="error">{w.settings.testFailed}</Notice>}
        {Array.isArray(result) &&
          (result.length === 0 ? (
            <span className="text-ui text-text-2">{w.settings.testNone}</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-ui text-text-2">{w.settings.testMatches(result.length)}</span>
              <ul data-testid="watch-test-matches" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {result.map((h) => (
                  <li key={h.id} className="rounded-badge border border-working/45 bg-working-bg px-2.5 py-0.5 text-small font-semibold text-working-ink">
                    {watchHitName(h, w)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}

export function WatchRulesSettings({ draft, update }: Pick<HubSectionProps, "draft" | "update">) {
  const s = useStrings();
  const w = s.watch.settings;
  const watch = watchOf(draft);
  const overview = useHubResource<WatchOverview>("/v1/watch");
  const [form, setForm] = useState<RuleForm | null>(null);
  const setWatch = (patch: Partial<WatchSettings>) => update((d) => ({ ...d, watch: { ...watchOf(d), ...patch } }));

  const builtins = overview.data?.builtins ?? [];
  const projects = overview.data?.projects ?? [];
  const hubProblems = overview.data?.problems ?? [];

  function saveRule(rule: WatchRule) {
    if (!form) return;
    setWatch({ rules: form.index === null ? [...watch.rules, rule] : watch.rules.map((r, i) => (i === form.index ? rule : r)) });
    setForm(null);
  }

  return (
    <div className="flex flex-col gap-3" role="group" aria-label={w.title}>
      <SectionLabel>{w.title}</SectionLabel>
      <span className="text-meta text-muted">{w.intro}</span>
      <Checkbox checked={watch.enabled} onChange={(enabled) => setWatch({ enabled })} label={w.enabled} />

      {watch.enabled && (
        <div className="flex flex-col gap-6 pl-6">
          {overview.error && !overview.unavailable && <Notice tone="warning">{w.loadFailed}</Notice>}

          {builtins.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-small font-medium text-text-3">{w.builtins}</span>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {builtins.map((b) => {
                  const name = watchHitName(b, s.watch);
                  const enabled = !watch.disabledBuiltins.includes(b.id);
                  const notify = !watch.notifyOffBuiltins.includes(b.id);
                  return (
                    <li key={b.id} className="flex flex-wrap items-center gap-x-6 gap-y-1">
                      <div className="min-w-[12rem] flex-1">
                        <Checkbox checked={enabled} onChange={(on) => setWatch({ disabledBuiltins: toggled(watch.disabledBuiltins, b.id, !on) })} label={name} />
                      </div>
                      <label className="flex items-center gap-2 text-small text-text-2">
                        <input
                          type="checkbox"
                          checked={notify}
                          disabled={!enabled}
                          aria-label={w.ruleNotify(name)}
                          onChange={(e) => setWatch({ notifyOffBuiltins: toggled(watch.notifyOffBuiltins, b.id, !e.target.checked) })}
                          className="size-4 accent-accent disabled:opacity-60"
                        />
                        {w.notify}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <span className="text-small font-medium text-text-3">{w.userRules}</span>
            {watch.rules.length === 0 && !form && <span className="text-small italic text-muted">{w.noUserRules}</span>}
            <ul aria-label={w.userRules} className="m-0 flex list-none flex-col gap-1.5 p-0">
              {watch.rules.map((r, i) => (
                <li key={r.id} className="flex items-center gap-2 rounded-control border border-border-subtle bg-surface-3 px-2.5 py-1.5">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={w.ruleEnabled(r.name)}
                    onChange={(e) => setWatch({ rules: watch.rules.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)) })}
                    className="size-4 shrink-0 accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui text-text">{r.name}</div>
                    <div className="truncate font-mono text-meta text-muted">
                      {[r.tools?.length ? w.summaryTools(formatList(r.tools)) : null, r.command ? w.summaryCommand(r.command) : null, r.paths?.length ? w.summaryPaths(formatList(r.paths)) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <Button
                    small
                    ariaLabel={w.edit(r.name)}
                    onClick={() => setForm({ index: i, id: r.id, name: r.name, tools: formatList(r.tools), command: r.command ?? "", paths: formatList(r.paths), notify: r.notify, enabled: r.enabled })}
                  >
                    {w.editButton}
                  </Button>
                  <Button small ariaLabel={w.remove(r.name)} onClick={() => setWatch({ rules: watch.rules.filter((_, j) => j !== i) })}>
                    {w.removeButton}
                  </Button>
                </li>
              ))}
            </ul>
            {form ? (
              <RuleEditor form={form} onChange={setForm} onSave={saveRule} onCancel={() => setForm(null)} takenIds={watch.rules.map((r) => r.id)} />
            ) : (
              <div>
                <Button small variant="primary" onClick={() => setForm(NEW_FORM)}>
                  {w.add}
                </Button>
              </div>
            )}
            {hubProblems.length > 0 && (
              <Notice tone="warning">
                <ul className="m-0 list-none p-0">
                  {hubProblems.map((p, i) => (
                    <li key={i}>{w.ruleInvalid(p.ruleId, p.message)}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>

          <TestBox />

          <div className="flex flex-col gap-2">
            <span className="text-small font-medium text-text-3">{w.projects}</span>
            <span className="text-meta text-muted">{w.projectsIntro}</span>
            {projects.length === 0 ? (
              <span className="text-small italic text-muted">{w.noProjects}</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {projects.map((p) => (
                  <li key={p.root} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        <Checkbox
                          checked={watch.trustedProjects.includes(p.root)}
                          onChange={(on) => setWatch({ trustedProjects: toggled(watch.trustedProjects, p.root, on) })}
                          label={p.root}
                          hint={w.useProjectLabel}
                        />
                      </div>
                      <span className="text-small text-text-2">{w.ruleCount(p.ruleCount)}</span>
                    </div>
                    {p.problems.length > 0 && (
                      <ul className="m-0 list-none pl-6 text-meta text-blocked-ink">
                        {p.problems.map((pr, i) => (
                          <li key={i}>{pr.line !== undefined ? w.problemLine(pr.line, pr.message) : pr.message}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
