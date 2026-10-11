/**
 * OS bildirimi gönderimi (faz5-spec §2.5, §4 revizyon 9 — BAĞLAYICI). Karar mantığı
 * (`decideNotifications`) saf ve `agentLogic.ts`'te test edilir; bu dosya yalnızca yan etkili
 * gönderim tarafı — Tauri plugin çağrılarını mock'lamadan test edilmeyecek kısım.
 *
 * "Bildirime tıklama → pane" kesildi (§4.9): plugin'in masaüstünde tıklama/aksiyon API'si yok.
 * Dikkat çekme yalnızca `requestUserAttention` ile.
 */
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { strings } from "../../app/strings";
import { agentLabel } from "../../app/ui/agents";
import { useSettingsStore } from "../../stores/settingsStore";
import type { AgentKind } from "../../lib/ipc";
import type { NotificationDto, SessionState } from "../../lib/hubTypes";
import type { NotificationKind } from "./agentLogic";

/** İzin bu oturumda zaten istendiyse tekrar istemeye çalışmaz (§2.5: "bir kez"). */
let permissionRequestedThisSession = false;

async function ensurePermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    if (permissionRequestedThisSession) return false;
    permissionRequestedThisSession = true;
    const result = await requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

export interface NotifyAgentInput {
  kind: AgentKind;
  /** M3: the adapter id; its display name wins over the kind label. */
  adapterId?: string | null;
  notificationKind: NotificationKind;
  workspaceName: string;
  /** Bulunamayan bir sekmeye ait olabilir (pane yeniden başlamış) — bu durumda `null`. */
  tabTitle: string | null;
}

export async function notifyAgent(input: NotifyAgentInput): Promise<void> {
  if (!useSettingsStore.getState().settings.agents.notifications) return;

  const kindLabel = agentLabel(input);
  const tabTitle = input.tabTitle ?? "";
  const body =
    input.notificationKind === "blocked"
      ? strings.agents.notification.needsInput(kindLabel, input.workspaceName, tabTitle)
      : strings.agents.notification.finished(kindLabel, input.workspaceName, tabTitle);

  await deliver(strings.appName, body);
}

/** OS toast + taskbar attention; failures are swallowed (permission/platform issues). */
async function deliver(title: string, body: string): Promise<void> {
  try {
    if (await ensurePermission()) {
      sendNotification({ title, body });
    }
  } catch {
    // yut — bildirim gönderilemedi (izin/platform sorunu), taskbar flash yine denenir
  }

  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Informational);
  } catch {
    // yut
  }
}

function stateLabel(state: SessionState): string | null {
  switch (state) {
    case "WaitingPermission":
      return strings.status.needsPermission;
    case "WaitingInput":
      return strings.status.waitingInput;
    case "Working":
      return strings.status.working;
    case "Idle":
      return strings.status.done;
    case "Error":
      return strings.status.error;
    default:
      return null;
  }
}

/**
 * M2: a hub rule-engine notification (the hub decides; this app is the single place that
 * shows it). The title is rebuilt in the UI language from the structured fields when it can
 * be; otherwise the hub's own text is used.
 */
export async function notifyFromHub(n: NotificationDto): Promise<void> {
  if (!useSettingsStore.getState().settings.agents.notifications) return;
  const label = n.state ? stateLabel(n.state) : null;
  const title = n.projectName && label ? `${n.projectName}: ${label}` : n.title || strings.appName;
  await deliver(title, n.body);
}
