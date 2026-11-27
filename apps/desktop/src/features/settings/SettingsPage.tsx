/**
 * Settings screen (M2): replaces the old Settings dialog. Left: section list; right: the
 * section. App sections apply immediately (desktop `settings.json`); hub sections edit a draft
 * of `/v1/settings` that the save bar validates and sends back as a whole.
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { create } from "zustand";
import { useStrings } from "../../app/i18n";
import { dictationReload, hubRequest } from "../../lib/ipc";
import type { AiSettings, HubSettings } from "../../lib/hubTypes";
import { AiSection } from "./AiSection";
import { NotificationAppSettings } from "./AgentsSection";
import { MascotSection } from "./MascotSection";
import { QuickCommandsSection } from "./QuickCommandsSection";
import { useMascotSettingsStore } from "./mascotSettings";
import { AboutSection, AgentsSection, AppearanceSection, EditorSection, FilesSection, TerminalSection } from "./AppSections";
import { Button, Notice, Page, PageHeader, TextInput } from "./controls";
import { DictationSection, NotificationsSection, ProjectsSection, TasksSection, UsageSection, type HubSectionProps } from "./HubSections";
import { asAppError, useHubResource } from "./hubData";
import { platformFeatures } from "../../lib/platform";
import type { PlatformFeatures } from "../../lib/ipc";
import { validateHubSettings } from "./hubSettings";
import { validateAi } from "./aiSettings";
import { sectionMatches } from "./settingsSearch";

export type SettingsSectionId =
  | "appearance"
  | "mascot"
  | "editor"
  | "terminal"
  | "quickCommands"
  | "files"
  | "agents"
  | "ai"
  | "notifications"
  | "usage"
  | "projects"
  | "tasks"
  | "dictation"
  | "about";

/** `needs`: shown only where that OS feature exists (U-2). */
type Section = ({ id: SettingsSectionId; app: ComponentType } | { id: SettingsSectionId; hub: ComponentType<HubSectionProps> }) & {
  needs?: keyof PlatformFeatures;
};

const SECTIONS: readonly Section[] = [
  { id: "appearance", app: AppearanceSection },
  { id: "mascot", app: MascotSection, needs: "mascot" },
  { id: "editor", app: EditorSection },
  { id: "terminal", app: TerminalSection },
  { id: "quickCommands", app: QuickCommandsSection },
  { id: "files", app: FilesSection },
  { id: "agents", app: AgentsSection },
  { id: "ai", hub: AiSection },
  { id: "notifications", hub: NotificationsSection },
  { id: "usage", hub: UsageSection },
  { id: "projects", hub: ProjectsSection },
  { id: "tasks", hub: TasksSection },
  { id: "dictation", hub: DictationSection, needs: "dictation" },
  { id: "about", app: AboutSection },
];

function visibleSections(): readonly Section[] {
  const features = platformFeatures();
  return SECTIONS.filter((x) => !x.needs || features[x.needs]);
}

/** Selected section; kept across route switches and settable from elsewhere (e.g. "Open settings → Agents"). */
export const useSettingsPageStore = create<{ section: SettingsSectionId; setSection: (s: SettingsSectionId) => void }>((set) => ({
  section: "appearance",
  setSection: (section) => set({ section }),
}));

/** Section that shows a settings field, by the field path's first segment (hub `fields` keys). */
export function sectionForField(field: string): SettingsSectionId | null {
  if (field === "tasksGlob" || field === "insights.uncommittedThreshold") return "projects";
  if (field === "insights.dailySummaryTime") return "usage";
  if (field === "insights.gitEnabled") return "projects";
  if (field === "dictation.aiCleanup") return "ai";
  // M7: the assistant's on/off and shortcut sit in the AI section; the rest of `buddy` is the mascot.
  if (field === "buddy.enabled" || field === "buddy.hotkey") return "ai";
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

/** Nav groups (faint labels above the section buttons). */
const NAV_GROUPS: readonly { key: "interface" | "agentsAi" | "workspace"; ids: readonly SettingsSectionId[] }[] = [
  { key: "interface", ids: ["appearance", "mascot", "editor", "terminal", "quickCommands", "files"] },
  { key: "agentsAi", ids: ["agents", "ai", "notifications", "usage"] },
  { key: "workspace", ids: ["projects", "tasks", "dictation", "about"] },
];

/** Hub sections whose draft differs from the saved settings (for the unsaved dot). */
export function sectionsWithEdits(draft: HubSettings | null, base: HubSettings | null): Set<SettingsSectionId> {
  const out = new Set<SettingsSectionId>();
  if (!draft || !base) return out;
  const d = draft as unknown as Record<string, unknown>;
  const b = base as unknown as Record<string, unknown>;
  const differs = (x: unknown, y: unknown) => JSON.stringify(x) !== JSON.stringify(y);
  for (const key of new Set([...Object.keys(d), ...Object.keys(b)])) {
    if (!differs(d[key], b[key])) continue;
    if (key === "insights" || key === "buddy" || key === "dictation") {
      const dv = (d[key] ?? {}) as Record<string, unknown>;
      const bv = (b[key] ?? {}) as Record<string, unknown>;
      for (const sub of new Set([...Object.keys(dv), ...Object.keys(bv)])) {
        if (!differs(dv[sub], bv[sub])) continue;
        // Mascot settings are saved at once elsewhere; only the assistant's fields live in the draft.
        out.add(sub === "dailySummaryWithoutAi" ? "ai" : (sectionForField(`${key}.${sub}`) ?? (key === "insights" ? "usage" : key === "dictation" ? "dictation" : "mascot")));
      }
    } else {
      out.add(sectionForField(key) ?? "notifications");
    }
  }
  return out;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

export function SettingsPage() {
  const s = useStrings();
  const t = s.settingsPage;
  const section = useSettingsPageStore((st) => st.section);
  const setSection = useSettingsPageStore((st) => st.setSection);
  const sections = visibleSections();
  const [filter, setFilter] = useState("");
  const shown = sections.filter((x) => sectionMatches(s, x.id, filter));
  const current = sections.find((x) => x.id === section) ?? sections[0]!;

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
  // and the save bar doesn't count them as edits. The assistant's fields (`enabled`, `hotkey`)
  // are edited in the draft (Settings → AI), so the draft keeps its own values for those.
  const mascotBuddy = useMascotSettingsStore((st) => st.settings?.buddy);
  useEffect(() => {
    if (!mascotBuddy) return;
    setBase((b) => (b ? { ...b, buddy: mascotBuddy } : b));
    setDraft((d) => (d ? { ...d, buddy: { ...mascotBuddy, enabled: d.buddy.enabled, hotkey: d.buddy.hotkey } } : d));
  }, [mascotBuddy]);

  const dirty = draft !== null && base !== null && JSON.stringify(draft) !== JSON.stringify(base);
  // Field messages from the hub's last rejection; cleared on the next edit.
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const clientErrors = useMemo(() => (draft ? { ...validateHubSettings(draft, t), ...validateAi(draft.ai, s.ai.validation) } : {}), [draft, t, s.ai.validation]);
  const errors = useMemo(() => ({ ...serverErrors, ...clientErrors }), [serverErrors, clientErrors]);
  const sectionsWithErrors = useMemo(() => new Set(Object.keys(errors).map(sectionForField)), [errors]);
  const editedSections = useMemo(() => sectionsWithEdits(draft, base), [draft, base]);

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
    // The desktop-stored notification switches do not depend on the hub: show them even when it is down.
    const appPart = current.id === "notifications" ? <NotificationAppSettings /> : null;
    const withApp = (node: ReactNode) => (appPart ? <div className="flex flex-col gap-6">{appPart}{node}</div> : node);
    if (hub.unavailable) return withApp(<Notice tone="warning">{t.hubUnavailable}</Notice>);
    if (hub.error) return withApp(<Notice tone="error">{t.loadFailed(hub.error.message)}</Notice>);
    if (!draft) return appPart;
    const C = current.hub;
    return withApp(<C draft={draft} saved={base ?? undefined} update={update} errors={errors} commitAi={commitAi} />);
  }

  return (
    <Page>
      <PageHeader title={t.title} />
      <div className="flex min-h-0 flex-1 gap-6">
        <nav aria-label={t.sectionsLabel} className="flex w-52 shrink-0 flex-col gap-3">
          <TextInput type="search" value={filter} onChange={setFilter} ariaLabel={t.filterLabel} placeholder={t.filterPlaceholder} />
          {filter.trim() !== "" && shown.length === 0 && <span className="px-1 text-small text-muted">{t.noMatch}</span>}
          {NAV_GROUPS.map((g) => {
            const items = shown.filter((x) => g.ids.includes(x.id));
            if (items.length === 0) return null;
            return (
              <div key={g.key} className="flex flex-col gap-0.5">
                <span data-section-label className="px-3 pb-1 text-label font-semibold uppercase tracking-[0.08em] text-muted">{t.navGroups[g.key]}</span>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                  {items.map((x) => (
                    <li key={x.id}>
                      <button
                        type="button"
                        aria-current={x.id === section ? "page" : undefined}
                        aria-description={editedSections.has(x.id) ? t.hasUnsavedChanges : undefined}
                        onClick={() => setSection(x.id)}
                        className={`relative w-full rounded-control px-3 py-2 text-left text-ui focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                          x.id === section ? "bg-accent-soft font-medium text-text" : "bg-transparent text-text-3 hover:bg-surface-3 hover:text-text"
                        }`}
                      >
                        {x.id === section && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                        {t.sections[x.id]}
                        {sectionsWithErrors.has(x.id) && (
                          <span role="img" aria-label={t.sectionHasErrors} title={t.sectionHasErrors} className="ml-2 inline-block size-1.5 rounded-full bg-blocked align-middle" />
                        )}
                        {editedSections.has(x.id) && (
                          <span aria-hidden="true" title={t.hasUnsavedChanges} className="ml-2 inline-block size-1.5 rounded-full bg-accent align-middle" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="m-0 text-title font-semibold text-text">{t.sections[current.id]}</h2>
          {"app" in current && current.id !== "about" && <span className="text-small text-muted">{t.appliedImmediately}</span>}
          {"hub" in current && current.id !== "ai" && <span className="text-small text-muted">{t.needsSaveNote}</span>}
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
