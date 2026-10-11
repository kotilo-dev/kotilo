import { useToastStore } from "../../stores/toastStore";

/** Simple toast stack in the bottom right; each toast disappears after 3 s (faz2-spec §6). */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-8 right-2 z-[100] flex flex-col gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded border border-border bg-surface-1 px-3 py-1.5 text-xs text-text shadow-lg"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
