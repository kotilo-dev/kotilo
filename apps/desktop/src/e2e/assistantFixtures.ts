/**
 * M7 e2e: the assistant popup's backend (`assistant_info`, `assistant_chat` streaming through
 * the Tauri `Channel`, `assistant_stop`). URL params on `?view=assistant`:
 * `assistant=off|unavailable|error|slow` (default: answers stream and finish),
 * `ephemeral=true|false|null` (default true). Calls are recorded on `window.__e2eAssistant`.
 */
import type { AssistantEvent, AssistantInfo, AssistantMessage } from "../features/assistant/assistantIpc";

const params = new URLSearchParams(window.location.search);
const scenario = params.get("assistant") ?? "ok";
const ephemeralParam = params.get("ephemeral");
const ephemeral = ephemeralParam === "false" ? false : ephemeralParam === "null" ? null : true;
// Persistence as verified per CLI (D-053): Claude Code runs ephemeral, Gemini keeps sessions, Cursor unknown.
const providerLabel = ephemeral === false ? "Gemini CLI" : ephemeral === null ? "Cursor CLI" : "Claude Code";
const model = ephemeral === true ? "haiku" : null;
const provider = ephemeral === false ? "cli:gemini" : ephemeral === null ? "cli:cursor" : "cli:claude-code";
const turkish = params.get("lang") === "tr";

interface Recorder {
  chats: AssistantMessage[][];
  stops: number;
  hides: number;
  opens: number;
  configs: unknown[];
}

declare global {
  interface Window {
    __e2eAssistant: Recorder;
  }
}

window.__e2eAssistant = { chats: [], stops: 0, hides: 0, opens: 0, configs: [] };

const ANSWERS_EN = [
  "Use a **soft reset**:\n\n```bash\ngit reset --soft HEAD~1\n```\n\nThe commit is gone and its changes stay staged. Use `--mixed` instead to keep them unstaged.",
  "Then only rewrite history if nobody else works on that branch:\n\n1. Reset as above.\n2. Push with `git push --force-with-lease`.\n\nOn a shared branch prefer `git revert HEAD` – it adds a new commit that undoes the old one.",
];
const ANSWERS_TR = [
  "**Soft reset** kullanın:\n\n```bash\ngit reset --soft HEAD~1\n```\n\nCommit kalkar, değişiklikler stage'de kalır. Stage dışında kalsın isterseniz `--mixed` kullanın.",
  "O zaman geçmişi yalnızca o dalda sizden başka kimse çalışmıyorsa yeniden yazın:\n\n1. Yukarıdaki gibi sıfırlayın.\n2. `git push --force-with-lease` ile gönderin.\n\nOrtak bir dalda `git revert HEAD` daha güvenlidir – eski commit'i geri alan yeni bir commit ekler.",
];

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function assistantInfo(): AssistantInfo {
  return {
    enabled: scenario !== "off",
    provider,
    providerLabel,
    model,
    ephemeral,
    available: scenario !== "unavailable",
    unavailableReason: scenario === "unavailable" ? "notInstalled" : null,
  };
}

let stopRequested = false;
let wakeOnStop: (() => void) | null = null;

export async function assistantChat(args: Record<string, unknown>): Promise<null> {
  const messages = (args.messages ?? []) as AssistantMessage[];
  const channel = args.onEvent as { onmessage: (e: AssistantEvent) => void };
  window.__e2eAssistant.chats.push(messages);
  stopRequested = false;
  const send = (e: AssistantEvent) => channel.onmessage(e);
  send({ type: "meta", provider, providerLabel, model, ephemeral });
  await delay(150);
  if (scenario === "error") {
    send({ type: "done", errorKind: "notLoggedIn", error: null });
    return null;
  }
  const answers = turkish ? ANSWERS_TR : ANSWERS_EN;
  const userCount = messages.filter((m) => m.role === "user").length;
  const answer = answers[(userCount - 1) % answers.length]!;
  const words = answer.split(/(?<= )/);
  const chunk = Math.ceil(words.length / 4);
  let text = "";
  for (let i = 0; i < words.length && !stopRequested; i += chunk) {
    text += words.slice(i, i + chunk).join("");
    send({ type: "text", text });
    if (scenario === "slow" && i + chunk >= words.length / 2) {
      // Wait for Stop with half an answer on screen.
      await new Promise<void>((resolve) => {
        wakeOnStop = resolve;
        if (stopRequested) resolve();
      });
    } else {
      await delay(120);
    }
  }
  // Like Rust: nothing more on the Channel after a stop.
  if (!stopRequested) send({ type: "done", errorKind: "none", error: null });
  return null;
}

export function assistantStop(): null {
  window.__e2eAssistant.stops += 1;
  stopRequested = true;
  wakeOnStop?.();
  wakeOnStop = null;
  return null;
}
