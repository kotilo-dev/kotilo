/**
 * Open-source licenses (About, M5): a collapsed toggle that, once opened, lazy-loads
 * `THIRD_PARTY_NOTICES` into a scrollable monospace view with a line filter.
 */
import { useDeferredValue, useEffect, useId, useMemo, useState } from "react";
import { useStrings } from "./strings";
import { filterNotices, loadThirdPartyNotices } from "./licenses";

type LoadState = { phase: "loading" } | { phase: "ready"; text: string } | { phase: "error" };

export function LicensesViewer() {
  const s = useStrings().update;
  const [open, setOpen] = useState(false);
  const regionId = useId();

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((v) => !v)}
        className="self-start rounded border border-border px-1.5 py-0.5 text-label text-text"
      >
        {open ? s.licensesHide : s.licensesShow}
      </button>
      {open && (
        <div id={regionId}>
          <LicensesBody />
        </div>
      )}
    </div>
  );
}

function LicensesBody() {
  const s = useStrings().update;
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    let cancelled = false;
    loadThirdPartyNotices()
      .then((text) => {
        if (!cancelled) setState({ phase: "ready", text });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(
    () => (state.phase === "ready" ? filterNotices(state.text, deferredQuery) : null),
    [state, deferredQuery],
  );

  if (state.phase === "loading") return <div className="text-muted">{s.licensesLoading}</div>;
  if (state.phase === "error") return <div role="alert" className="text-blocked-ink">{s.licensesError}</div>;

  return (
    <section aria-label={s.licensesTitle} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label={s.licensesSearch}
          placeholder={s.licensesSearchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-control border border-border bg-surface-3 px-2 py-1 text-small text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        {filtered?.matches != null && (
          <span className="shrink-0 font-mono text-label text-muted" aria-live="polite">
            {s.licensesMatches(filtered.matches)}
          </span>
        )}
      </div>
      <pre
        tabIndex={0}
        data-testid="licenses-text"
        className="m-0 max-h-80 overflow-auto rounded-control border border-border-subtle bg-terminal p-3 font-mono text-label leading-relaxed whitespace-pre text-text-2"
      >
        {filtered?.text}
      </pre>
    </section>
  );
}
