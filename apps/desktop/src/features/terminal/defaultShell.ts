/**
 * Saf yardımcı (faz6-spec §1.4/§7/§10.2): ayarlardaki `defaultShell` yalnızca frontend'de
 * kullanılır — bu makinede tespit edilmemiş bir profile işaret ediyorsa (`pty_profiles()`
 * listesinde yok) otomatik seçime (`null` → backend'in mevcut ilk-profil önceliği) düşülür.
 * Rust `pty_spawn`/profil mantığına dokunulmaz.
 */
import type { ShellKind, ShellProfile } from "../../lib/ipc";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSettingsStore } from "../../stores/settingsStore";

export function resolveDefaultProfileId(profiles: ShellProfile[], defaultShell: ShellKind | null): ShellKind | null {
  if (defaultShell === null) return null;
  return profiles.some((p) => p.id === defaultShell) ? defaultShell : null;
}

/**
 * "+" butonu, `terminal.new` komutu ve `App.tsx`'in `` Ctrl+` `` "focus or create" akışı ortak
 * kullanır: açıkça bir profil seçilmediğinde (kullanıcı dropdown'dan seçmediğinde) ayarlardaki
 * `defaultShell`'e uyar.
 */
export function spawnTerminal(workspaceId: string, agentCommand?: string): string {
  const profileId = resolveDefaultProfileId(
    useTerminalStore.getState().profiles,
    useSettingsStore.getState().settings.terminal.defaultShell,
  );
  return useTerminalStore.getState().newTerminal(workspaceId, { profileId, agentCommand: agentCommand ?? null });
}
