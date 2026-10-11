/**
 * Review #1 (CRITICAL): bir zustand v5 selector'ı `s.foo ?? []` gibi bir düşme değeri
 * döndürdüğünde, `s.foo` `undefined` olduğu SÜRECE her render'da YENİ bir `[]` referansı
 * üretilir. Zustand v5 `useSyncExternalStore` üzerine kurulu; React her render sonunda
 * "snapshot hâlâ aynı mı" diye selector'ı tekrar çağırır — `Object.is` eşitliği asla
 * sağlanamadığından bileşen sonsuz döngüde yeniden render olur (%100 CPU). Örnek:
 * `QuickPick.tsx` her zaman mount'lu olduğundan, aktif workspace'in `viewerStore`'da hiç
 * girdisi olmadığı an bu döngüye giriyordu.
 *
 * Çözüm: düşme değeri modül düzeyinde, TEK bir sabit referans olmalı. Selector'lardaki
 * `s.foo ?? EMPTY_ARRAY` (ya da selector `undefined` dönüp çağıran tarafta `?? EMPTY_ARRAY`
 * uygulanır) her iki durumda da aynı referansı verir — React ekstra render'ı tetiklemez.
 *
 * `never[]` (readonly değil) kasıtlı: TypeScript'te `never[]` kovaryant olarak her `T[]`
 * yerine geçebilir (ör. `ViewerTab[] | undefined`'ın düşme değeri), ekstra tip zorlaması
 * gerekmez.
 */
export const EMPTY_ARRAY: never[] = [];
