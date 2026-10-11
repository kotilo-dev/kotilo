// Kotilo plugin for OpenCode v2 (@opencode/cli). Installed and updated by Kotilo (Settings → Agents);
// local edits are overwritten. Marker: agenthub-hook.
//
// Forwards session state to Kotilo through the agenthub-hook sidecar:
//   kotilo-hook --agent opencode --event <OpenCode event type> --json <payload>
// The payload holds ids, the working directory, a permission's or tool call's tool name and command/path, and status
// values only; never prompt, reply, tool input beyond that, tool output or file content. Dependency-free; every failure
// is silent and nothing here ever blocks OpenCode (the hook is started detached from the event loop and not awaited).

const HOOK = "__AGENTHUB_HOOK_EXE__"
// Bump with every change, so installed copies read as outdated.
const PLUGIN_VERSION = 2
const MAX_TEXT = 4000
const MAX_MESSAGE = 200

// Permission actions whose resources are shell commands or file paths (OpenCode 2.0.22 tool plugins).
const SHELL_ACTIONS = new Set(["shell", "bash"])
const PATH_ACTIONS = new Set(["edit", "write", "patch", "read", "list", "external_directory"])
// Tool calls tracked for the activity timeline; older names are forgotten past this many.
const MAX_TOOLS = 256

let spawnHook

async function loadSpawn() {
  if (spawnHook !== undefined) return spawnHook
  try {
    spawnHook = (await import("node:child_process")).spawn
  } catch {
    spawnHook = null
  }
  return spawnHook
}

// One hook process at a time, so events reach Kotilo in OpenCode's order (each hook stamps its own time).
let queue = Promise.resolve()

function send(event, payload) {
  queue = queue.then(() => run(event, payload))
  return queue
}

async function run(event, payload) {
  try {
    const spawn = await loadSpawn()
    if (!spawn) return
    await new Promise((resolve) => {
      const child = spawn(HOOK, ["--agent", "opencode", "--event", event, "--json", JSON.stringify(payload)], {
        stdio: "ignore",
        windowsHide: true,
      })
      const timer = setTimeout(resolve, 2000)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      child.on("error", done)
      child.on("exit", done)
      child.unref?.()
    })
  } catch {
    // Kotilo not installed or the hook moved: stay silent.
  }
}

const str = (value, max = MAX_TEXT) => (typeof value === "string" ? value.slice(0, max) : undefined)

function create() {
  // Sub-agent session → its root session: their permission prompts and forms show up in the root's terminal.
  const parents = new Map()
  const lastStatus = new Map()
  // Tool call id → tool name (session.tool.input.started is the only event that names the tool).
  const toolNames = new Map()
  const root = (id) => {
    let current = id
    for (let i = 0; i < 16 && parents.has(current); i++) current = parents.get(current)
    return current
  }

  return (e) => {
    if (!e || typeof e.type !== "string") return
    const d = e.data ?? {}
    const cwd = str(e.location?.directory) ?? str(d.location?.directory)
    switch (e.type) {
      case "session.created": {
        if (typeof d.parentID === "string") {
          parents.set(d.sessionID, d.parentID)
          return
        }
        return send(e.type, { sessionId: d.sessionID, cwd })
      }
      case "session.deleted": {
        const child = parents.delete(d.sessionID)
        lastStatus.delete(d.sessionID)
        return child ? undefined : send(e.type, { sessionId: d.sessionID })
      }
      case "session.status": {
        // busy / retry only, once per change; idle is reported by session.idle.
        const status = d.status?.type
        if (parents.has(d.sessionID) || lastStatus.get(d.sessionID) === status) return
        lastStatus.set(d.sessionID, status)
        if (status === "idle") return
        return send(e.type, { sessionId: d.sessionID, status: str(status, 16), cwd })
      }
      case "session.idle":
      case "session.execution.started":
      case "session.execution.succeeded":
        if (parents.has(d.sessionID)) return
        return send(e.type, { sessionId: d.sessionID, cwd })
      case "session.execution.interrupted":
        if (parents.has(d.sessionID)) return
        return send(e.type, { sessionId: d.sessionID, reason: str(d.reason, 64), cwd })
      case "session.execution.failed": {
        if (parents.has(d.sessionID)) return
        const error = d.error ?? {}
        return send(e.type, {
          sessionId: d.sessionID,
          errorType: str(error.type, 64),
          status: typeof error.status === "number" ? error.status : undefined,
          message: str(error.message, MAX_MESSAGE),
          cwd,
        })
      }
      case "permission.asked": {
        const action = str(d.action, 64)
        const resources = Array.isArray(d.resources) ? d.resources.filter((r) => typeof r === "string") : []
        const payload = { sessionId: root(d.sessionID), tool: action, canAlways: Array.isArray(d.save) && d.save.length > 0, cwd }
        if (SHELL_ACTIONS.has(action)) payload.command = str(resources.join("\n"))
        else if (PATH_ACTIONS.has(action)) payload.path = str(resources[0])
        return send(e.type, payload)
      }
      case "session.tool.input.started": {
        if (parents.has(d.sessionID) || typeof d.id !== "string") return
        if (toolNames.size >= MAX_TOOLS) toolNames.delete(toolNames.keys().next().value)
        toolNames.set(d.id, str(d.name, 64))
        return
      }
      case "session.tool.called": {
        // Only the tool's name and its path / command / pattern: never the rest of its input.
        if (parents.has(d.sessionID) || typeof d.id !== "string") return
        const input = d.input && typeof d.input === "object" ? d.input : {}
        return send(e.type, {
          sessionId: d.sessionID,
          toolUseId: str(d.id, 128),
          tool: toolNames.get(d.id),
          command: str(input.command),
          path: str(input.filePath) ?? str(input.path),
          pattern: str(input.pattern, MAX_MESSAGE),
          cwd,
        })
      }
      case "session.tool.success":
      case "session.tool.failed": {
        if (parents.has(d.sessionID) || typeof d.id !== "string") return
        const tool = toolNames.get(d.id)
        toolNames.delete(d.id)
        return send(e.type, { sessionId: d.sessionID, toolUseId: str(d.id, 128), tool })
      }
      case "permission.replied":
        return send(e.type, { sessionId: root(d.sessionID), reply: str(d.reply, 16) })
      case "form.created":
        return send(e.type, { sessionId: root(d.form?.sessionID) })
      case "form.replied":
      case "form.cancelled":
        return send(e.type, { sessionId: root(d.sessionID) })
    }
  }
}

export default {
  id: "agenthub",
  setup(ctx) {
    // The hub's own headless AI runs (D-026) and an uninstalled hook path report nothing.
    if (globalThis.process?.env?.AGENTHUB_INTERNAL === "1" || HOOK.startsWith("__")) return
    const controller = new AbortController()
    const handle = create()
    ;(async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) handle(event)
        } catch {
          // Stream ended with an error: resubscribe below.
        }
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    })()
    return () => controller.abort()
  },
}
