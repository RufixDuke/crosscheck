/**
 * Built-in rules — crypto/secrets category (§7.2): hardcoded-secret and
 * weak-hash on by default; insecure-random opt-in (Math.random is often
 * benign even near auth code — enable for token/session-heavy code).
 *
 * secrets/hardcoded-secret is verbatim §7.4 example 1.
 */
import type { RiskRule } from "../../types.js";

export const CRYPTO_RULES: RiskRule[] = [
  // Verbatim §7.4 example 1.
  {
    id: "secrets/hardcoded-secret",
    name: "Hardcoded secret or credential",
    category: "crypto/secrets",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    description:
      "AI agents frequently inline plausible-looking keys while wiring integrations; GitGuardian's 2026 report found Claude-Code-assisted commits leak secrets at 2× the baseline rate.",
    when: {
      fileGlobs: ["**/*.{ts,tsx,js,jsx,mjs,cjs,json,env}", ".env*"],
      addedLines: [
        "(?i)(api[_-]?key|secret|password|passwd|token|private[_-]?key)\\s*[:=]\\s*[\"'][^\"'\\s]{8,}[\"']",
        "(sk-(live|test)-[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})",
      ],
    },
    then: {
      message: "Possible hardcoded secret added",
      checklist: [
        "Confirm the flagged value is not a real credential (test fixtures and public keys are OK)",
        "If real: revoke/rotate it NOW — assume anything committed is compromised",
        "Move the value to an environment variable and add it to .env.example with a placeholder",
        "If it was already committed, scrub history or rotate; check `git log -p` before pushing",
      ],
      manualTests: [
        "Run the app with the credential removed from code to prove env-based loading works",
      ],
      references: [
        "https://byteiota.com/ai-verification-bottleneck-why-96-dont-trust-ai-code/",
      ],
    },
  },
  {
    id: "crypto/weak-hash",
    name: "Weak hash algorithm (md5/sha1)",
    category: "crypto/secrets",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    description:
      "createHash(\"md5\"/\"sha1\") is unambiguous: collision-broken hashes have no business in security code paths.",
    when: {
      ast: [
        { kind: "CallExpression", callee: "crypto\\.createHash", argsRegex: ["md5", "sha1"] },
      ],
    },
    then: {
      message: "Weak hash algorithm used (md5/sha1)",
      checklist: [
        "Replace md5/sha1 with a modern hash for security uses (sha-256+, or argon2/bcrypt for passwords)",
        "Confirm the hashed value's role: password storage needs a password KDF, not a bare fast hash",
        "Check every consumer of the old digest — migration means both sides change together",
      ],
      manualTests: [
        "Exercise the flow that produces the digest and verify the new algorithm end to end",
        "Verify old stored digests still validate or are deliberately migrated",
      ],
    },
  },
  {
    id: "crypto/insecure-random",
    name: "Math.random in security-adjacent code",
    category: "crypto/secrets",
    severity: "medium",
    enabledByDefault: false,
    archetype: "A1",
    description:
      "Math.random is not a CSPRNG — tokens, session ids, and secrets from it are guessable; opt-in because it is often benign even near auth code.",
    when: {
      fileGlobs: [
        "**/*{auth,session,token,secret,password,crypto,security}*.{ts,tsx,js,jsx,mts,cts}",
        "**/{auth,session,security,crypto}/**",
      ],
      ast: [{ kind: "CallExpression", callee: "Math\\.random" }],
    },
    then: {
      message: "Math.random() used in a security-adjacent file",
      checklist: [
        "Use `crypto.randomBytes`/`randomUUID` for tokens, ids, and secrets",
        "Trace each Math.random() value: if it ever gates access or identifies a resource, replace it",
        "Confirm no reset/invite/verification token derives from Math.random()",
      ],
      manualTests: [
        "Generate several tokens/ids and confirm they come from a CSPRNG (length, charset, unpredictability)",
      ],
    },
  },
];
