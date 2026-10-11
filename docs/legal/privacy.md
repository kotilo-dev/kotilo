# Kotilo Privacy Policy

Effective date: 2026-10-11

Kotilo is an open-source project maintained by volunteers ("the maintainers"). There is no company behind it and no Kotilo server. This policy describes the software's behavior: what Kotilo stores on your device and the few cases in which it connects to other systems. Source code: https://github.com/kotilo-dev/kotilo

## 1. Summary

- **No telemetry.** Kotilo sends no usage analytics, crash reports or tracking data to the maintainers or anyone else.
- **Your data stays on your device.** Settings, session metadata, usage statistics, tasks and reports are stored only in local folders.
- **No transcript content at rest.** Prompts, agent responses and conversation content are never written to Kotilo's database or logs; only metadata and counts (for example times, token counts, states, tool names, file paths) are stored.
- **No audio at rest.** Dictation audio is processed in memory on your device and never stored.
- **No agent credentials.** Kotilo never reads, stores or transmits the login or token files of any AI agent.
- **The maintainers receive nothing.** Nothing Kotilo does sends data to the maintainers.

## 2. Data that leaves your device

Kotilo connects to other systems only in these cases:

| When | Recipient | What is sent | Purpose |
|---|---|---|---|
| Update check: a few seconds after start (can be turned off in Settings → About & diagnostics) and when you click **Check for updates** | GitHub Releases (github.com and GitHub's download hosts, such as objects.githubusercontent.com) | A request for the latest release information and, when you install an update, the installer download. Like any web request it reveals your IP address and an ordinary user agent | Finding and installing new versions |
| Whisper model download (only when you choose a model) | Hugging Face (huggingface.co and its download hosts) | A file download request | Getting the speech model for local dictation |
| AI features, only when such a feature runs (assistant, daily summary, dictation cleanup, provider **Test**) | The AI provider you chose: your installed agent CLI (which talks to its own vendor under your account), or an OpenAI-compatible endpoint you configured | The request for that feature (for example the text to clean up or the numbers to summarize) and, for an endpoint, the API key you stored for it | Performing the AI feature |

Nothing else is sent. GitHub, Hugging Face and the AI providers process these requests under their own privacy policies and your agreements with them; the maintainers have no access to that data. If every AI feature uses an endpoint on your own computer and you use local Whisper, no AI data leaves your device (shown as **Fully local** in the app).

The agents you run in Kotilo's terminals are separate programs. They connect to their own services under their own terms; Kotilo does not route, read or change that traffic. The same applies to links you open, which go to your browser.

The Windows installer may download Microsoft's WebView2 Runtime from Microsoft if it is not already installed.

## 3. Data stored on your device

Kotilo stores in its local data folders (`%APPDATA%\kotilo` and `%LOCALAPPDATA%\kotilo` on Windows):

- settings, workspace list and window layout;
- session and usage metadata (states, times, token counts, costs, projects, tool names);
- your personal tasks, reports and daily summaries;
- prompts you explicitly save in the composer;
- a dictation history with the recognized text (not the audio), which you can clear or turn off in Settings → Dictation;
- log files without transcript content, and diagnostics archives that you create yourself with **Collect diagnostics** (they are never sent anywhere automatically);
- downloaded Whisper speech models.

**API keys** you enter for an AI endpoint are stored in the operating system's credential vault (Windows Credential Manager), never in settings files or logs. **Remove key** in Settings deletes a key.

## 4. Agent configuration files

To show agent status, Kotilo can install hook entries or a plugin in the configuration of the agents you use. It does so only when you click **Install** for an agent, makes a timestamped backup of the file first, keeps everything else in the file, refuses to change a file it cannot read, and on **Uninstall** removes only its own entries. The hook helper reports events only to Kotilo's background service on your own computer (loopback), with prompt and response text removed.

## 5. Uninstalling

Before uninstalling, click **Uninstall** for each agent integration in Settings → Agents; the uninstaller does not edit your agents' files. The uninstaller removes the app, its shortcuts and its registry entry. Your data folders (section 3) stay so that a reinstall keeps your settings; delete `%APPDATA%\kotilo` and `%LOCALAPPDATA%\kotilo` to remove all data. Stored API keys can be removed in Settings before uninstalling, or in Windows Credential Manager.

## 6. Your rights

Because Kotilo keeps your data on your device and the maintainers receive none of it, you control it directly: you can view and delete it at any time. Data you send to GitHub, Hugging Face or an AI provider is handled by them; contact them to exercise your rights for that data.

## 7. Children

Kotilo is a developer tool and is not directed to children.

## 8. Contact

Questions about this policy: open an issue at https://github.com/kotilo-dev/kotilo/issues. To report a privacy or security problem privately, use GitHub's private vulnerability reporting (the repository's Security tab → **Report a vulnerability**).

## 9. Changes

Changes to this policy are published in the repository at https://github.com/kotilo-dev/kotilo with a new effective date. A change that would send additional data off your device is announced in the release notes.
