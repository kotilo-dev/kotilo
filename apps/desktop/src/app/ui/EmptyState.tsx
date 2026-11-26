/** Centered empty / unavailable / error state for a card or page. */
import type { ReactNode } from "react";

export function EmptyState({ title, body, action, icon }: { title: string; body?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div role="status" data-empty className="flex flex-col items-center justify-center gap-2 px-4 py-6 text-center">
      {icon && (
        <span aria-hidden="true" className="text-faint [&>svg]:size-5">
          {icon}
        </span>
      )}
      <p className="m-0 font-medium text-text-2">{title}</p>
      {body && <p className="m-0 max-w-[48ch] text-small text-muted">{body}</p>}
      {action}
    </div>
  );
}
