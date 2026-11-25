# Lessons

- 2026-11-25 · Turkish case folding: Rust `to_lowercase` turns "İ" into "i" + U+0307, so "İş" ≠ "iş"; CSS
  `uppercase` follows `<html lang>` and turns "iş" into "IŞ" in English. For user-entered names: compare with
  a fold that maps İ/I/ı to i, never CSS-uppercase user text, and add a Turkish-letter case to every
  case-insensitive uniqueness test.
- 2026-11-25 · `tauri dev` does not rebuild the .NET hub: it starts `hub/Hub.Service/bin/Debug/.../kotilo-hub.exe`
  as it is. After any `hub/` change, run `dotnet build hub/AgentHub.sln` (with the dev app closed, the exe
  is locked) before asking the user to try it; UI parts fed by a missing hub route render nothing.
- 2026-11-25 · Never pipe a made-up payload through the real `kotilo-statusline` with the real data dir: it
  posts to the live hub, and a fake later `resets_at` would win the merge over real limits. Use a temp
  `AGENTHUB_DATA_DIR` holding only a copy of `statusline.json`.
