import { useStrings, type Strings } from "../../app/strings";
import { baseName } from "../workspaces/paths";
import { useDocument } from "../../stores/documentStore";
import { getRenderer } from "./getRenderer";
import type { ViewerMode, ViewerTab } from "../../stores/viewerStore";

interface ViewerTabItemProps {
  workspaceId: string;
  tab: ViewerTab;
  active: boolean;
  onActivate: () => void;
  onRequestClose: () => void;
}

function ViewerTabItem({ workspaceId, tab, active, onActivate, onRequestClose }: ViewerTabItemProps) {
  const strings = useStrings();
  const doc = useDocument(workspaceId, tab.rel);
  const dirty = !tab.diff && (doc?.dirty ?? false);
  const name = tab.diff ? strings.timeline.diffTab(baseName(tab.rel) || tab.rel) : baseName(tab.rel) || tab.rel;

  return (
    <div
      className={`flex h-full shrink-0 items-center gap-1 border-r border-border px-2 text-xs ${active ? "bg-bg" : "bg-transparent"} ${
        tab.missing ? "text-blocked" : "text-text"
      } ${tab.pinned ? "not-italic" : "italic"}`}
      title={tab.missing ? `${tab.rel} — ${strings.viewer.deletedOnDisk}` : tab.rel}
      onClick={onActivate}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onRequestClose();
        }
      }}
    >
      <span className="max-w-[160px] truncate">{name}</span>
      {dirty && <span className="text-accent">●</span>}
      <button
        type="button"
        title={strings.viewer.closeTabTooltip}
        onClick={(e) => {
          e.stopPropagation();
          onRequestClose();
        }}
        className="ml-1 rounded px-1 leading-none text-muted"
      >
        ×
      </button>
    </div>
  );
}

interface ViewerTabStripProps {
  workspaceId: string;
  tabs: ViewerTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onRequestClose: (tabId: string) => void;
  onSetMode: (tabId: string, mode: ViewerMode) => void;
}

function modeOptions(kind: "markdown" | "html" | "svg", strings: Strings): { value: ViewerMode; label: string }[] {
  if (kind === "markdown") {
    return [
      { value: "edit", label: strings.viewer.modeEdit },
      { value: "preview", label: strings.viewer.modePreview },
      { value: "split", label: strings.viewer.modeSplit },
    ];
  }
  return [
    { value: "edit", label: strings.viewer.modeSource },
    { value: "preview", label: strings.viewer.modePreview },
  ];
}

export function ViewerTabStrip({ workspaceId, tabs, activeTabId, onActivate, onRequestClose, onSetMode }: ViewerTabStripProps) {
  const strings = useStrings();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeKind = activeTab && !activeTab.diff ? getRenderer(activeTab.rel) : null;
  const options =
    activeTab && (activeKind === "markdown" || activeKind === "html" || activeKind === "svg") ? modeOptions(activeKind, strings) : null;

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-surface-3">
      <div className="flex flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <ViewerTabItem
            key={tab.id}
            workspaceId={workspaceId}
            tab={tab}
            active={tab.id === activeTabId}
            onActivate={() => onActivate(tab.id)}
            onRequestClose={() => onRequestClose(tab.id)}
          />
        ))}
      </div>
      {options && activeTab && (
        <div className="flex shrink-0 items-center gap-1 px-2">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSetMode(activeTab.id, opt.value)}
              className={`rounded px-1.5 py-0.5 text-label text-text ${
                (activeTab.mode ?? "preview") === opt.value ? "bg-surface-4" : "bg-transparent"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
