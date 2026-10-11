/**
 * Küçük, genel yardımcı: bir dizi asenkron istekten yalnızca EN SON başlatılanın yanıtının
 * "güncel" sayılmasını sağlar (faz6-spec §5.2: `fs_quick_open` yanıtlarında "eski yanıtlar yok
 * sayılır"; §10.21: QuickPick bayat yanıt testi). Debounce'un kendisi çağıran tarafta.
 */
export class RequestGuard {
  private seq = 0;

  /** Yeni bir istek başlatılırken çağrılır — döndürdüğü id, o isteğin biletidir. */
  next(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Bu id hâlâ en son başlatılan istek mi (aradan başka bir `next()` çağrılmadı mı). */
  isLatest(id: number): boolean {
    return id === this.seq;
  }
}
