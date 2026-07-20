/**
 * Redaction pipeline tests (§10.2, §10.3, §15.4 — blocking, non-negotiable).
 *
 * These are the guarantee tests: canary secrets must never survive into the
 * output, benign fixtures must survive unscathed, and adversarial shapes
 * (comments, template literals, base64) must not evade the pattern battery.
 */
import { describe, expect, it } from "vitest";
import { redact } from "../../../src/redact/index.js";

describe("redact() — §10.3 worked example (golden case)", () => {
  it("reproduces the PRD's before/after example exactly", () => {
    const before = [
      '// src/lib/paystack.ts',
      '+ import axios from "axios";',
      '+',
      '+ // TODO: move to env before launch',
      '+ const secretKey = "sk_live_FAKEKEYNOTREAL12";',
      '+ const sessionJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";',
      '+',
      '+ export async function verifyTransaction(reference: string) {',
      '+   const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {',
      '+     headers: { Authorization: `Bearer ${secretKey}` },',
      '+   });',
      '+   return res.data.status === "success";',
      '+ }',
    ].join("\n");

    const after = [
      '// src/lib/paystack.ts',
      '+ import axios from "axios";',
      '+',
      '+ // TODO: move to env before launch',
      '+ const secretKey = "<SECRET:paystack-live-key>";',
      '+ const sessionJwt = "<SECRET:jwt>";',
      '+',
      '+ export async function verifyTransaction(reference: string) {',
      '+   const res = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {',
      '+     headers: { Authorization: `Bearer ${secretKey}` },',
      '+   });',
      '+   return res.data.status === "success";',
      '+ }',
    ].join("\n");

    const result = redact(before);
    expect(result.text).toBe(after);
    expect(result.redactionCount).toBe(2);
    expect(result.redactionTypes.sort()).toEqual(["jwt", "paystack-live-key"]);

    // What survived, called out explicitly (§10.3's own commentary on the example).
    expect(result.text).toContain("src/lib/paystack.ts");
    expect(result.text).toContain('import axios from "axios"');
    expect(result.text).toContain("// TODO: move to env before launch");
    expect(result.text).toContain("https://api.paystack.co/transaction/verify/${reference}");
    expect(result.text).toContain('"success"');
    expect(result.text).toContain("verifyTransaction");
  });
});

describe("redact() — canary suite: one secret per pattern family (§15.4.1)", () => {
  const canaries = {
    aws: "AKIAABCDEFGHIJKLMNOP",
    github: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    anthropic: "sk-ant-api03-1234567890abcdefGHIJ",
    openai: "sk-abcd1234EFGH5678ijkl9012",
    slack: "xoxb-1234567890-abcdefGHIJKL",
    paystackLive: "sk_live_FAKEKEYNOTREAL12",
    paymentTest: "sk_test_FAKEKEYNOTREAL12",
    jwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
    pemBody: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
    genericPassword: "SuperSecretPass123",
    longSlug: "this-is-a-very-long-kebab-case-slug-value-abcdefgh",
    bigNumber: "1234567890",
  };

  const fixture = [
    `// canary fixture — one secret per pattern family`,
    `const awsKey = "${canaries.aws}";`,
    `const ghToken = "${canaries.github}";`,
    `const anthropicKey = "${canaries.anthropic}";`,
    `const openaiKey = "${canaries.openai}";`,
    `const slackToken = "${canaries.slack}";`,
    `const secretKey = "${canaries.paystackLive}";`,
    `const testKey = "${canaries.paymentTest}";`,
    `const sessionJwt = "${canaries.jwt}";`,
    `-----BEGIN RSA PRIVATE KEY-----`,
    canaries.pemBody,
    `-----END RSA PRIVATE KEY-----`,
    `const dbPassword = "${canaries.genericPassword}";`,
    `const slug = "${canaries.longSlug}";`,
    `const accountNumber = ${canaries.bigNumber};`,
  ].join("\n");

  const result = redact(fixture);

  it("contains zero canary substrings", () => {
    for (const [name, value] of Object.entries(canaries)) {
      expect(result.text, `canary "${name}" leaked into redacted output`).not.toContain(value);
    }
  });

  it("produces the expected typed placeholders", () => {
    expect(result.text).toContain("<SECRET:aws-access-key>");
    expect(result.text).toContain("<SECRET:github-token>");
    expect(result.text).toContain("<SECRET:anthropic-key>");
    expect(result.text).toContain("<SECRET:openai-key>");
    expect(result.text).toContain("<SECRET:slack-token>");
    expect(result.text).toContain("<SECRET:paystack-live-key>");
    expect(result.text).toContain("<SECRET:payment-test-key>");
    expect(result.text).toContain("<SECRET:jwt>");
    expect(result.text).toContain("<SECRET:private-key>");
    expect(result.text).toContain("<SECRET:generic>"); // dbPassword
    expect(result.text).toMatch(/<STRING:len=\d+>/); // longSlug
    expect(result.text).toContain("<NUM>"); // bigNumber
  });

  it("records a redaction count and type list consistent with the fixture", () => {
    expect(result.redactionCount).toBeGreaterThanOrEqual(12);
    expect(result.redactionTypes).toContain("aws-access-key");
    expect(result.redactionTypes).toContain("generic");
    expect(result.redactionTypes).toContain("string");
    expect(result.redactionTypes).toContain("number");
  });
});

describe("redact() — adversarial variants (§15.4.2)", () => {
  it("redacts a secret pasted inside a comment", () => {
    const text = '// leftover from debugging: const k = "sk_live_FAKEKEYNOTREAL12";';
    const result = redact(text);
    expect(result.text).not.toContain("sk_live_FAKEKEYNOTREAL12");
    expect(result.text).toContain("<SECRET:paystack-live-key>");
  });

  it("redacts a secret nested inside a template literal alongside other text, preserving the typed placeholder", () => {
    const text = 'const header = `Authorization: Bearer sk_live_FAKEKEYNOTREAL12`;';
    const result = redact(text);
    expect(result.text).not.toContain("sk_live_FAKEKEYNOTREAL12");
    expect(result.text).toBe("const header = `Authorization: Bearer <SECRET:paystack-live-key>`;");
  });

  it("redacts a secret that sits deep inside a larger multi-line hunk", () => {
    const text = [
      "function setup() {",
      '  const unrelated = "just some benign short text";',
      '  const key = "AKIAABCDEFGHIJKLMNOP";',
      "  return connect(key);",
      "}",
    ].join("\n");
    const result = redact(text);
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).toContain("<SECRET:aws-access-key>");
    expect(result.text).toContain("just some benign short text"); // untouched, ≤24 chars
  });

  it("routes a base64-looking blob to the generic secret placeholder, not <STRING>", () => {
    const text = 'const payload = "QUtJQUFCQ0RFRkdISUpLTE1OT1AxMjM0NTY3ODkwQUJDRA==";';
    const result = redact(text);
    expect(result.text).not.toContain("QUtJQUFCQ0RFRkdISUpLTE1OT1AxMjM0NTY3ODkwQUJDRA==");
    expect(result.text).toContain("<SECRET:generic>");
    expect(result.text).not.toMatch(/<STRING:len=\d+>/);
  });

  it("routes a hex-looking blob to the generic secret placeholder", () => {
    const text = 'const raw = "4f3c9a1b2d5e6f708192a3b4c5d6e7f8a9b0c1d2";';
    const result = redact(text);
    expect(result.text).not.toContain("4f3c9a1b2d5e6f708192a3b4c5d6e7f8a9b0c1d2");
    expect(result.text).toContain("<SECRET:generic>");
  });

  it("redacts a generic password assignment written without camelCase (bare keyword)", () => {
    const text = 'const password = "hunter2ReallyLongOne";';
    const result = redact(text);
    expect(result.text).not.toContain("hunter2ReallyLongOne");
    expect(result.text).toContain('password = "<SECRET:generic>"');
  });

  it("does not double-redact a value already replaced by a typed placeholder", () => {
    const text = 'const secretKey = "sk_live_FAKEKEYNOTREAL12";';
    const result = redact(text);
    expect(result.text).toBe('const secretKey = "<SECRET:paystack-live-key>";');
    expect(result.redactionCount).toBe(1);
  });
});

describe('redact() — "must NOT redact" negative controls (§15.4.3)', () => {
  it("leaves Tailwind/CSS class lists untouched even when long", () => {
    const text =
      'const className = "flex items-center justify-between px-4 py-2 rounded-lg shadow-md hover:bg-gray-100 md:flex-row";';
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves plain prose sentences untouched even when long", () => {
    const text =
      'const note = "This function validates the incoming webhook signature before any business logic runs.";';
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves normal identifiers, control flow, and type signatures untouched", () => {
    const text = [
      "export async function fulfillOrder(orderId: string): Promise<void> {",
      "  if (requireAuth(sessionStore)) {",
      "    try {",
      "      await grantAccess(orderId);",
      "    } catch (err) {",
      "      throw err;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves import paths and package names untouched", () => {
    const text = 'import { compare } from "bcrypt";\nimport { requireAuth } from "../middleware/auth.js";';
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves short route paths, role names, and event names untouched", () => {
    const text = [
      'const route = "/webhooks/paystack";',
      'const role = "admin";',
      'const event = "charge.success";',
    ].join("\n");
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves URL/endpoint strings untouched even when long", () => {
    const text = 'const url = "https://api.paystack.co/transaction/verify/reference-goes-here-1234";';
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("leaves logic-relevant small numbers (retry counts, status codes, ports) untouched", () => {
    const text = [
      "const maxRetries = 3;",
      "if (status === 401 || status === 429) return;",
      "const port = 8080;",
    ].join("\n");
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });

  it("does not fire on env-var value that is already a placeholder shape", () => {
    // Regression guard for the containsPlaceholder() skip logic itself.
    const text = "FOO=<REDACTED>";
    const result = redact(text);
    expect(result.text).toBe(text);
    expect(result.redactionCount).toBe(0);
  });
});

describe("redact() — env-style lines (§10.2 stage 4)", () => {
  it("redacts KEY=value lines but keeps the key name", () => {
    const text = ["+ DATABASE_URL=postgres://user:pass@host:5432/db", "+ NODE_ENV=production"].join("\n");
    const result = redact(text);
    expect(result.text).toContain("DATABASE_URL=<REDACTED>");
    expect(result.text).toContain("NODE_ENV=<REDACTED>");
    expect(result.text).not.toContain("postgres://user:pass@host:5432/db");
    expect(result.redactionTypes).toContain("env-value");
  });
});

describe("redact() — file paths (§10.2 stage 4 / §10.3 rule 4)", () => {
  it("strips a known absolute repo root when the caller supplies one", () => {
    const text = "at /home/tunde/proteintrail-api/src/auth/session.ts:88";
    const result = redact(text, { repoRoot: "/home/tunde/proteintrail-api" });
    expect(result.text).toBe("at src/auth/session.ts:88");
    expect(result.text).not.toContain("tunde");
  });

  it("falls back to a best-effort home-dir strip when no repoRoot is given", () => {
    const text = "/home/tunde/proteintrail-api/src/auth/session.ts";
    const result = redact(text);
    expect(result.text).not.toContain("/home/tunde");
    expect(result.text).toBe("src/auth/session.ts");
  });

  it("never renders repo-relative paths differently by default (anonymizePaths off)", () => {
    const text = '// src/lib/paystack.ts\nconst x = 1;';
    const result = redact(text);
    expect(result.text).toContain("src/lib/paystack.ts");
  });

  it("rewrites paths to opaque src/file-N.ext names when anonymizePaths is true", () => {
    const text = "// src/lib/paystack.ts\nimport { x } from \"./helpers/format.ts\";";
    const result = redact(text, { anonymizePaths: true });
    expect(result.text).not.toContain("src/lib/paystack.ts");
    expect(result.text).not.toContain("helpers/format.ts");
    expect(result.text).toMatch(/src\/file-\d+\.ts/);
  });
});

describe("redact() — large numeric literals (§10.3 rule 5)", () => {
  it("redacts long digit runs but preserves short logic-relevant numbers", () => {
    const text = "const cardNumber = 4242424242424242;\nconst retries = 3;\nconst code = 404;";
    const result = redact(text);
    expect(result.text).toContain("<NUM>");
    expect(result.text).not.toContain("4242424242424242");
    expect(result.text).toContain("retries = 3");
    expect(result.text).toContain("code = 404");
  });
});
