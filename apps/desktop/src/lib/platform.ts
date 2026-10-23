/**
 * U-2: the OS the app runs on and which OS-dependent features exist there (`app_info`'s
 * `platform` + `features`). Read once before the first render (`hydratePlatform` in `main.tsx`)
 * and never changes, so components read it synchronously. Settings and routes for a missing
 * feature are hidden rather than shown doing nothing.
 */
import { appInfo, type PlatformFeatures } from "./ipc";

/** Windows has every feature; also the value until `app_info` answers (and in tests). */
const ALL: PlatformFeatures = {
  globalHotkeys: true,
  dictation: true,
  mascot: true,
  awaySummary: true,
  bundledConpty: true,
  windowsTerminalSchemes: true,
};

let current: { platform: string; features: PlatformFeatures } = { platform: "windows", features: ALL };

export async function hydratePlatform(): Promise<void> {
  try {
    const info = await appInfo();
    current = { platform: info.platform ?? "windows", features: { ...ALL, ...info.features } };
  } catch {
    // An older backend or a failed call: keep the Windows defaults.
  }
}

export function platformFeatures(): PlatformFeatures {
  return current.features;
}

/** `"windows"`, `"macos"` or `"linux"`. */
export function platformId(): string {
  return current.platform;
}

/**
 * U-3: picks the text that names the OS (Explorer/Finder, "Same as Windows"). Dictionaries call
 * it from getters, so it is read at access time – after `hydratePlatform`.
 */
export function perOs(windows: string, macos: string, linux: string, platform: string = current.platform): string {
  return platform === "macos" ? macos : platform === "linux" ? linux : windows;
}

/** The system web view's name for the About line and bug reports. */
export function webviewName(platform: string = current.platform): string {
  if (platform === "macos") return "WKWebView";
  if (platform === "linux") return "WebKitGTK";
  return "WebView2";
}

/** Tests only. */
export function setPlatformForTests(platform: string, features: Partial<PlatformFeatures> = {}): void {
  current = { platform, features: { ...ALL, ...features } };
}
