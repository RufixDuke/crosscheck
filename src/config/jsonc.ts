/**
 * Minimal JSONC sanitizer for config files (§12.2 shows the spec file with
 * comments; real users will paste them). Strips `//` line comments,
 * `/* ... *\/` block comments, and trailing commas so the result can be fed
 * to `JSON.parse`.
 *
 * String-aware state machine: `//` or `/*` inside a string literal (e.g.
 * "https://example.com" or a regex pattern) is never touched, and quotes
 * inside comments do not open strings.
 */

/** Returns `text` with comments and trailing commas removed. */
export function sanitizeJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        // Escape sequence: copy the next char verbatim (handles \" and \\).
        if (i + 1 < n) out += text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      // Line comment: drop everything up to (but not including) the newline.
      while (i < n && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      // Block comment: drop through the closing */; leave one space so
      // adjacent tokens never fuse.
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += text[i + 1]!;
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") continue; // trailing comma — drop it
    }
    out += ch;
  }
  return out;
}
