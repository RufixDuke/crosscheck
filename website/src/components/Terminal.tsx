import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { EXAMPLES } from "../generated/examples";

const SEVERITY_CLASS: Record<string, string> = { "▲": "sev-high", "●": "sev-medium", "■": "sev-low" };

/** Wraps ▲ ● ■ severity glyphs in their color spans; everything else passes through untouched. */
function colorizeInline(text: string): ReactNode {
  const parts = text.split(/(▲|●|■)/g);
  return parts.map((part, i) => {
    const cls = SEVERITY_CLASS[part];
    return cls !== undefined ? (
      <span key={i} className={cls}>
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}

/** Per-line pass: a line starting with ✓ reads as accent (real success output), everything else keeps inline severity coloring. */
function colorize(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <Fragment key={i}>
      {i > 0 && "\n"}
      {line.trimStart().startsWith("✓") ? <span className="term-accent">{line}</span> : colorizeInline(line)}
    </Fragment>
  ));
}

/**
 * Renders one `data-example`-style CLI transcript. Content comes ONLY from
 * src/generated/examples.ts (F11 AC4 — "no stale or invented output, ever"):
 * that file is produced by spawning the real built CLI against real temp git
 * repos (website/scripts/examples.mjs) and is drift-tested in
 * tests/integration/docs-examples.test.ts. Never hand-edit an example's text
 * here or in the generated file directly.
 */
export function Terminal({ name, label = "terminal" }: { name: string; label?: string }) {
  const example = EXAMPLES[name];
  if (example === undefined) {
    throw new Error(`unknown example "${name}" — no recipe in website/scripts/examples.mjs`);
  }

  if (example.style === "code") {
    return (
      <div className="code-wrap">
        <pre className="code-block">
          <code>{colorize(example.output)}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="terminal">
      <div className="terminal-titlebar">
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-label">{label}</span>
      </div>
      <pre>
        {example.command !== "" && (
          <>
            <span className="term-muted">$ {example.command}</span>
            {"\n"}
          </>
        )}
        {colorize(example.output)}
      </pre>
    </div>
  );
}

/**
 * Hero-only typing animation: types the install command, "runs" it, then
 * prints the real hero-demo output instantly. One-shot, skippable (click
 * anywhere on it), respects prefers-reduced-motion (renders final state).
 */
export function TypingTerminal({ name, command, label = "terminal" }: { name: string; command: string; label?: string }) {
  const example = EXAMPLES[name];
  if (example === undefined) {
    throw new Error(`unknown example "${name}" — no recipe in website/scripts/examples.mjs`);
  }

  const reducedMotion = useRef(
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  ).current;

  const [typed, setTyped] = useState(reducedMotion ? command : "");
  const [phase, setPhase] = useState<"typing" | "done">(reducedMotion ? "done" : "typing");
  const skippedRef = useRef(false);

  useEffect(() => {
    if (reducedMotion) return;
    let i = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled || skippedRef.current) return;
      i += 1;
      setTyped(command.slice(0, i));
      if (i < command.length) {
        window.setTimeout(step, 28 + Math.random() * 35);
      } else {
        window.setTimeout(() => {
          if (!cancelled) setPhase("done");
        }, 260);
      }
    };
    const start = window.setTimeout(step, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const skip = () => {
    skippedRef.current = true;
    setTyped(command);
    setPhase("done");
  };

  return (
    <div className="terminal" onClick={skip} role="presentation">
      <div className="terminal-titlebar">
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-dot" />
        <span className="terminal-label">{label}</span>
      </div>
      <pre>
        <span className="term-muted">$ </span>
        {typed}
        {phase === "typing" && <span className="type-cursor" aria-hidden="true" />}
        {phase === "done" && (
          <>
            {"\n"}
            {colorize(example.output)}
          </>
        )}
      </pre>
    </div>
  );
}
