import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspacePanelStore } from "../../stores/workspacePanelStore";
import { useAgentStore } from "../../stores/agentStore";
import { useStrings } from "../../app/strings";
import { pushModalOpen } from "../../app/modalStack";
import type { Workspace } from "../../lib/ipc";
import { urgentStateForWorkspace } from "../agents/agentLogic";
import { AgentStatePill } from "./AgentStatePill";
import { useGitHead } from "./useGitHead";
import { groupedWorkspaces } from "./groups";

function SwitcherOption({
  workspace,
  isActive,
  isCursor,
  onPick,
  onHover,
}: {
  workspace: Workspace;
  isActive: boolean;
  isCursor: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const urgent = useAgentStore((s) => urgentStateForWorkspace(s.agents, workspace.id));
  return (
    <div
      role="option"
      aria-selected={isActive}
      data-workspace-id={workspace.id}
      className={`flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-small ${isCursor ? "bg-surface-4" : ""}`}
      onClick={onPick}
      onMouseMove={onHover}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-accent" : "border-[1.5px] border-faint"}`}
      />
      <span className={`min-w-0 flex-1 truncate ${isActive ? "font-semibold" : ""}`}>{workspace.name}</span>
      <AgentStatePill state={urgent} />
    </div>
  );
}

/**
 * The Files tab's header control: "● name ▾ branch" opens a quick switcher (search, pick,
 * "Manage workspaces…"). The popover is positioned against the panel (the nearest `relative`
 * ancestor) and closes with Esc (before any other key handler sees it) or a click outside.
 */
export function WorkspaceSwitcher({ workspace }: { workspace: Workspace }) {
  const strings = useStrings();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const groups = useWorkspaceStore((s) => s.groups);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const setTab = useWorkspacePanelStore((s) => s.setTab);
  const head = useGitHead(workspace.id);
  const branch = head ? (head.kind === "branch" ? head.name : head.sha) : null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const searching = query.trim() !== "";
  // Sections in display order; a typed query flattens them into plain matches (no headers).
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q !== "") return [{ group: null, workspaces: workspaces.filter((w) => w.name.toLowerCase().includes(q)) }];
    return groupedWorkspaces(workspaces, groups).filter((s) => s.workspaces.length > 0);
  }, [workspaces, groups, query]);
  // The cursor indexes this flat list, so headers are skipped by construction.
  const matches = useMemo(() => sections.flatMap((s) => s.workspaces), [sections]);
  const showHeaders = !searching && groups.length > 0;

  function close(restoreFocus = true) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) buttonRef.current?.focus();
  }

  function openPopover() {
    setCursor(Math.max(0, matches.findIndex((w) => w.id === workspace.id)));
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const pop = pushModalOpen();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Close first and keep Esc away from the rest of the app (viewer, terminal, …).
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      pop();
    };
    // `close` only touches setters and a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  function pick(w: Workspace) {
    if (w.id !== workspace.id) void setActive(w.id);
    close();
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={strings.workspaces.switchTooltip}
        title={strings.workspaces.switchTooltip}
        onClick={() => (open ? close() : openPopover())}
        className="-ml-1.5 flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-text hover:bg-surface-4"
      >
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
        <span data-testid="files-workspace-name" className="max-w-[65%] shrink-0 truncate text-ui font-semibold">
          {workspace.name}
        </span>
        <span aria-hidden className="shrink-0 text-muted">▾</span>
        {branch && (
          <span data-testid="files-branch" className="min-w-0 truncate font-mono text-label text-muted">
            {branch}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="absolute inset-x-0 bottom-0 top-[34px] z-40 cursor-default bg-scrim"
            onClick={() => close()}
          />
          <div className="absolute inset-x-1.5 top-[72px] z-50 flex flex-col gap-0.5 rounded-lg border border-border bg-surface-5 p-1.5 text-xs text-text shadow-float">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls="workspace-switcher-list"
              aria-label={strings.workspaces.switcherLabel}
              placeholder={strings.workspaces.switcherPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, matches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const target = matches[cursor];
                  if (target) pick(target);
                }
              }}
              className="mb-1 h-7 rounded-sm border border-border bg-bg px-2 text-small text-text outline-none focus:border-accent"
            />
            <div id="workspace-switcher-list" role="listbox" aria-label={strings.workspaces.listLabel} className="flex max-h-60 flex-col gap-0.5 overflow-auto">
              {sections.map((section) => (
                <div key={section.group?.id ?? "ungrouped"} className="flex flex-col gap-0.5">
                  {showHeaders && (
                    <div role="presentation" data-testid="switcher-group-label" className={`truncate px-2 pb-0.5 pt-1.5 text-label tracking-wide text-muted ${section.group ? "" : "uppercase"}`}>
                      {section.group?.name ?? strings.workspaces.ungrouped}
                    </div>
                  )}
                  {section.workspaces.map((w) => {
                    const i = matches.indexOf(w);
                    return (
                      <SwitcherOption
                        key={w.id}
                        workspace={w}
                        isActive={w.id === workspace.id}
                        isCursor={i === cursor}
                        onPick={() => pick(w)}
                        onHover={() => setCursor(i)}
                      />
                    );
                  })}
                </div>
              ))}
              {matches.length === 0 && <div className="px-2 py-1.5 text-muted">{strings.workspaces.switcherNoMatches}</div>}
            </div>
            <div className="my-1 border-t border-border-subtle" />
            <button
              type="button"
              className="cursor-pointer rounded-sm px-2 py-1.5 text-left text-small text-text-2 hover:bg-surface-4"
              onClick={() => {
                close(false);
                setTab("workspaces");
              }}
            >
              {strings.workspaces.manage}
            </button>
          </div>
        </>
      )}
    </>
  );
}
