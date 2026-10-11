/**
 * Single access point for user-visible text. The dictionaries live in `./i18n/en.ts` and
 * `./i18n/tr.ts`; `strings` reads whichever language is active (see `./i18n/index.ts`).
 * React components should prefer `useStrings()` so they re-render on a language switch.
 */
export { strings, useStrings } from "./i18n";
export type { Strings } from "./i18n";
