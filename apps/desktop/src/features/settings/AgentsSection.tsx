/**
 * Settings → Agents (M3 wave 3): the user's launch commands, then one card per adapter from
 * the hub (`GET /v1/adapters`): hook integrations (install / repair / uninstall, state, config
 * file, approval and silent-hook hints), protocol adapters (no hooks: how to report), and
 * invalid user files with their error. Custom agents are added and edited with the wizard.
 */
import { useCallback, useMemo, useState } from "react";
import { HOOK_COMMAND } from "../../app/constants";
import { useStrings } from "../../app/i18n";
import { AgentAvatar } from "../../app/ui/AgentAvatar";
import { ConfirmModal } from "../../app/ConfirmModal";
import { agentsDeleteUserDefinition, hooksInstall, hooksStatus, hooksUninstall, hubRequest, type UserAdapterDefinition } from "../../lib/ipc";
import type { AdapterDto } from "../../lib/hubTypes";
import { useAgentStore } from "../../stores/agentStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";
import { useHelpStore } from "../help/helpStore";
import { Button, Card, Checkbox, Notice, SectionLabel } from "./controls";
import { CodeBlock, CustomAgentWizard, userAdapterPath } from "./CustomAgentWizard";
import { protocolExample } from "./customAgent";
import { EditableList } from "./EditableList";
import { asAppError, useHubResource } from "./hubData";

type WizardState = { editing: UserAdapterDefinition | null } | null;

function Badge({ tone, children }: { tone: "ok" | "warn" | "neutral" | "error"; children: string }) {
  const cls =
    tone === "ok" ? "bg-idle-bg text-idle-ink" : tone === "warn" ? "bg-working-bg text-working-ink" : tone === "error" ? "bg-blocked-bg text-blocked-ink" : "bg-surface-5 text-text-3";
  return <span className={`whitespace-nowrap rounded-badge px-1.5 py-0.5 text-meta ${cls}`}>{children}</span>;
}

function CardHeader({ adapter, installed }: { adapter: AdapterDto; installed: boolean | null }) {
  const s = useStrings();
  const t = s.agentSetup;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <AgentAvatar agent={adapter.id} size={30} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-title font-semibold text-text">{adapter.displayName || adapter.id}</span>
        <span className="truncate font-mono text-meta text-muted">
          {adapter.id} · {t.source[adapter.source]}
          {installed !== null && !adapter.error && ` · ${installed ? t.installed : t.notInstalled}`}
        </span>
      </div>
    </div>
  );
}

/** Hook-based agent: state, config file, install / repair / uninstall. */
function HookCard({ adapter, installed, onChanged }: { adapter: AdapterDto; installed: boolean | null; onChanged: () => Promise<void> }) {
  const s = useStrings();
  const t = s.settingsPage.agents;
  const a = s.agentSetup;
  const [busy, setBusy] = useState(false);
  const hooks = adapter.hooks!;
  const state = hooks.state;
  const isInstalled = state === "installed" || state === "outdated";
  const screenPermission = adapter.definition?.screenRules?.some((r) => r.state === "waitingPermission") ?? false;

  async function act(install: boolean) {
    setBusy(true);
    try {
      if (install) await hooksInstall(adapter.id);
      else await hooksUninstall(adapter.id);
      await onChanged();
      // Keep the workspace banner (Claude Code integration) in sync.
      if (adapter.id === "claude-code") useAgentStore.setState({ hooks: await hooksStatus() });
    } catch (e) {
      const err = asAppError(e);
      useToastStore.getState().show(err.code === "invalid_json" || err.code === "invalid_argument" ? err.message : s.errors.forCode(err.code));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <CardHeader adapter={adapter} installed={installed} />
        </div>
        <Badge tone={state === "installed" ? "ok" : state === "outdated" || state === "invalidConfig" ? "warn" : "neutral"}>{t.states[state]}</Badge>
      </div>
      {hooks.configPath && (
        <span className="truncate font-mono text-meta text-muted" title={hooks.configPath}>
          {t.configFile}: {hooks.configPath}
        </span>
      )}
      {isInstalled && hooks.needsApproval && <Notice tone="warning">{a.needsApproval(adapter.displayName)}</Notice>}
      {isInstalled && hooks.hint && <Notice tone="warning">{a.hints[hooks.hint]}</Notice>}
      {screenPermission && <span className="text-small text-muted">{a.screenPermission}</span>}
      {state !== "unsupported" && (
        <div className="flex flex-wrap gap-2">
          {!isInstalled && (
            <Button small variant="primary" disabled={busy || state === "invalidConfig"} onClick={() => void act(true)}>
              {t.install}
            </Button>
          )}
          {state === "outdated" && (
            <Button small variant="primary" disabled={busy} onClick={() => void act(true)}>
              {a.repair}
            </Button>
          )}
          {isInstalled && (
            <Button small variant="danger" disabled={busy} onClick={() => void act(false)}>
              {t.uninstall}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Hookless agent (every user adapter, and built-ins without an installer): how it reports. */
function ProtocolCard({
  adapter,
  installed,
  definition,
  onEdit,
  onDelete,
}: {
  adapter: AdapterDto;
  installed: boolean | null;
  definition: UserAdapterDefinition | undefined;
  onEdit: (def: UserAdapterDefinition) => void;
  onDelete: () => void;
}) {
  const s = useStrings();
  const a = s.agentSetup;
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <CardHeader adapter={adapter} installed={installed} />
        </div>
        <Badge tone="neutral">{a.protocol}</Badge>
      </div>
      <span className="text-small text-muted">{a.protocolHint}</span>
      <CodeBlock code={protocolExample(adapter.id)} label={`${adapter.displayName}: ${HOOK_COMMAND}`} />
      {adapter.source === "user" && (
        <div className="flex flex-wrap gap-2">
          {definition && (
            <Button small onClick={() => onEdit(definition)}>
              {a.edit}
            </Button>
          )}
          <Button small variant="danger" onClick={onDelete}>
            {a.delete}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** A definition that failed to load (invalid JSON or schema, id clash). */
function ErrorCard({ adapter, path, onDelete }: { adapter: AdapterDto; path: string | null; onDelete: () => void }) {
  const s = useStrings();
  const a = s.agentSetup;
  return (
    <Card className="flex min-w-0 flex-col gap-3 border-blocked/40 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-[240px] flex-1">
          <CardHeader adapter={adapter} installed={null} />
        </div>
        <Badge tone="error">{a.invalid}</Badge>
      </div>
      <p role="alert" className="m-0 break-words rounded-control border border-border-subtle bg-terminal px-3 py-2 font-mono text-small text-blocked-ink">
        {adapter.error}
      </p>
      <span className="text-small text-muted">{a.invalidHint}</span>
      <span className="truncate font-mono text-meta text-muted" title={path ?? undefined}>
        {a.file}: {path ?? userAdapterPath(adapter.id)}
      </span>
      {adapter.source === "user" && (
        <div className="flex flex-wrap gap-2">
          <Button small variant="danger" onClick={onDelete}>
            {a.delete}
          </Button>
        </div>
      )}
    </Card>
  );
}

export function AgentsSection() {
  const s = useStrings();
  const t = s.settingsPage.agents;
  const a = s.agentSetup;
  const agents = useSettingsStore((st) => st.settings.agents);
  const update = useSettingsStore((st) => st.update);
  const adapters = useHubResource<AdapterDto[]>("/v1/adapters");
  const definitions = useDefinitionsStore((st) => st.definitions);
  const definitionErrors = useDefinitionsStore((st) => st.errors);
  const installedIds = useDefinitionsStore((st) => st.installed);
  const [wizard, setWizard] = useState<WizardState>(null);
  const [reloading, setReloading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdapterDto | null>(null);

  const list = adapters.data ?? [];
  const builtinIds = useMemo(
    () => [...new Set([...definitions.filter((d) => d.source === "builtIn").map((d) => d.id), ...list.filter((x) => x.source === "builtIn").map((x) => x.id)])],
    [definitions, list],
  );
  const userIds = useMemo(
    () => [...new Set([...definitions.filter((d) => d.source === "user").map((d) => d.id), ...list.filter((x) => x.source === "user").map((x) => x.id)])],
    [definitions, list],
  );

  // Stable: the dialog refocuses its first field whenever `onCancel` changes.
  const reloadAdapters = adapters.reload;
  const closeWizard = useCallback(() => {
    setWizard(null);
    void reloadAdapters();
  }, [reloadAdapters]);

  async function reloadAll() {
    setReloading(true);
    const toast = useToastStore.getState();
    try {
      await useDefinitionsStore.getState().reload();
      await hubRequest("POST", "/v1/adapters/reload").catch(() => {});
      await adapters.reload();
      toast.show(a.reloaded);
    } catch (e) {
      toast.show(a.reloadFailed(asAppError(e).message));
    } finally {
      setReloading(false);
    }
  }

  async function deleteAdapter(adapter: AdapterDto) {
    setConfirmDelete(null);
    const toast = useToastStore.getState();
    try {
      useDefinitionsStore.getState().apply(await agentsDeleteUserDefinition(adapter.id));
      await hubRequest("POST", "/v1/adapters/reload").catch(() => {});
      await adapters.reload();
      toast.show(a.deleted(adapter.displayName || adapter.id));
    } catch (e) {
      toast.show(asAppError(e).message);
    }
  }

  function userDefinition(id: string): UserAdapterDefinition | undefined {
    const def = definitions.find((d) => d.id === id && d.source === "user");
    if (!def) return undefined;
    const { source: _source, ...rest } = def;
    return rest;
  }

  const installedOf = (id: string): boolean | null => (installedIds === null ? null : installedIds.includes(id));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-lg flex-col gap-1.5">
        <span className="text-small font-medium text-text-3">{s.settings.agents.commands}</span>
        <span className="text-small text-muted">{a.launchHint}</span>
        <EditableList
          items={agents.commands}
          onChange={(next) => update({ agents: { commands: next } })}
          reorder
          addPlaceholder={s.settings.agents.addCommandPlaceholder}
          addLabel={s.settings.agents.addCommand}
          removeLabel={s.settings.agents.removeCommand}
          emptyLabel={s.settings.agents.noCommands}
          listLabel={s.settings.agents.commands}
        />
      </div>
      <Checkbox checked={agents.notifications} onChange={(v) => update({ agents: { notifications: v } })} label={s.settings.agents.notifications} />

      <section aria-labelledby="settings-integrations" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel id="settings-integrations">{t.integrations}</SectionLabel>
          <div className="flex-1" />
          <Button small variant="ghost" onClick={() => useHelpStore.getState().openItemWithAnchor("user-guide.md", a.protocolHelpAnchor)}>
            {a.protocolHelp}
          </Button>
          <Button small disabled={reloading} onClick={() => void reloadAll()}>
            {a.reload}
          </Button>
          <Button small variant="primary" onClick={() => setWizard({ editing: null })}>
            {a.addCustom}
          </Button>
        </div>
        <span className="text-small text-muted">{t.integrationsHint}</span>
        {adapters.unavailable && <Notice tone="warning">{s.agents.banner.hubUnavailable}</Notice>}
        {adapters.error && !adapters.unavailable && <Notice tone="error">{adapters.error.message}</Notice>}
        {adapters.data && adapters.data.length === 0 && <span className="text-small text-muted">{t.none}</span>}
        <div className="grid gap-3 xl:grid-cols-2">
          {list.map((adapter, i) => {
            const key = `${adapter.source}:${adapter.id}:${i}`;
            if (adapter.error) {
              const path = definitionErrors.find((e) => e.id === adapter.id && e.source === adapter.source)?.path ?? null;
              return <ErrorCard key={key} adapter={adapter} path={path} onDelete={() => setConfirmDelete(adapter)} />;
            }
            if (adapter.hooks) return <HookCard key={key} adapter={adapter} installed={installedOf(adapter.id)} onChanged={adapters.reload} />;
            return (
              <ProtocolCard
                key={key}
                adapter={adapter}
                installed={installedOf(adapter.id)}
                definition={userDefinition(adapter.id)}
                onEdit={(def) => setWizard({ editing: def })}
                onDelete={() => setConfirmDelete(adapter)}
              />
            );
          })}
        </div>
      </section>

      {wizard && <CustomAgentWizard editing={wizard.editing} builtinIds={builtinIds} userIds={userIds} onClose={closeWizard} />}
      {confirmDelete && (
        <ConfirmModal
          title={a.deleteTitle(confirmDelete.displayName || confirmDelete.id)}
          body={a.deleteBody}
          confirmLabel={a.delete}
          onConfirm={() => void deleteAdapter(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
