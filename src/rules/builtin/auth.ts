/**
 * Built-in rules — auth/session category (§7.2): 3 rules, all on by default,
 * all archetype A2 (removed-guard; middleware-touched watches the file class
 * where guards disappear).
 */
import type { AstMatcher, RiskRule } from "../../types.js";

export const AUTH_RULES: RiskRule[] = [
  {
    id: "auth/middleware-touched",
    name: "Auth middleware touched",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    description:
      "Auth plumbing is where guards disappear during agent refactors; any edit there merits a human re-verification of the whole flow.",
    when: {
      fileGlobs: ["**/auth/**", "**/middleware.*"],
    },
    then: {
      message: "Auth middleware/session plumbing changed",
      checklist: [
        "Auth plumbing changed — re-verify the auth flow end to end",
        "Confirm every route that was protected before is still protected now",
        "Check that session creation, rotation, and invalidation paths are unchanged in behavior",
        "Confirm middleware ordering: auth still runs before any handler logic",
      ],
      manualTests: [
        "Log in, exercise the changed flow, and log out — expect no behavior change",
        "Hit a protected route without a session — expect a redirect/401, never the payload",
        "Hit a protected route with an expired session — expect rejection and a fresh login prompt",
      ],
    },
  },
  {
    id: "auth/permission-check-removed",
    name: "Permission check removed",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    description:
      "A removed requireAuth/authorize/checkPermission call is the classic agent refactor casualty — near-zero noise floor, always worth flagging.",
    when: {
      removedLines: ["\\b(requireAuth|authorize|checkPermission)\\b"],
    },
    then: {
      message: "Authorization/permission check removed",
      checklist: [
        "Confirm every route that lost a `requireAuth`/`authorize` call is intentionally public",
        "Diff the route table against the previous version and account for every lost guard",
        "If the check moved into shared middleware, confirm the middleware actually covers these routes",
        "Check for privilege-escalation paths: can a lower role now reach this handler?",
      ],
      manualTests: [
        "Call each affected endpoint with no session — expect 401/redirect",
        "Call each affected endpoint as a non-privileged user — expect 403",
      ],
    },
  },
  {
    id: "auth/session-rewrite",
    name: "Session/password verification rewritten",
    category: "auth/session",
    severity: "high",
    enabledByDefault: true,
    archetype: "A2",
    description:
      "When a compare/session call disappears from the code, logins either broke or silently stopped verifying — both are ship-blockers.",
    when: {
      ast: [
        // Removed-code matcher (internal `target` extension, see engine):
        // fires when a bcrypt/compareSync call is deleted by the rewrite.
        { kind: "CallExpression", callee: "compareSync|bcrypt\\.compare", target: "removed" } as AstMatcher,
      ],
    },
    then: {
      message: "Password/session verification call removed",
      checklist: [
        "Verify session invalidation and the password-verify path survived the rewrite",
        "Confirm the replacement still compares hashes with a timing-safe function (bcrypt.compare / compareSync)",
        "Confirm failed comparisons reject — no code path where an unmatched password still logs in",
        "Confirm existing sessions are invalidated or migrated deliberately, not silently orphaned",
      ],
      manualTests: [
        "Log in with a correct password — expect success",
        "Log in with a wrong password — expect rejection, and no session created",
        "Log out, then reuse the old session token — expect rejection",
      ],
    },
  },
];
