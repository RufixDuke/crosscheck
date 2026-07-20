import { useState } from "react";
import { CopyIcon } from "./icons";

/** Static code/command sample with a copy button — for install commands, config JSON, etc. (not CLI-output examples; see <Terminal> for those). */
export function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-wrap">
      <button type="button" className={`copy-btn${copied ? " copied" : ""}`} onClick={copy}>
        {copied ? "✓ copied" : <CopyIcon />}
        {!copied && "copy"}
      </button>
      <pre className="code-block">
        <code>{children}</code>
      </pre>
    </div>
  );
}
