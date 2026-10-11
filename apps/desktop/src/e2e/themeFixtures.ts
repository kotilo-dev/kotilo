/**
 * D-057 e2e fixtures: what `terminal_wt_schemes` returns – two of Windows Terminal's built-in
 * schemes (values from microsoft/terminal `defaults.json`; selection as Windows Terminal's default).
 */
import type { TerminalScheme } from "../lib/ipc";

export const wtSchemes: TerminalScheme[] = [
  {
    name: "One Half Dark",
    background: "#282c34",
    foreground: "#dcdfe4",
    cursor: "#ffffff",
    selection: "#ffffff",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#dcdfe4",
    brightBlack: "#5a6374",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#dcdfe4",
  },
  {
    name: "Tango Dark",
    background: "#000000",
    foreground: "#d3d7cf",
    cursor: "#ffffff",
    selection: "#ffffff",
    black: "#000000",
    red: "#cc0000",
    green: "#4e9a06",
    yellow: "#c4a000",
    blue: "#3465a4",
    magenta: "#75507b",
    cyan: "#06989a",
    white: "#d3d7cf",
    brightBlack: "#555753",
    brightRed: "#ef2929",
    brightGreen: "#8ae234",
    brightYellow: "#fce94f",
    brightBlue: "#729fcf",
    brightMagenta: "#ad7fa8",
    brightCyan: "#34e2e2",
    brightWhite: "#eeeeec",
  },
];
