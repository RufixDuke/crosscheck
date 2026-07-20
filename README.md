# CrossCheck

Local-first, pre-push AI self-review CLI — review what your AI coding agent wrote before you push.

CrossCheck runs on your staged diff before you push. It clusters what changed, scores what's risky —
auth, payments, migrations, secrets — and hands you a prioritized checklist and concrete manual tests.
No account, no server, no telemetry. It works fully offline.

## What you get, in one run

- **Risk map** — every cluster of changed files, sorted by severity (▲ high, ● medium, ■ low), 24 terminal rows or fewer no matter the diff size.
- **Prioritized checklist** — concrete, checkable items tied to `file:line` evidence, not a wall of inline nitpick comments.
- **Suggested manual tests** — runnable actions like "send a forged webhook — expect 4xx and zero side effects," tied to what changed.
- **Zero network calls, by default** — the heuristic rule engine is the primary product. It works on a flaky connection with no API keys.
- **BYOK LLM summaries (optional)** — bring your own Anthropic, OpenAI, or OpenRouter key for two-sentence cluster summaries, redacted before anything leaves your machine.
- **Review history & dedup** — a local SQLite store remembers hunks you've already reviewed — content-hashed, so it survives rebases and amended commits.

## Install

Requires Node.js ≥ 18.18.

```sh
npm i -g @rufixduke/crosscheck
```

## Quickstart

From inside any git repository, stage whatever you want reviewed and run `crosscheck` with no arguments —
it reviews `git diff --cached` by default:

```sh
git add -A
crosscheck
```

No arguments means no network calls either: the heuristic rule engine — the risk map, the checklist, the
manual test suggestions — runs entirely offline.

Run `crosscheck init` to write a committed `crosscheck.config.json` so your team (even a team of one,
across machines) shares the same rules:

```sh
crosscheck init --yes
```

When you're confident in the signal, add `--strict` to a pre-push git hook or CI job so an unacknowledged
high-risk finding blocks the push.

## Commands

```
crosscheck [options] [command]

Commands:
  review [options] [range]  Full review with all flags
  history [options]         List, show, or clear past reviews
  rules [id]                List effective rules (on-by-default vs opt-in tiers); explain one in detail
  init [options]            Create crosscheck.config.json interactively
  export [options] [id]     Re-render a review as markdown/json
  help [command]            Display help for command
```

`crosscheck` and `crosscheck review` are the same command — `review` reviews the staged diff by default,
or a commit range (e.g. `crosscheck HEAD~1`).

## Honest about what it is

CrossCheck is a structured self-review checklist with a risk radar. It is **not** a proof of correctness,
not a security audit, and not a replacement for reading the diff. A fully green run is evidence you looked,
in an ordered way, at the riskiest parts — not evidence the code is correct. Rules catch patterns, not
logic. You are still the reviewer.

## License

MIT
