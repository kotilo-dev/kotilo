/**
 * Saf klavye yönlendirme fonksiyonu (faz4-spec §2.4, §4.2, §4.4, §4.5). Terminal odaktayken
 * bir tuş kombinasyonunun nereye gideceğini belirler:
 * - `"app"`: uygulama komutu çalışır, shell'e gitmez (ör. `Ctrl+B`, `Ctrl+J`, `Ctrl+Tab`).
 * - `"terminal"`: terminale özel kısayol (`Ctrl+Shift+C/V/F`), `TerminalView` kendi ele alır.
 * - `"shell"`: shell'e gider (ör. seçimsiz `Ctrl+C`, `Ctrl+W`, `Ctrl+S` — terminal odaktayken
 *   viewer'ın bu kısayolları shell'e devredilir).
 *
 * Windows Terminal / VS Code davranışı (kullanıcı isteği, 2026-09-27): `Ctrl+C` seçim varken
 * kopyalar, yoksa shell'e (SIGINT) gider; `Ctrl+V` her zaman yapıştırır. macOS (U-3): Cmd+C/V
 * kopyalar/yapıştırır, Ctrl+C/V her zaman shell'e gider.
 *
 * `normalizeKeybinding` ile aynı birleştirilmiş kısayol dizesini kullanır (tek kaynak) —
 * `` Ctrl+` `` için TR klavyede `e.key` "Dead" olduğundan `e.code === "Backquote"` eşlemesi
 * oradan gelir (faz4-spec §4.5).
 */
import { normalizeKeybinding } from "../../app/commands";
import { isMac, resolveKeybinding } from "../../lib/keys";
import { platformId } from "../../lib/platform";

export type KeyRoute = "app" | "terminal" | "shell";

export interface KeyRoutingEvent {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
  code?: string;
}

/**
 * Terminal odaktayken de uygulamada kalan kısayollar (faz4-spec §4.1, §4.4). Canonical form
 * (U-3, `lib/keys.ts`): `Mod` is Cmd on macOS and Ctrl elsewhere; `Ctrl+Tab`/`` Ctrl+` `` stay
 * Ctrl on every OS.
 */
const GLOBAL_BINDINGS: readonly string[] = [
  "Mod+B",
  "Mod+J",
  "Mod+Shift+U",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+`",
  // faz5-spec §2.4: en yakın `blocked` agent'a git — terminal odaktayken de çalışır.
  "Mod+Shift+A",
  // faz6-spec §10.6: komut paleti ve ayarlar terminal odaktayken de açılır (`Mod+P` KASITLI
  // olarak burada değil — terminale gider, bkz. §5 "Kısayol kapsamı": agent CLI'ların kendi
  // `ctrl+p commands` menüsü/readline geçmişi bozulmasın).
  "Mod+Shift+P",
  "Mod+,",
  // faz7-spec §12.2/§12.3: F1 (Help) is global, like Ctrl+B — never reaches the shell, even from
  // a terminal. WebView2 has no F1 default of its own to fight with.
  "F1",
  ...Array.from({ length: 9 }, (_, i) => `Mod+${i + 1}`),
  // M2 shell: Alt+1…Alt+9 switch app routes (Overview, Mission control, …) from anywhere.
  ...Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`),
];

/**
 * Terminale özel — `attachCustomKeyEventHandler` kendi ele alır, `commands.ts`'e gitmez.
 * macOS (U-3) also copies on Cmd+C (with or without a selection) and finds on Cmd+F, as macOS
 * terminals do; Ctrl+C/Ctrl+V there always reach the shell.
 */
const TERMINAL_LOCAL_BINDINGS: readonly string[] = ["Mod+Shift+C", "Mod+Shift+V", "Mod+Shift+F", "Mod+V"];
const TERMINAL_LOCAL_BINDINGS_MAC: readonly string[] = ["Mod+C", "Mod+F"];

interface RouteTables {
  global: Set<string>;
  local: Set<string>;
  copy: string;
}

const tablesByPlatform = new Map<string, RouteTables>();

function tables(platform: string): RouteTables {
  let t = tablesByPlatform.get(platform);
  if (!t) {
    const resolve = (b: string) => resolveKeybinding(b, platform);
    const local = isMac(platform) ? [...TERMINAL_LOCAL_BINDINGS, ...TERMINAL_LOCAL_BINDINGS_MAC] : TERMINAL_LOCAL_BINDINGS;
    t = { global: new Set(GLOBAL_BINDINGS.map(resolve)), local: new Set(local.map(resolve)), copy: resolve("Mod+C") };
    tablesByPlatform.set(platform, t);
  }
  return t;
}

/**
 * `terminalFocused=false` iken her zaman `"app"` döner (bu fonksiyonun terminal dışı akışlarla
 * ilgisi yok — çağıran zaten normal komut sevkini kullanır). `terminalFocused=true` iken
 * yalnızca `keydown`'da karar verilir; `keypress`/`keyup` çağıranın (stateful sarmalayıcı,
 * `TerminalView`) aynı kararı önbellekten tekrar uygulaması gerekir (faz4-spec §4.2).
 */
export function routeKey(
  e: KeyRoutingEvent,
  terminalFocused: boolean,
  hasSelection = false,
  platform: string = platformId(),
): KeyRoute {
  if (!terminalFocused) return "app";
  const combo = normalizeKeybinding(e);
  const t = tables(platform);
  if (t.global.has(combo)) return "app";
  if (t.local.has(combo)) return "terminal";
  if (combo === t.copy && hasSelection) return "terminal";
  return "shell";
}
