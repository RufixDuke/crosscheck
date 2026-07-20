/**
 * Report renderer entry point — §5.7/§6.1 step 6.
 *
 * `render(report, format)` dispatches to one of three format-specific,
 * pure functions. Terminal styling (color) is opt-in via `options.color`,
 * defaulting to `false` (no ANSI) so this function is safe to call without
 * a TTY context — the CLI layer decides `isTTY`/`--no-color`/`NO_COLOR`
 * and passes the resolved boolean through.
 */
import type { ReviewReport } from "../types.js";
import { renderJson } from "./json.js";
import { renderMarkdown } from "./markdown.js";
import { renderTerminal } from "./terminal.js";

export type RenderFormat = "terminal" | "markdown" | "json";

export interface RenderOptions {
  /** Emit ANSI color codes (terminal format only). Default false. */
  color?: boolean;
  /** Expand truncated sections and show rule ids (terminal format only). */
  verbose?: boolean;
}

export function render(report: ReviewReport, format: RenderFormat, options: RenderOptions = {}): string {
  switch (format) {
    case "terminal":
      return renderTerminal(report, { color: options.color ?? false, verbose: options.verbose ?? false });
    case "markdown":
      return renderMarkdown(report);
    case "json":
      return renderJson(report);
    default: {
      const exhaustive: never = format;
      throw new Error(`unknown render format: ${String(exhaustive)}`);
    }
  }
}

export { renderJson } from "./json.js";
export { renderMarkdown } from "./markdown.js";
export { renderTerminal, type TerminalRenderOptions } from "./terminal.js";
