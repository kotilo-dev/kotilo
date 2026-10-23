/**
 * PDF renderer (faz3-spec §3/§21): `pdfjs-dist`, local worker (`?url`), data via `fsReadBytes`
 * (re-fetched on every reload — `getDocument({data})` takes over/consumes the ArrayBuffer).
 * Pages scroll vertically; visible ones render lazily via `IntersectionObserver`. The text layer
 * (`pdf_viewer.css`) is best-effort — a failure never breaks the visual render. Search: jump to
 * the first/next matching page + counter, **no highlighting** (§21). §21 note: the PDF is not a
 * text document and not tied to `documentStore`; external changes are handled by the hash watch
 * below (finding #14).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { useStrings } from "../../../app/strings";
import { fsReadBytes, fsStat, onFsChanged, onFsRescan, toAppError } from "../../../lib/ipc";
import { parentRel } from "../../workspaces/paths";
import { isModPressed } from "../../../lib/keys";
import type { RendererProps } from "./types";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const SCALE_STEP = 0.15;
const PAGE_GAP_PX = 12;

type Zoom = { kind: "fit-width" } | { kind: "scale"; value: number };

interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  registerRef: (pageNumber: number, el: HTMLDivElement | null) => void;
  onVisibilityChange: (pageNumber: number, ratio: number) => void;
  onTextExtracted: (pageNumber: number, text: string) => void;
}

function PdfPage({ pdfDoc, pageNumber, scale, registerRef, onVisibilityChange, onTextExtracted }: PdfPageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== el) continue;
          setIsVisible(entry.isIntersecting);
          onVisibilityChange(pageNumber, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
      },
      { rootMargin: "400px 0px", threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onVisibilityChange` is stable in the parent (useCallback)
  }, [pageNumber]);

  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        setViewportSize({ width: viewport.width, height: viewport.height });

        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (canvas && ctx) {
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          renderTask = page.render({ canvas, canvasContext: ctx, viewport });
          await renderTask.promise;
        }
        if (cancelled) return;

        // Text layer: best-effort (§21) — for selection/accessibility; swallow failures.
        try {
          const textLayerDiv = textLayerRef.current;
          if (textLayerDiv) {
            textLayerDiv.replaceChildren();
            textLayerDiv.style.setProperty("--total-scale-factor", String(scale));
            const textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textLayerDiv, viewport });
            await textLayer.render();
          }
        } catch {
          // ignore silently — the visual render is already done
        }

        // Search text: extracted once, cached in the parent.
        try {
          const content = await page.getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          if (!cancelled) onTextExtracted(pageNumber, text);
        } catch {
          // without its text this page just isn't searchable — silent
        }
      } catch {
        // Page failed to render — skip silently (a broken file as a whole is handled above).
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [isVisible, pdfDoc, pageNumber, scale, onTextExtracted]);

  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
        registerRef(pageNumber, el);
      }}
      data-page-number={pageNumber}
      className="relative mx-auto bg-paper shadow-md"
      style={{ width: viewportSize?.width ?? "70%", height: viewportSize?.height ?? 500, marginBottom: PAGE_GAP_PX }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="textLayer" />
      {!viewportSize && (
        <div className="flex h-full items-center justify-center text-xs text-faint">
          {pageNumber}
        </div>
      )}
    </div>
  );
}

export function PdfView({ workspaceId, rel }: RendererProps) {
  const strings = useStrings();
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const visibilityRef = useRef<Map<number, number>>(new Map());
  const textCacheRef = useRef<Map<number, string>>(new Map());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [baseWidth, setBaseWidth] = useState<number | null>(null); // width of page 1 at scale=1
  const [containerWidth, setContainerWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ kind: "fit-width" });
  const [visiblePage, setVisiblePage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [editingPageInput, setEditingPageInputState] = useState(false);
  // `onVisibilityChange` (`useCallback([])` below, so it isn't recreated while scrolling) reads
  // `editingPageInput` from this ref instead of state to avoid a stale closure.
  const editingPageInputRef = useRef(false);
  function setEditingPageInput(value: boolean): void {
    editingPageInputRef.current = value;
    setEditingPageInputState(value);
  }

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchMatches, setSearchMatches] = useState<number[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);

  // finding #14: reload on external change. `reloadKey` is an extra dependency of the load effect
  // (a bump triggers a re-fetch); `pendingPageRef` carries the page from before the reload and
  // the view scrolls back to it once the new document is ready (separate effect below).
  const [reloadKey, setReloadKey] = useState(0);
  const pendingPageRef = useRef<number | null>(null);
  const visiblePageRef = useRef(1);
  useEffect(() => {
    visiblePageRef.current = visiblePage;
  }, [visiblePage]);

  // Load the PDF — once on mount, then on every `reloadKey` bump; each load re-fetches the bytes
  // (getDocument takes them over).
  useEffect(() => {
    let cancelled = false;
    // `destroy()` lives on `PDFDocumentLoadingTask`, not `PDFDocumentProxy` — so keep the task
    // reference for cleanup.
    let loadingTaskRef: ReturnType<typeof getDocument> | null = null;
    setError(null);
    setPdfDoc(null);
    setNumPages(0);
    setBaseWidth(null);
    setVisiblePage(1);
    setPageInput("1");
    pageRefs.current.clear();
    visibilityRef.current.clear();
    textCacheRef.current.clear();
    setSearchMatches([]);
    setSearchedQuery(null);

    void (async () => {
      try {
        const bytes = await fsReadBytes(workspaceId, rel);
        if (cancelled) return;
        const loadingTask = getDocument({ data: bytes });
        loadingTaskRef = loadingTask;
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        const firstPage = await doc.getPage(1);
        if (cancelled) return;
        setBaseWidth(firstPage.getViewport({ scale: 1 }).width);
      } catch (e) {
        if (!cancelled) setError(strings.errors.forCode(toAppError(e).code));
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTaskRef) void loadingTaskRef.destroy();
    };
  }, [workspaceId, rel, reloadKey]);

  // finding #14: once the new document is ready (numPages known), scroll to the page held from
  // before the reload (zoom isn't reset by the load effect, so it is kept).
  useEffect(() => {
    if (!pdfDoc || pendingPageRef.current === null) return;
    const target = Math.min(pendingPageRef.current, Math.max(1, numPages));
    pendingPageRef.current = null;
    // Page DOM nodes mount after this render (not yet observed) — a best-effort short delay
    // (§14 "if easy").
    const id = setTimeout(() => scrollToPage(target), 50);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `scrollToPage` is recreated per render but behaves the same
  }, [pdfDoc, numPages]);

  // finding #14: external change watch — StrictMode-safe (cancelled flag), `fs:changed` for
  // `parentRel(rel)` plus every `fs:rescan`; compares the `fs_stat` hash and on a change bumps
  // `reloadKey` (keeping the current page in `pendingPageRef`).
  useEffect(() => {
    let cancelled = false;
    let unlistenChanged: (() => void) | undefined;
    let unlistenRescan: (() => void) | undefined;
    let lastHash: string | null = null;

    async function checkForChange() {
      try {
        const stat = await fsStat(workspaceId, rel);
        if (cancelled) return;
        if (lastHash !== null && stat.hash !== lastHash) {
          pendingPageRef.current = visiblePageRef.current;
          setReloadKey((k) => k + 1);
        }
        lastHash = stat.hash;
      } catch {
        // The file may be gone — viewerStore's "Deleted on disk" flow handles that; silent here.
      }
    }

    void checkForChange(); // baseline hash

    void onFsChanged(({ workspaceId: ws, dirs }) => {
      if (cancelled || ws !== workspaceId) return;
      if (dirs.includes(parentRel(rel))) void checkForChange();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenChanged = fn;
    });

    void onFsRescan(({ workspaceId: ws }) => {
      if (cancelled || ws !== workspaceId) return;
      void checkForChange();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRescan = fn;
    });

    return () => {
      cancelled = true;
      unlistenChanged?.();
      unlistenRescan?.();
    };
  }, [workspaceId, rel]);

  // Width of the scroll area — for the "Fit width" calculation.
  useEffect(() => {
    const el = scrollAreaRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const effectiveScale = (() => {
    if (zoom.kind === "scale") return zoom.value;
    if (!baseWidth || containerWidth <= 0) return 1;
    const usable = containerWidth - PAGE_GAP_PX * 2;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, usable / baseWidth));
  })();

  const registerRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNumber, el);
    else pageRefs.current.delete(pageNumber);
  }, []);

  const onVisibilityChange = useCallback((pageNumber: number, ratio: number) => {
    visibilityRef.current.set(pageNumber, ratio);
    let best = pageNumber;
    let bestRatio = -1;
    for (const [p, r] of visibilityRef.current) {
      if (r > bestRatio) {
        bestRatio = r;
        best = p;
      }
    }
    if (bestRatio > 0) {
      setVisiblePage(best);
      setPageInput((prev) => (editingPageInputRef.current ? prev : String(best)));
    }
  }, []);

  const onTextExtracted = useCallback((pageNumber: number, text: string) => {
    textCacheRef.current.set(pageNumber, text);
  }, []);

  function scrollToPage(pageNumber: number) {
    const el = pageRefs.current.get(pageNumber);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function commitPageInput() {
    setEditingPageInput(false);
    const n = Math.min(Math.max(1, Number.parseInt(pageInput, 10) || 1), Math.max(1, numPages));
    setPageInput(String(n));
    scrollToPage(n);
  }

  async function extractPageText(pageNumber: number): Promise<string> {
    const cached = textCacheRef.current.get(pageNumber);
    if (cached !== undefined) return cached;
    if (!pdfDoc) return "";
    try {
      const page = await pdfDoc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      textCacheRef.current.set(pageNumber, text);
      return text;
    } catch {
      return "";
    }
  }

  // Search: scans every page when the query changes (debounced) — independent of the visual
  // render (text of off-screen pages is fetched here too).
  useEffect(() => {
    if (!searchOpen || !pdfDoc) return;
    const query = searchQuery.trim();
    if (query === "") {
      setSearchMatches([]);
      setSearchedQuery(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const lower = query.toLowerCase();
        const matches: number[] = [];
        for (let n = 1; n <= numPages; n++) {
          if (cancelled) return;
          const text = await extractPageText(n);
          if (text.toLowerCase().includes(lower)) matches.push(n);
        }
        if (cancelled) return;
        setSearchMatches(matches);
        setSearchIndex(0);
        setSearchedQuery(query);
        setSearching(false);
        if (matches.length > 0) scrollToPage(matches[0]!);
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `extractPageText` is recreated per render but behaves the same
  }, [searchOpen, searchQuery, pdfDoc, numPages]);

  function goToMatch(direction: 1 | -1) {
    if (searchMatches.length === 0) return;
    const next = (searchIndex + direction + searchMatches.length) % searchMatches.length;
    setSearchIndex(next);
    scrollToPage(searchMatches[next]!);
  }

  function openSearch() {
    setSearchOpen(true);
    // Focus once the box has mounted.
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchMatches([]);
    setSearchedQuery(null);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (isModPressed(e) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === "Escape" && searchOpen) {
      e.preventDefault();
      closeSearch();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-2 py-1 text-label text-text">
        <div className="flex items-center gap-1">
          <input
            type="text"
            title={strings.viewer.pdf.pageInputTitle}
            value={editingPageInput ? pageInput : String(visiblePage)}
            onFocus={() => setEditingPageInput(true)}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPageInput();
            }}
            className="w-10 rounded border border-border bg-bg px-1 py-0.5 text-center text-text"
          />
          <span className="text-muted">{strings.viewer.pdf.of(numPages)}</span>
        </div>

        <div className="flex items-center gap-1">
          <button type="button" title={strings.viewer.pdf.zoomOut} className="rounded px-1.5 py-0.5" onClick={() => setZoom((z) => ({ kind: "scale", value: Math.max(MIN_SCALE, (z.kind === "scale" ? z.value : effectiveScale) - SCALE_STEP) }))}>
            −
          </button>
          <button type="button" title={strings.viewer.pdf.zoomIn} className="rounded px-1.5 py-0.5" onClick={() => setZoom((z) => ({ kind: "scale", value: Math.min(MAX_SCALE, (z.kind === "scale" ? z.value : effectiveScale) + SCALE_STEP) }))}>
            +
          </button>
          <button
            type="button"
            onClick={() => setZoom({ kind: "fit-width" })}
            className={`rounded px-1.5 py-0.5 ${zoom.kind === "fit-width" ? "bg-surface-4" : "bg-transparent"}`}
          >
            {strings.viewer.pdf.fitWidth}
          </button>
          <span className="text-muted">{Math.round(effectiveScale * 100)}%</span>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {searchOpen ? (
            <>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                placeholder={strings.viewer.pdf.searchPlaceholder}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goToMatch(e.shiftKey ? -1 : 1);
                  if (e.key === "Escape") closeSearch();
                }}
                className="w-40 rounded border border-border bg-bg px-1.5 py-0.5 text-text"
              />
              <span className="text-muted">
                {searching
                  ? strings.viewer.pdf.searching
                  : searchedQuery === null
                    ? ""
                    : searchMatches.length === 0
                      ? strings.viewer.pdf.noMatches
                      : strings.viewer.pdf.matchCounter(searchIndex + 1, searchMatches.length)}
              </span>
              <button type="button" title={strings.viewer.pdf.prevMatch} onClick={() => goToMatch(-1)} disabled={searchMatches.length === 0}>
                ‹
              </button>
              <button type="button" title={strings.viewer.pdf.nextMatch} onClick={() => goToMatch(1)} disabled={searchMatches.length === 0}>
                ›
              </button>
              <button type="button" title={strings.viewer.pdf.closeSearch} onClick={closeSearch}>
                ×
              </button>
            </>
          ) : (
            <button type="button" title={strings.viewer.pdf.searchTooltip} onClick={openSearch}>
              🔍
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex-1 p-4 text-xs text-blocked">
          {strings.viewer.pdf.loadError}: {error}
        </div>
      ) : (
        <div
          ref={scrollAreaRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          className="min-h-0 flex-1 overflow-auto bg-surface-1 p-3 outline-none"
        >
          {pdfDoc &&
            Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
              <PdfPage
                key={n}
                pdfDoc={pdfDoc}
                pageNumber={n}
                scale={effectiveScale}
                registerRef={registerRef}
                onVisibilityChange={onVisibilityChange}
                onTextExtracted={onTextExtracted}
              />
            ))}
        </div>
      )}
    </div>
  );
}
