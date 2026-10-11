/**
 * Settings screen (M2): replaces the old Settings dialog. Left: section list; right: the
 * section. App sections apply immediately (desktop `settings.json`); hub sections edit a draft
 * of `/v1/settings` that the save bar validates and sends back as a whole.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { create } from "zustand";
import { useStrings } from "../../app/i18n";
import { dictationReload, hubRequest } from "../../lib/ipc";
import type { AiSettings, HubSettings } from "../../lib/hubTypes";
import { AiSection } from "./AiSection";
import { MascotSection } from "./MascotSection";
import { useMascotSettingsStore } from "./mascotSettings";
import { AboutSection, AgentsSection, AppearanceSection, EditorSection, FilesSection, TerminalSection } from "./AppSections";
import { Button, Notice, Page, PageHeader } from "./controls";
import { DictationSection, NotificationsSection, ProjectsSection, TasksSection, UsageSection, type HubSectionProps } from "./HubSections";
import { asAppError, useHubResource } from "./hubData";
import { validateHubSettings } from "./hubSettings";
import { validateAi } from "./aiSettings";

export type SettingsSectionId =
  | "appearance"
  | "mascot"
  | "editor"
  | "terminal"
  | "files"
  | "agents"
  | "ai"
  | "notifications"
  | "usage"
  | "projects"
  | "tasks"
  | "dictation"
  | "about";

type Section = { id: SettingsSectionId; app: ComponentType } | { id: SettingsSectionId; hub: ComponentType<HubSectionProps> };

const SECTIONS: readonly Section[] = [
  { id: "appearance", app: AppearanceSection },
  { id: "mascot", app: MascotSection },
  { id: "editor", app: EditorSection },
  { id: "terminal", app: TerminalSection },
  { id: "files", app: FilesSection },
  { id: "agents", app: AgentsSection },
  { id: "ai", hub: AiSection },
  { id: "notifications", hub: NotificationsSection },
  { id: "usage", hub: UsageSection },
  { id: "projects", hub: ProjectsSection },
  { id: "tasks", hub: TasksSection },
  { id: "dictation", hub: DictationSection },
  { id: "about", app: AboutSection },
];

/** Selected section; kept across route switches and settable from elsewhere (e.g. "Open settings → Agents"). */
export const useSettingsPageStore = create<{ section: SettingsSectionId; setSection: (s: SettingsSectionId) => void }>((set) => ({
  section: "appearance",
  setSection: (section) => set({ section }),
}));

/** Section that shows a settings field, by the field path's first segment (hub `fields` keys). */
export function sectionForField(field: string): SettingsSectionId | null {
  if (field === "tasksGlob" || field === "insights.uncommittedThreshold") return "projects";
  if (field === "insights.dailySummaryTime") return "usage";
  const head = field.split(".")[0];
  switch (head) {
    case "rules":
    case "quietHours":
      return "notifications";
    case "usageRules":
      return "usage";
    case "tasks":
      return "tasks";
    case "ai":
      return "ai";
    case "dictation":
      return "dictation";
    case "buddy":
      return "mascot";
    default:
      return null;
  }
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

export function SettingsPage() {
  const s = useStrings();
  const t = s.settingsPage;
  const section = useSettingsPageStore((st) => st.section);
  const setSection = useSettingsPageStore((st) => st.setSection);
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]!;

  const hub = useHubResource<HubSettings>("/v1/settings");
  const [draft, setDraft] = useState<HubSettings | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  // A fresh load (first time, or after the hub came back) replaces the draft unless it has edits.
  const [base, setBase] = useState<HubSettings | null>(null);
  useEffect(() => {
    if (!hub.data) return;
    setBase(hub.data);
    setDraft((d) => (d === null || (base !== null && JSON.stringify(d) === JSON.stringify(base)) ? hub.data : d));
    // `base` is read only to decide whether the draft is untouched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hub.data]);

  // Mascot settings are saved at once elsewhere (Mascot section, the mascot's menu and drag):
  // take their `buddy` into base and draft so a later draft save sends the current values back
  // and the save bar doesn't count them as edits.
  const mascotBuddy = useMascotSettingsStore((st) => st.settings?.buddy);
  useEffect(() => {
    if (!mascotBuddy) return;
    setBase((b) => (b ? { ...b, buddy: mascotBuddy } : b));
    setDraft((d) => (d ? { ...d, buddy: mascotBuddy } : d));
  }, [mascotBuddy]);

  const dirty = draft !== null && base !== null && JSON.stringify(draft) !== JSON.stringify(base);
  // Field messages from the hub's last rejection; cleared on the next edit.
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const clientErrors = useMemo(() => (draft ? { ...validateHubSettings(draft, t), ...validateAi(draft.ai, s.ai.validation) } : {}), [draft, t, s.ai.validation]);
  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);
  const sectionsWithErrors = useMemo(() => new Set(Object.keys(errors).map(sectionForField)), [errors]);

  const update = useCallback((change: (d: HubSettings) => HubSettings) => {
    setDraft((d) => (d ? change(d) : d));
    setSave({ kind: "idle" });
    setServerErrors({});
  }, []);

  // AI endpoints are saved at once (on the last saved settings, not the draft's other edits);
  // the draft gets the same change so its unsaved edits stay.
  const commitAi = useCallback(
    async (change: (ai: AiSettings) => AiSettings) => {
      if (!base?.ai) throw new Error(t.loadFailed(""));
      const saved = await hubRequest<HubSettings>("PUT", "/v1/settings", { ...base, ai: change(base.ai) });
      setBase(saved);
      useMascotSettingsStore.getState().setFromHub(saved);
      setDraft((d) => (d?.ai && saved.ai ? { ...d, ai: { ...change(d.ai), providers: saved.ai.providers } } : saved));
    },
    [base, t],
  );

  async function saveDraft() {
    if (!draft) return;
    if (Object.keys(clientErrors).length > 0) {
      setSave({ kind: "failed", message: t.fixErrors });
      return;
    }
    setSave({ kind: "saving" });
    try {
      const saved = await hubRequest<HubSettings>("PUT", "/v1/settings", draft);
      setBase(saved);
      useMascotSettingsStore.getState().setFromHub(saved);
      setDraft(saved);
      setSave({ kind: "saved" });
      // Dictation shortcuts and options take effect without a restart (best effort).
      void dictationReload().catch(() => {});
    } catch (e) {
      const err = asAppError(e);
      setServerErrors(Object.fromEntries(Object.entries(err.fields ?? {}).map(([k, v]) => [k, t.serverFieldError(v.join("; "))])));
      setSave({ kind: "failed", message: err.message });
    }
  }

  function renderSection() {
    if ("app" in current) {
      const C = current.app;
      return <C />;
    }
    if (hub.unavailable) return <Notice tone="warning">{t.hubUnavailable}</Notice>;
    if (hub.error) return <Notice tone="error">{t.loadFailed(hub.error.message)}</Notice>;
    if (!draft) return null;
    const C = current.hub;
    return <C draft={draft} update={update} errors={errors} commitAi={commitAi} />;
  }

  return (
    <Page>
      <PageHeader title={t.title} />
      <div className="flex min-h-0 flex-1 gap-6">
        <nav aria-label={t.sectionsLabel} className="w-52 shrink-0">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {SECTIONS.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  aria-current={x.id === section ? "page" : undefined}
                  onClick={() => setSection(x.id)}
                  className={`w-full rounded-control px-3 py-2 text-left text-ui focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    x.id === section ? "bg-surface-4 font-medium text-text" : "bg-transparent text-text-3 hover:bg-surface-3 hover:text-text"
                  }`}
                >
                  {t.sections[x.id]}
                  {sectionsWithErrors.has(x.id) && (
                    <span role="img" aria-label={t.sectionHasErrors} title={t.sectionHasErrors} className="ml-2 inline-block size-1.5 rounded-full bg-blocked align-middle" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="m-0 text-title font-semibold text-text">{t.sections[current.id]}</h2>
          {"app" in current && current.id !== "about" && <span className="text-small text-muted">{t.appliedImmediately}</span>}
          {renderSection()}
          {"hub" in current && draft && (dirty || save.kind !== "idle") && (
            <div role="region" aria-label={t.save} className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface-4 px-4 py-3 shadow-float">
              <span className={`flex-1 text-body ${save.kind === "failed" ? "text-blocked-ink" : "text-text-2"}`} role={save.kind === "failed" ? "alert" : "status"}>
                {save.kind === "saving" ? t.saving : save.kind === "saved" ? t.saved : save.kind === "failed" ? t.saveFailed(save.message) : t.unsaved}
              </span>
              {dirty && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft(base);
                      setServerErrors({});
                      setSave({ kind: "idle" });
                    }}
                  >
                    {t.discard}
                  </Button>
                  <Button variant="primary" disabled={save.kind === "saving"} onClick={() => void saveDraft()}>
                    {t.save}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
