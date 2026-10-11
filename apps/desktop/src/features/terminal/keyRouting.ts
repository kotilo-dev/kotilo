/**
 * Saf klavye yönlendirme fonksiyonu (faz4-spec §2.4, §4.2, §4.4, §4.5). Terminal odaktayken
 * bir tuş kombinasyonunun nereye gideceğini belirler:
 * - `"app"`: uygulama komutu çalışır, shell'e gitmez (ör. `Ctrl+B`, `Ctrl+J`, `Ctrl+Tab`).
 * - `"terminal"`: terminale özel kısayol (`Ctrl+Shift+C/V/F`), `TerminalView` kendi ele alır.
 * - `"shell"`: shell'e gider (ör. seçimsiz `Ctrl+C`, `Ctrl+W`, `Ctrl+S` — terminal odaktayken
 *   viewer'ın bu kısayolları shell'e devredilir).
 *
 * Windows Terminal / VS Code davranışı (kullanıcı isteği, 2026-09-27): `Ctrl+C` seçim varken
 * kopyalar, yoksa shell'e (SIGINT) gider; `Ctrl+V` her zaman yapıştırır.
 *
 * `normalizeKeybinding` ile aynı birleştirilmiş kısayol dizesini kullanır (tek kaynak) —
 * `` Ctrl+` `` için TR klavyede `e.key` "Dead" olduğundan `e.code === "Backquote"` eşlemesi
 * oradan gelir (faz4-spec §4.5).
 */
import { normalizeKeybinding } from "../../app/commands";

export type KeyRoute = "app" | "terminal" | "shell";

export interface KeyRoutingEvent {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  key: string;
  code?: string;
}

/** Terminal odaktayken de uygulamada kalan kısayollar (faz4-spec §4.1, §4.4). */
const GLOBAL_COMBOS = new Set<string>([
  "Ctrl+B",
  "Ctrl+J",
  "Ctrl+Shift+U",
  "Ctrl+Tab",
  "Ctrl+Shift+Tab",
  "Ctrl+`",
  // faz5-spec §2.4: en yakın `blocked` agent'a git — terminal odaktayken de çalışır.
  "Ctrl+Shift+A",
  // faz6-spec §10.6: komut paleti ve ayarlar terminal odaktayken de açılır (`Ctrl+P` KASITLI
  // olarak burada değil — terminale gider, bkz. §5 "Kısayol kapsamı": agent CLI'ların kendi
  // `ctrl+p commands` menüsü/readline geçmişi bozulmasın).
  "Ctrl+Shift+P",
  "Ctrl+,",
  // faz7-spec §12.2/§12.3: F1 (Help) is global, like Ctrl+B — never reaches the shell, even from
  // a terminal. WebView2 has no F1 default of its own to fight with.
  "F1",
  ...Array.from({ length: 9 }, (_, i) => `Ctrl+${i + 1}`),
  // M2 shell: Alt+1…Alt+9 switch app routes (Overview, Mission control, …) from anywhere.
  ...Array.from({ length: 9 }, (_, i) => `Alt+${i + 1}`),
]);

/** Terminale özel — `attachCustomKeyEventHandler` kendi ele alır, `commands.ts`'e gitmez. */
const TERMINAL_LOCAL_COMBOS = new Set<string>(["Ctrl+Shift+C", "Ctrl+Shift+V", "Ctrl+Shift+F", "Ctrl+V"]);

/**
 * `terminalFocused=false` iken her zaman `"app"` döner (bu fonksiyonun terminal dışı akışlarla
 * ilgisi yok — çağıran zaten normal komut sevkini kullanır). `terminalFocused=true` iken
 * yalnızca `keydown`'da karar verilir; `keypress`/`keyup` çağıranın (stateful sarmalayıcı,
 * `TerminalView`) aynı kararı önbellekten tekrar uygulaması gerekir (faz4-spec §4.2).
 */
export function routeKey(e: KeyRoutingEvent, terminalFocused: boolean, hasSelection = false): KeyRoute {
  if (!terminalFocused) return "app";
  const combo = normalizeKeybinding(e);
  if (GLOBAL_COMBOS.has(combo)) return "app";
  if (TERMINAL_LOCAL_COMBOS.has(combo)) return "terminal";
  if (combo === "Ctrl+C" && hasSelection) return "terminal";
  return "shell";
}
