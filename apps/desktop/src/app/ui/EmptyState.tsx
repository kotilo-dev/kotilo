/** Centered empty / unavailable / error state for a card or page. */
import type { ReactNode } from "react";

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      <p className="m-0 font-medium text-text-2">{title}</p>
      {body && <p className="m-0 max-w-[48ch] text-small text-muted">{body}</p>}
      {action}
    </div>
  );
}
