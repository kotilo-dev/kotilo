/**
 * Image/SVG renderer (faz3-spec §3): one component for raster (png/jpg/jpeg/gif/webp/bmp/ico) and
 * svg. SVG in `mode === "edit"` (Source) is a real TextEditor; everything else (raster always,
 * svg in "preview") is `<img src=adfsUrl+?v=hash>` — Fit / 100% / zoom (Ctrl+wheel, −/+),
 * checkerboard background, footer `W × H px · <size>`. The SVG hash comes from `documentStore`
 * (already loaded as a TEXTUAL_KIND); raster images refresh on external change via `fs_stat` +
 * `fs:changed`.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useStrings } from "../../../app/strings";
import { adfsUrl, fsStat, onFsChanged } from "../../../lib/ipc";
import { parentRel } from "../../workspaces/paths";
import { useDocument } from "../../../stores/documentStore";
import { TextEditor } from "./TextEditor";
import type { RendererProps } from "./types";

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const SCALE_STEP = 0.15;

type Zoom = { kind: "fit" } | { kind: "actual" } | { kind: "scale"; value: number };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIdx]}`;
}

// Review #20: colours come from the theme tokens in `index.css` (`--checkerboard-a/b`) — they
// used to be hard-coded dark tones, nearly invisible against the light theme background.
const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, var(--checkerboard-a) 25%, transparent 25%), linear-gradient(-45deg, var(--checkerboard-a) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--checkerboard-a) 75%), linear-gradient(-45deg, transparent 75%, var(--checkerboard-a) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
  backgroundColor: "var(--checkerboard-b)",
};

/** Hash for a raster image: not in `documentStore`, tracked via `fs_stat` + `fs:changed`. */
function useRasterHash(workspaceId: string, rel: string, active: boolean): string | null {
  const [hash, setHash] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => {
      void fsStat(workspaceId, rel).then(
        (stat) => {
          if (!cancelled) setHash(stat.hash);
        },
        () => {
          if (!cancelled) setHash(null);
        },
      );
    };
    refresh();
    const unlistenPromise = onFsChanged(({ workspaceId: ws, dirs }) => {
      if (ws !== workspaceId) return;
      if (dirs.includes(parentRel(rel))) refresh();
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [workspaceId, rel, active]);

  return hash;
}

function ImagePreview({ workspaceId, rel, hash }: { workspaceId: string; rel: string; hash: string | null }) {
  const strings = useStrings();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ kind: "fit" });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    setNatural(null);
    void fsStat(workspaceId, rel).then(
      (stat) => setSize(stat.size),
      () => setSize(null),
    );
  }, [workspaceId, rel, hash]);

  // Ctrl+wheel zoom: React's `onWheel` is attached as a passive listener (preventDefault has no
  // effect) — so a native, non-passive listener is needed.
  useEffect(() => {
    const maybeEl = scrollRef.current;
    if (!maybeEl) return;
    const el: HTMLDivElement = maybeEl; // TS doesn't keep null-check narrowing inside closures — rebind to a const
    function handler(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => {
        const current = z.kind === "scale" ? z.value : z.kind === "actual" ? 1 : natural ? el.clientWidth / natural.width : 1;
        const next = current + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP) * current;
        return { kind: "scale", value: Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)) };
      });
    }
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [natural]);

  // finding #15: no `<img>` until the hash is known — otherwise the first render requests `?v=0`
  // and the `src` change once the hash arrives (`fs_stat`) fires a **second** request (the same
  // image downloaded twice).
  const src = hash !== null ? `${adfsUrl(workspaceId, rel)}?v=${encodeURIComponent(hash)}` : null;

  let imgStyle: CSSProperties;
  if (zoom.kind === "fit") {
    imgStyle = { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto", objectFit: "contain" };
  } else {
    const scale = zoom.kind === "actual" ? 1 : zoom.value;
    imgStyle = natural
      ? { width: natural.width * scale, height: natural.height * scale }
      : { width: `${scale * 100}%`, height: "auto" };
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-label text-text">
        <button
          type="button"
          onClick={() => setZoom({ kind: "fit" })}
          className={`rounded px-1.5 py-0.5 ${zoom.kind === "fit" ? "bg-surface-4" : "bg-transparent"}`}
        >
          {strings.viewer.image.fit}
        </button>
        <button
          type="button"
          onClick={() => setZoom({ kind: "actual" })}
          className={`rounded px-1.5 py-0.5 ${zoom.kind === "actual" ? "bg-surface-4" : "bg-transparent"}`}
        >
          {strings.viewer.image.actualSize}
        </button>
        <button
          type="button"
          title={strings.viewer.image.zoomOut}
          className="rounded px-1.5 py-0.5"
          onClick={() =>
            setZoom((z) => ({ kind: "scale", value: Math.max(MIN_SCALE, (z.kind === "scale" ? z.value : 1) - SCALE_STEP) }))
          }
        >
          −
        </button>
        <button
          type="button"
          title={strings.viewer.image.zoomIn}
          className="rounded px-1.5 py-0.5"
          onClick={() =>
            setZoom((z) => ({ kind: "scale", value: Math.min(MAX_SCALE, (z.kind === "scale" ? z.value : 1) + SCALE_STEP) }))
          }
        >
          +
        </button>
        {zoom.kind === "scale" && <span className="text-muted">{Math.round(zoom.value * 100)}%</span>}
      </div>
      <div ref={scrollRef} className="flex min-h-0 flex-1 items-center justify-center overflow-auto" style={CHECKERBOARD_STYLE}>
        {src && (
          // eslint-disable-next-line jsx-a11y/alt-text -- the file name is enough, there is no other alt text source
          <img
            src={src}
            alt={rel}
            style={imgStyle}
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border px-2 py-1 text-label text-muted">
        {natural && size !== null ? strings.viewer.image.footer(natural.width, natural.height, formatSize(size)) : ""}
      </div>
    </div>
  );
}

export function ImageView({ workspaceId, rel, mode }: RendererProps) {
  const isSvg = rel.toLowerCase().endsWith(".svg");
  const effectiveMode = isSvg ? mode ?? "preview" : "preview";

  // The SVG source is in `documentStore` (ViewerPanel's TEXTUAL_KINDS) — the hash comes from
  // there; raster images watch `fs_stat` separately.
  const svgDoc = useDocument(workspaceId, isSvg ? rel : "");
  const rasterHash = useRasterHash(workspaceId, rel, !isSvg);

  if (isSvg && effectiveMode === "edit") {
    return <TextEditor workspaceId={workspaceId} rel={rel} language="xml" />;
  }

  const hash = isSvg ? (svgDoc?.status === "ready" ? svgDoc.hash : null) : rasterHash;
  return <ImagePreview workspaceId={workspaceId} rel={rel} hash={hash} />;
}
