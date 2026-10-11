/**
 * Small icons of the assistant popup (DESIGN_SYSTEM §5: 24px grid, 2px round strokes, no
 * fill, decorative – the button carries the label).
 */
import type { ReactNode } from "react";

function Svg({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function CopyIcon() {
  return (
    <Svg size={14}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Svg>
  );
}

export function CheckIcon() {
  return (
    <Svg size={14}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function NewChatIcon() {
  return (
    <Svg>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

export function SendIcon() {
  return (
    <Svg>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Svg>
  );
}

export function StopIcon() {
  return (
    <Svg size={14}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Svg>
  );
}

export function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
    </Svg>
  );
}

export function SettingsIcon() {
  return (
    <Svg size={14}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </Svg>
  );
}
