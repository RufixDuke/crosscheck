import type { ReactNode } from "react";

interface FaqItem {
  q: string;
  a: ReactNode;
}

const ITEMS: FaqItem[] = [
  {
    q: "Does CrossCheck need an internet connection?",
    a: <p>No. It runs entirely on your machine, with no account and no API key required.</p>,
  },
  {
    q: "Is CrossCheck free?",
    a: <p>Yes, it is free and MIT-licensed, with no paid tier.</p>,
  },
  {
    q: "What do the exit codes mean?",
    a: (
      <p>
        <code>0</code> means the review ran with nothing left to flag. <code>2</code> means an operational error,
        such as running outside a git repository or an invalid range, so the review did not complete.
      </p>
    ),
  },
  {
    q: "How do I see a past review again?",
    a: (
      <p>
        Run <code>crosscheck history</code> to list past reviews, or <code>crosscheck history show &lt;id&gt;</code>{" "}
        to reprint one. <code>crosscheck history --clear</code> deletes the stored history.
      </p>
    ),
  },
  {
    q: "How do I share a review outside the terminal?",
    a: (
      <p>
        Run <code>crosscheck export</code> to re-render the current or a past review as markdown, ready to paste into
        a PR description.
      </p>
    ),
  },
  {
    q: "Does it work on languages other than TypeScript/JavaScript?",
    a: <p>Yes. Migrations, YAML, Dockerfiles, Python, Go, SQL, and shell scripts are all covered by the rule set.</p>,
  },
];

export function Faq() {
  return (
    <>
      <section className="page-intro">
        <p className="eyebrow">FAQ</p>
        <h1>Frequently asked questions</h1>
        <p className="lede">
          Didn't find your answer here? Open a discussion on{" "}
          <a href="https://github.com/RufixDuke/crosscheck">GitHub</a>.
        </p>
      </section>

      {ITEMS.map((item) => (
        <details className="faq" key={item.q}>
          <summary>{item.q}</summary>
          <div className="faq-answer">{item.a}</div>
        </details>
      ))}
    </>
  );
}
