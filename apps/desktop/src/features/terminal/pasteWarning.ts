/**
 * Çok satırlı yapıştırma uyarısı — saf karar fonksiyonu (faz6-spec §7). Uyarı yalnızca:
 * metin bir satır sonu içeriyorsa, VE bracketed paste kapalıysa (TUI'ler — claude/codex — bunu
 * açar, orada uyarı gösterilmez), VE `warnMultilinePaste` ayarı açıksa gösterilir.
 */
export function shouldWarnMultilinePaste(text: string, bracketedPasteMode: boolean, warnEnabled: boolean): boolean {
  if (!warnEnabled || bracketedPasteMode) return false;
  return /\r\n|\r|\n/.test(text);
}

/** Modalın başlığındaki satır sayısı ("Paste N lines into the terminal?"). */
export function countPastedLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}
