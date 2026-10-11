/**
 * Merkezi komut kayıt sistemi.
 *
 * Faz 1'de yalnızca panel görünürlük kısayolları (`Ctrl+B`, `Ctrl+Shift+T`,
 * `Ctrl+Shift+V`) buradan kayıtlı; Faz 6'daki komut paleti (`Ctrl+Shift+P`) aynı
 * registry'i tüketecek — bu yüzden komutlar yalnızca kısayol → aksiyon eşlemesi değil,
 * `id`/`title` de taşır.
 */

/** Text that is resolved when shown, so the palette follows the active UI language. */
export type CommandText = string | (() => string);

export function resolveCommandText(text: CommandText | undefined): string | undefined {
  return typeof text === "function" ? text() : text;
}

export interface Command {
  id: string;
  title: CommandText;
  /** Örn. "Ctrl+B", "Ctrl+Shift+T". Normalize edilmiş biçim: bkz. `normalizeKeybinding`. */
  keybinding?: string;
  /**
   * faz4-spec §2.4/§4.1: `"global"` (varsayılan) terminal odaktayken de çalışır (ör. `Ctrl+B`,
   * `Ctrl+J`, `Ctrl+Shift+U`, `Ctrl+Tab`/`Shift+Tab`); `"notTerminal"` (`Ctrl+S`, `Ctrl+W`,
   * `Ctrl+Shift+M`, faz6-spec §5 `quickOpen.show`) terminal odaktayken çalışmaz — tuş shell'e
   * gider (`isTerminalFocused`). Faz 6 öncesi adı `"viewer"`'dı; davranış aynı, yalnızca yeniden
   * adlandırıldı (SPEC §10.6: bu kapsam artık viewer'a özel değil, `Ctrl+P` de kullanıyor).
   */
  scope?: "global" | "notTerminal";
  /** Komut paleti (faz6-spec §5.1): başlıkta "Category: Title" olarak gösterilir. */
  category?: CommandText;
  /** `false` dönerse komut paletinde görünmez (ör. hooks zaten kurulu/kurulu değil). */
  enabled?: () => boolean;
  run: () => void;
}

const commands = new Map<string, Command>();

/** Bir komutu kaydeder; çağrılan fonksiyon komutu kaldırmak için kullanılabilir. */
export function registerCommand(command: Command): () => void {
  commands.set(command.id, command);
  return () => {
    if (commands.get(command.id) === command) {
      commands.delete(command.id);
    }
  };
}

export function unregisterCommand(id: string): void {
  commands.delete(id);
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

/** Komut paleti (Faz 6) için: kayıtlı tüm komutlar. */
export function listCommands(): Command[] {
  return Array.from(commands.values());
}

/** Testler için: registry'i temizler. */
export function clearCommands(): void {
  commands.clear();
}

const KEY_ALIASES: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
};

/**
 * `KeyboardEvent` → `"Ctrl+Shift+T"` gibi normalize edilmiş bir kısayol dizesi.
 *
 * faz4-spec §4.5: `` Ctrl+` `` için TR klavyede `e.key` "Dead" olur — bu **tek** bağ için
 * `e.code === "Backquote"` ile kod tabanlı eşleşme yapılır (diğer tüm kısayollar `key`'e göre).
 */
export function normalizeKeybinding(
  e: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "key"> & { code?: string },
): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");

  if (e.code === "Backquote") {
    parts.push("`");
    return parts.join("+");
  }

  const rawKey = e.key;
  const key = KEY_ALIASES[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey);

  // Modifier tuşunun kendisi basılıysa (yalnızca "Ctrl" gibi) eşleşecek bir komut olmaz.
  if (!["Control", "Alt", "Shift", "Meta"].includes(rawKey)) {
    parts.push(key);
  }

  return parts.join("+");
}

/** `document.activeElement` bir `.xterm` içinde mi (faz4-spec §2.4 odak tespiti). */
export function isTerminalFocused(): boolean {
  const active = document.activeElement;
  return active !== null && active.closest(".xterm") !== null;
}

let listenerCleanup: (() => void) | undefined;

/**
 * Tek global `keydown` dinleyicisi. Kayıtlı komutlardan kısayolu eşleşeni bulur,
 * `preventDefault` yapar ve çalıştırır. İdempotent: birden çok çağrıda tek dinleyici
 * kalır.
 *
 * faz3-spec §5.17: **capture** fazında kayıtlı — `Ctrl+S`/`Ctrl+W`/`Ctrl+Tab`/
 * `Ctrl+Shift+Tab`/`Ctrl+Shift+M` Monaco odaktayken de (editörün kendi DOM node'una
 * ulaşmadan) burada yakalansın diye; Monaco'ya bu tuşlar için ayrıca `addCommand`
 * eklenmez (çift tetik olmaz). Diğer kısayolları (Ctrl+B vb.) bozmaz — aynı eşleşme
 * mantığı, yalnızca faz daha erken.
 */
export function installGlobalKeydownListener(target: Window = window): () => void {
  if (listenerCleanup) return listenerCleanup;

  const handler = (e: KeyboardEvent) => {
    const combo = normalizeKeybinding(e);
    for (const command of commands.values()) {
      if (!command.keybinding || command.keybinding !== combo) continue;
      // faz4-spec §2.4/§4.1 (faz6-spec §10.6: yeniden adlandırıldı): "notTerminal" kapsamındaki
      // komutlar (Ctrl+S/W/Shift+M, Ctrl+P) terminal odaktayken çalışmaz — tuş burada
      // yutulmaz, xterm'in kendi `attachCustomKeyEventHandler`'ı (aynı yönlendirme kararıyla)
      // shell'e gönderir.
      if (command.scope === "notTerminal" && isTerminalFocused()) continue;
      e.preventDefault();
      command.run();
      return;
    }
  };

  target.addEventListener("keydown", handler, true);
  listenerCleanup = () => {
    target.removeEventListener("keydown", handler, true);
    listenerCleanup = undefined;
  };
  return listenerCleanup;
}
