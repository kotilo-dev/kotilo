import type { ViewerMode } from "../../../stores/viewerStore";

/**
 * Fixed renderer contract (faz3-spec §2/§3): Frontend-B fills Frontend-A's placeholders with
 * this props shape — the shape **does not change**.
 */
export interface RendererProps {
  workspaceId: string;
  rel: string;
  mode?: ViewerMode;
}
