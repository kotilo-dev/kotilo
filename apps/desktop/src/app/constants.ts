import brandJson from "../../../../brand.json";

/**
 * Product identity from the repo's `brand.json` (the single source, M5 "Brand switch"). Every
 * user-visible name (window title included) comes from here or from `strings.ts`, which
 * interpolates it — never write the product name as a literal.
 */
export const BRAND = brandJson;

export const APP_NAME = BRAND.name;

/** Folder name used in paths the UI shows or creates (`%APPDATA%\<slug>`, `.<slug>/attachments`). */
export const APP_SLUG = BRAND.slug;

/** The hook sidecar's command name (`<exePrefix>-hook`), as users type it in wrapper scripts. */
export const HOOK_COMMAND = `${BRAND.exePrefix}-hook`;

// Faz 6: `DEFAULT_AGENT_COMMANDS` ve `NOTIFICATIONS_ENABLED` kaldırıldı (faz6-spec §1.3) —
// tüketiciler artık `useSettingsStore().settings.agents.{commands,notifications}` okur.
