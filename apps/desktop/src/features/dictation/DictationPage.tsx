/**
 * Dictation screen (M2, CCC spec §22): speech model status and downloads, and the dictation
 * history, and (M2b) whether the live dictation shortcuts are registered. Options live in
 * Settings → Dictation.
 */
import { useEffect, useState } from "react";
import { formatDateTime, formatNumber, formatPercent, useStrings } from "../../app/i18n";
import { ConfirmModal } from "../../app/ConfirmModal";
import { clipboardWriteText, dictationStatus, hubRequest, onDictationDone, type DictationStatus } from "../../lib/ipc";
import type { DictationModel, DictationRecord } from "../../lib/hubTypes";
import { useToastStore } from "../../stores/toastStore";
import { Button, Card, EmptyState, Notice, Page, PageHeader, ProgressBar, SectionLabel } from "../settings/controls";
import { asAppError, useHubResource } from "../settings/hubData";

const POLL_MS = 1000;

/** `574 MB` / `1.2 GB` in the active locale. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${formatNumber(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GB`;
  return `${formatNumber(Math.round(bytes / 1024 ** 2))} MB`;
}

/** The desktop's dictation state; null until known or when the command is not available. */
function useDictationStatus(): DictationStatus | null {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  useEffect(() => {
    let alive = true;
    dictationStatus()
      .then((st) => alive && setStatus(st))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

function HotkeyStatus({ status }: { status: DictationStatus }) {
  const s = useStrings();
  if (!status.enabled) return <Notice>{s.dictation.disabled}</Notice>;
  const problems = [status.hotkey, status.pasteLastHotkey].filter((h) => h.error !== null);
  return (
    <>
      <Notice>{s.dictation.hotkeysLine(status.hotkey.gesture, status.pasteLastHotkey.gesture)}</Notice>
      {problems.map((h) => (
        <Notice key={h.gesture} tone="warning">
          {h.error === "taken" ? s.dictation.hotkeyTaken(h.gesture) : s.dictation.hotkeyInvalid(h.gesture)}
        </Notice>
      ))}
    </>
  );
}

type Confirm = { kind: "model"; model: DictationModel } | { kind: "clear" } | null;

export function DictationPage() {
  const s = useStrings();
  const models = useHubResource<DictationModel[]>("/v1/dictation/models");
  const history = useHubResource<DictationRecord[]>("/v1/dictations?limit=200");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const downloading = models.data?.some((m) => m.downloading) ?? false;
  const status = useDictationStatus();

  // A finished dictation adds a history row.
  const reloadHistory = history.reload;
  useEffect(() => {
    const unlisten = onDictationDone(() => void reloadHistory());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [reloadHistory]);

  // Download progress is not on the stream yet: poll while any model downloads.
  const reloadModels = models.reload;
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => void reloadModels(), POLL_MS);
    return () => clearInterval(t);
  }, [downloading, reloadModels]);

  async function act(action: () => Promise<unknown>, reload: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      useToastStore.getState().show(asAppError(e).message);
    }
    await reload();
  }

  return (
    <Page>
      <PageHeader title={s.dictation.title} subtitle={s.dictation.subtitle} />
      {status && <HotkeyStatus status={status} />}
      {(models.unavailable || history.unavailable) && <Notice tone="warning">{s.errors.forCode("hub_unavailable")}</Notice>}

      <section aria-labelledby="dictation-models" className="flex flex-col gap-2">
        <SectionLabel id="dictation-models">{s.dictation.models}</SectionLabel>
        <div className="grid gap-3 md:grid-cols-2">
          {(models.data ?? []).map((m) => {
            const name = s.dictation.modelNames[m.id];
            return (
              <Card key={m.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-2">
                  <span className="text-title font-semibold text-text">{name}</span>
                  {m.selected && <span className="rounded-badge bg-accent-soft px-1.5 py-0.5 text-label text-accent">{s.dictation.inUse}</span>}
                  <span className="flex-1" />
                  <span className="font-mono text-small text-muted">{formatBytes(m.size)}</span>
                </div>
                <span className={`text-small ${m.installed ? "text-idle-ink" : "text-muted"}`}>{m.installed ? s.dictation.installed : s.dictation.notInstalled}</span>
                {m.downloading && (
                  <div className="flex flex-col gap-1">
                    <ProgressBar value={(m.progress ?? 0) * 100} label={name} />
                    <span className="font-mono text-meta text-muted">{s.dictation.downloading(formatPercent(m.progress ?? 0))}</span>
                  </div>
                )}
                {m.error && <span className="text-small text-blocked-ink">{s.dictation.modelError(m.error)}</span>}
                <div className="flex gap-2">
                  {m.downloading ? (
                    <Button small onClick={() => void act(() => hubRequest("POST", `/v1/dictation/models/${m.id}/cancel`), models.reload)}>
                      {s.dictation.cancel}
                    </Button>
                  ) : !m.installed ? (
                    <Button small variant="primary" onClick={() => void act(() => hubRequest("POST", `/v1/dictation/models/${m.id}/download`), models.reload)}>
                      {m.partialBytes > 0 ? s.dictation.resume : s.dictation.download}
                    </Button>
                  ) : (
                    <Button small variant="danger" onClick={() => setConfirm({ kind: "model", model: m })}>
                      {s.dictation.delete}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="dictation-history" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SectionLabel id="dictation-history">{s.dictation.history}</SectionLabel>
          <span className="flex-1" />
          {(history.data?.length ?? 0) > 0 && (
            <Button small variant="danger" onClick={() => setConfirm({ kind: "clear" })}>
              {s.dictation.clearAll}
            </Button>
          )}
        </div>
        {history.data && history.data.length === 0 && <EmptyState title={s.dictation.historyEmpty} />}
        {history.data && history.data.length > 0 && (
          <Card>
            <ul className="m-0 flex list-none flex-col p-0">
              {history.data.map((r) => (
                <li key={r.id} className="flex flex-col gap-1.5 border-b border-border-subtle px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-2 text-meta text-muted">
                    <span className="font-mono">{formatDateTime(new Date(r.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span>
                    <span className="font-mono">{s.dictation.duration(formatNumber(r.durationSeconds, { maximumFractionDigits: 1 }))}</span>
                    <span className="flex-1" />
                    <Button
                      small
                      variant="ghost"
                      onClick={() =>
                        void clipboardWriteText(r.finalText).then(() => {
                          setCopiedId(r.id);
                          setTimeout(() => setCopiedId((id) => (id === r.id ? null : id)), 1500);
                        })
                      }
                    >
                      {copiedId === r.id ? s.dictation.copied : s.dictation.copy}
                    </Button>
                    <Button small variant="ghost" ariaLabel={s.dictation.deleteEntryLabel} onClick={() => void act(() => hubRequest("DELETE", `/v1/dictations/${r.id}`), history.reload)}>
                      {s.dictation.deleteEntry}
                    </Button>
                  </div>
                  <p className="m-0 whitespace-pre-wrap text-ui text-text">{r.finalText}</p>
                  {r.cleaned && r.rawText !== r.finalText && (
                    <details className="text-small text-muted">
                      <summary className="cursor-pointer">{s.dictation.beforeCleanup}</summary>
                      <p className="m-0 mt-1 whitespace-pre-wrap">{r.rawText}</p>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      {confirm?.kind === "model" && (
        <ConfirmModal
          title={s.dictation.deleteTitle}
          body={s.dictation.deleteBody(s.dictation.modelNames[confirm.model.id])}
          confirmLabel={s.dictation.delete}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const id = confirm.model.id;
            setConfirm(null);
            void act(() => hubRequest("DELETE", `/v1/dictation/models/${id}`), models.reload);
          }}
        />
      )}
      {confirm?.kind === "clear" && (
        <ConfirmModal
          title={s.dictation.clearTitle}
          body={s.dictation.clearBody}
          confirmLabel={s.dictation.clearAll}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void act(() => hubRequest("DELETE", "/v1/dictations"), history.reload);
          }}
        />
      )}
    </Page>
  );
}
