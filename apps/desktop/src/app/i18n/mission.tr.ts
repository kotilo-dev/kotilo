/** Turkish `mission` (same shape as `mission.en.ts`). */
import { APP_NAME } from "../constants";
import type { missionEn } from "./mission.en";

export const missionTr: typeof missionEn = {
  summary: (total: number, attention: number, working: number, done: number) =>
    `${total} ajan · ${attention} sizi bekliyor · ${working} çalışıyor · ${done} bitti`,
  filterLabel: "Gösterilen oturumlar",
  filters: { all: "Tümü", attention: "Sizi bekliyor", working: "Çalışıyor", done: "Bitti" },
  noSessions: "Henüz ajan oturumu yok",
  noSessionsBody: "Bir terminalde ajan başlatın. Entegrasyonu kurulduğunda oturumlar burada görünür (Ayarlar).",
  noMatch: "Bu grupta şu an oturum yok",
  noOutput: "Henüz çıktı yok",
  permission: (tool: string | null) => `İzin istiyor${tool ? `: ${tool}` : ""}`,
  tool: (tool: string) => `Çalıştırıyor: ${tool}`,
  waiting: (duration: string) => `${duration} bekliyor`,
  context: (percent: string) => `context ${percent}`,
  subagents: (n: number) => `${n} alt ajan`,
  tokens: (count: string) => `${count} token`,
  outsideApp: `${APP_NAME} dışında çalışıyor`,
  open: "Görev kontrolü aç",
  markAllSeen: "Tümünü görüldü say",
  markSeen: "Görüldü say",
};
