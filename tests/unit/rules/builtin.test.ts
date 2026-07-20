import { describe, expect, it } from "vitest";
import { BUILTIN_RULES } from "../../../src/rules/builtin/index.js";
import { evaluateRules, type EngineResult } from "../../../src/rules/engine.js";
import { loadAstProject } from "../../../src/ast/project.js";
import type { AstProjectHandle } from "../../../src/ast/types.js";
import type { DiffFile, RiskRule } from "../../../src/types.js";
import type { RuleContext } from "../../../src/rules/context.js";
import { add, cluster, context, del, effective, file, hunk } from "./factories.js";
import {
  SESSION_SERVICE_HEAD,
  TOKEN_UTIL_RANDOM,
  WEBHOOK_HEAD_GUARDED,
  WEBHOOK_HEAD_UNGUARDED,
  WEAK_HASH_MD5,
  WEAK_HASH_SHA256,
} from "../../fixtures/rules/snippets.js";

function rule(id: string): RiskRule {
  const found = BUILTIN_RULES.find((r) => r.id === id);
  if (found === undefined) throw new Error(`built-in rule ${id} not found`);
  return found;
}

async function run(
  r: RiskRule,
  files: DiffFile[],
  opts?: { context?: RuleContext; ast?: AstProjectHandle | null; oldFileAst?: AstProjectHandle | null },
): Promise<EngineResult> {
  return evaluateRules({
    clusters: [cluster(files)],
    rules: [effective(r)],
    context: opts?.context ?? context(),
    ast: opts?.ast ?? null,
    oldFileAst: opts?.oldFileAst ?? null,
  });
}

async function astFor(path: string, content: string): Promise<AstProjectHandle> {
  const handle = await loadAstProject([{ path, content }]);
  if (handle === null) throw new Error("ts-morph failed to load in test");
  return handle;
}

describe("BUILTIN_RULES — shape (§7.2)", () => {
  it("ships exactly 12 rules: 9 on by default, 3 opt-in", () => {
    expect(BUILTIN_RULES).toHaveLength(12);
    expect(BUILTIN_RULES.map((r) => r.id)).toEqual([
      "auth/middleware-touched",
      "auth/permission-check-removed",
      "auth/session-rewrite",
      "payments/provider-code",
      "payments/webhook-endpoint",
      "payments/amount-math",
      "db/migration-added",
      "db/destructive-migration",
      "db/raw-sql-injection",
      "secrets/hardcoded-secret",
      "crypto/weak-hash",
      "crypto/insecure-random",
    ]);
    const optIn = BUILTIN_RULES.filter((r) => !r.enabledByDefault).map((r) => r.id);
    expect(optIn.sort()).toEqual(
      ["crypto/insecure-random", "db/raw-sql-injection", "payments/amount-math"].sort(),
    );
    for (const r of BUILTIN_RULES) {
      expect(r.then.message.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(r.then.checklist.length).toBeGreaterThanOrEqual(1);
      expect(r.then.manualTests?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("the three §7.4 worked examples are verbatim (matchers, guards, signals)", () => {
    const secret = rule("secrets/hardcoded-secret");
    expect(secret.severity).toBe("high");
    expect(secret.enabledByDefault).toBe(true);
    expect(secret.archetype).toBe("A1");
    expect(secret.when.fileGlobs).toEqual(["**/*.{ts,tsx,js,jsx,mjs,cjs,json,env}", ".env*"]);
    expect(secret.when.addedLines).toEqual([
      "(?i)(api[_-]?key|secret|password|passwd|token|private[_-]?key)\\s*[:=]\\s*[\"'][^\"'\\s]{8,}[\"']",
      "(sk-(live|test)-[A-Za-z0-9]{10,}|sk-ant-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})",
    ]);
    expect(secret.then.checklist[0]).toBe(
      "Confirm the flagged value is not a real credential (test fixtures and public keys are OK)",
    );

    const webhook = rule("payments/webhook-endpoint");
    expect(webhook.severity).toBe("high");
    expect(webhook.when.fileGlobs).toEqual([
      "**/*{webhook,payment,billing,checkout,paystack,stripe}*.{ts,js}",
      "**/routes/**",
    ]);
    expect(webhook.when.addedLines).toEqual([
      "\\b(post|get|use)\\s*\\(\\s*[\"'][^\"']*(webhook|payment|charge|payout)",
      "\\b(fulfill|grant|activate|upgrade|credit)\\w*\\s*\\(",
    ]);
    expect(webhook.when.notAddedWith).toEqual([
      "\\b(createHmac|timingSafeEqual|verifyWebhookSignature|verifySignature)\\b",
      "x-(paystack|stripe)-signature",
    ]);
    expect(webhook.when.verifyInFile).toBe(true);
    expect(webhook.dependencySignals).toEqual({
      "@paystack/paystack-sdk": {
        note: "Paystack SDK is installed — use its verification helper rather than hand-rolling HMAC",
        swapRemediation:
          "Verify with the SDK's helper: paystack.webhooks.verify(rawBody, signatureHeader, secret) — before express.json() consumes the raw body",
      },
    });

    const migration = rule("db/destructive-migration");
    expect(migration.severity).toBe("high");
    expect(migration.when.fileGlobs).toEqual(["**/migrations/**", "**/db/**", "**/prisma/**", "schema.prisma"]);
    expect(migration.when.addedLines).toEqual([
      "(?i)\\bDROP\\s+(TABLE|COLUMN|INDEX|DATABASE)\\b",
      "(?i)\\bTRUNCATE\\b",
      "(?i)ALTER\\s+TABLE\\s+\\S+\\s+ADD\\s+COLUMN\\s+\\S+\\s+\\S+\\s+NOT\\s+NULL\\b(?!.*DEFAULT)",
      "(?i)\\bDELETE\\s+FROM\\b(?!.*\\bWHERE\\b)",
    ]);
    expect(migration.then.manualTests?.[0]).toBe(
      "Restore a production-shaped dump locally and run the migration against it",
    );
  });
});

describe("auth/middleware-touched (▲ on)", () => {
  it("triggers on files under **/auth/**", async () => {
    const f = file("src/auth/session.ts", [hunk("src/auth/session.ts", [add("export const ttl = 3600;", 1)])]);
    const result = await run(rule("auth/middleware-touched"), [f]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.file).toBe("src/auth/session.ts");
  });

  it("triggers on **/middleware.* files", async () => {
    const f = file("src/middleware.ts", [hunk("src/middleware.ts", [add("export const mw = 1;", 1)])]);
    const result = await run(rule("auth/middleware-touched"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on unrelated files", async () => {
    const f = file("src/components/Button.tsx", [hunk("src/components/Button.tsx", [add("export const B = 1;", 1)])]);
    const result = await run(rule("auth/middleware-touched"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on auth-adjacent names that are not an auth path segment", async () => {
    const f = file("docs/auth-notes.md", [hunk("docs/auth-notes.md", [add("# auth notes", 1)])]);
    const result = await run(rule("auth/middleware-touched"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("auth/permission-check-removed (▲ on)", () => {
  it("triggers when requireAuth is removed", async () => {
    const f = file("src/routes/admin.ts", [hunk("src/routes/admin.ts", [del("  requireAuth,", 4)])]);
    const result = await run(rule("auth/permission-check-removed"), [f]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(4);
  });

  it("triggers when authorize/checkPermission is removed", async () => {
    const f = file("src/routes/admin.ts", [
      hunk("src/routes/admin.ts", [del("router.delete('/x', authorize('admin'), handler);", 9)]),
    ]);
    const result = await run(rule("auth/permission-check-removed"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger when the guard is ADDED", async () => {
    const f = file("src/routes/admin.ts", [hunk("src/routes/admin.ts", [add("  requireAuth,", 4)])]);
    const result = await run(rule("auth/permission-check-removed"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on lookalike identifiers (requireAuthz, checkPermissions)", async () => {
    const f = file("src/routes/admin.ts", [
      hunk("src/routes/admin.ts", [del("const requireAuthz = true;", 2), del("checkPermissions(user);", 3)]),
    ]);
    const result = await run(rule("auth/permission-check-removed"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("auth/session-rewrite (▲ on, removed-code AST)", () => {
  it("triggers when a bcrypt.compareSync call is removed by the rewrite", async () => {
    const oldFileAst = await astFor("src/session.ts", SESSION_SERVICE_HEAD);
    const f = file("src/session.ts", [
      hunk("src/session.ts", [del("  return bcrypt.compareSync(password, hash);", 5)], { oldStart: 3, newStart: 3 }),
    ]);
    const result = await run(rule("auth/session-rewrite"), [f], { oldFileAst });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(5);
    expect(result.findings[0]!.evidence).toContain("compareSync");
  });

  it("triggers when a plain compareSync call is removed", async () => {
    const old = `import { compareSync } from "bcrypt";\nexport const ok = compareSync(a, b);\n`;
    const oldFileAst = await astFor("src/utils/passwords.ts", old);
    const f = file("src/utils/passwords.ts", [
      hunk("src/utils/passwords.ts", [del("export const ok = compareSync(a, b);", 2)]),
    ]);
    const result = await run(rule("auth/session-rewrite"), [f], { oldFileAst });
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger when compareSync is ADDED (removed-code matcher only)", async () => {
    const ast = await astFor(
      "src/session.ts",
      `import bcrypt from "bcrypt";\nexport const ok = bcrypt.compareSync(a, b);\n`,
    );
    const f = file("src/session.ts", [
      hunk("src/session.ts", [add("export const ok = bcrypt.compareSync(a, b);", 2)]),
    ]);
    const result = await run(rule("auth/session-rewrite"), [f], { ast });
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger when the removed lines never contained a compare call", async () => {
    const old = `export function issueSession(id: string) {\n  return "sess_" + id;\n}\n`;
    const oldFileAst = await astFor("src/session.ts", old);
    const f = file("src/session.ts", [hunk("src/session.ts", [del('  return "sess_" + id;', 2)])]);
    const result = await run(rule("auth/session-rewrite"), [f], { oldFileAst });
    expect(result.findings).toHaveLength(0);
  });
});

describe("payments/provider-code (▲ on)", () => {
  it("triggers on paystack files", async () => {
    const f = file("src/paystack/charge.ts", [hunk("src/paystack/charge.ts", [add("export const x = 1;", 1)])]);
    const result = await run(rule("payments/provider-code"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("triggers on billing/checkout/stripe/payment paths", async () => {
    const f = file("src/billing/invoice.ts", [hunk("src/billing/invoice.ts", [add("export const x = 1;", 1)])]);
    const result = await run(rule("payments/provider-code"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on non-payment paths", async () => {
    const f = file("src/utils/money.ts", [hunk("src/utils/money.ts", [add("export const x = 1;", 1)])]);
    const result = await run(rule("payments/provider-code"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on plain UI files", async () => {
    const f = file("src/components/PriceTag.tsx", [hunk("src/components/PriceTag.tsx", [add("export const x = 1;", 1)])]);
    const result = await run(rule("payments/provider-code"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("payments/webhook-endpoint (▲ on, §7.8/§7.9/§7.10)", () => {
  const unguarded = context({ readFileAtHead: async () => WEBHOOK_HEAD_UNGUARDED });

  it("triggers on a webhook route added with no signature guard (guard absent from file)", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], { context: unguarded });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.severity).toBe("high");
    expect(finding.line).toBe(5);
    expect(finding.checklist[0]).toBe(
      "Verify the provider signature/HMAC is checked BEFORE any business logic runs",
    );
    expect(finding.manualTests).toContain(
      "Send a forged webhook (no/invalid signature) — expect 4xx and zero side effects",
    );
  });

  it("triggers on a fulfillment call added in a webhook-shaped file", async () => {
    const f = file("src/api/webhook-handler.ts", [
      hunk("src/api/webhook-handler.ts", [add("  await fulfillOrder(order);", 12)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], { context: unguarded });
    expect(result.findings).toHaveLength(1);
  });

  it("does NOT trigger when createHmac appears in the added lines (notAddedWith veto)", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [
        add('  router.post("/webhooks/paystack", handler);', 5),
        add("  const hmac = createHmac('sha512', secret);", 6),
      ]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], { context: unguarded });
    expect(result.findings).toHaveLength(0);
    expect(result.infoFindings).toHaveLength(0);
  });

  it("verifyInFile downgrades to info when the guard exists elsewhere in the HEAD file", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 9)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], {
      context: context({ readFileAtHead: async () => WEBHOOK_HEAD_GUARDED }),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.infoFindings).toHaveLength(1);
    expect(result.infoFindings[0]!.info).toBe(true);
    expect(result.infoFindings[0]!.infoReason).toBe("guard found at line 4 — downgraded to info");
  });

  it("KEEPS full severity (with note) when the verification read fails", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], {
      context: context({ readFileAtHead: async () => null }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.findings[0]!.note).toBe("guard verification read failed");
  });

  it("does not trigger outside webhook/route file globs even with a matching line", async () => {
    const f = file("src/utils/helpers.ts", [
      hunk("src/utils/helpers.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], { context: unguarded });
    expect(result.findings).toHaveLength(0);
  });

  it("dependencySignals: @paystack/paystack-sdk present → note + swapped lead remediation", async () => {
    const f = file("src/routes/webhooks.ts", [
      hunk("src/routes/webhooks.ts", [add('  router.post("/webhooks/paystack", handler);', 5)]),
    ]);
    const result = await run(rule("payments/webhook-endpoint"), [f], {
      context: context({
        readFileAtHead: async () => WEBHOOK_HEAD_UNGUARDED,
        dependencies: new Set(["@paystack/paystack-sdk", "express"]),
      }),
    });
    const finding = result.findings[0]!;
    expect(finding.severity).toBe("high"); // no downgradeTo on this signal
    expect(finding.note).toContain("Paystack SDK is installed");
    expect(finding.checklist[0]).toContain("paystack.webhooks.verify(rawBody, signatureHeader, secret)");
  });
});

describe("payments/amount-math (● opt-in)", () => {
  it("triggers on amount assigned from req.body", async () => {
    const f = file("src/shop/order.ts", [
      hunk("src/shop/order.ts", [add("  const amount = req.body.amount * 100;", 8)]),
    ]);
    const result = await run(rule("payments/amount-math"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("triggers on req.body feeding an amount field", async () => {
    const f = file("src/shop/order.ts", [
      hunk("src/shop/order.ts", [add("  const charge = { amount: req.body.amount };", 9)]),
    ]);
    const result = await run(rule("payments/amount-math"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on server-side amount math", async () => {
    const f = file("src/shop/order.ts", [
      hunk("src/shop/order.ts", [add("  const amount = price * quantity;", 8)]),
    ]);
    const result = await run(rule("payments/amount-math"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on req.body usage without amount assignment", async () => {
    const f = file("src/shop/order.ts", [hunk("src/shop/order.ts", [add("  const body = req.body;", 8)])]);
    const result = await run(rule("payments/amount-math"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("db/migration-added (● on)", () => {
  it("triggers on a new file under **/migrations/**", async () => {
    const f = file(
      "prisma/migrations/20260719_init/migration.sql",
      [hunk("prisma/migrations/20260719_init/migration.sql", [add("CREATE TABLE users (id int);", 1)])],
    );
    const result = await run(rule("db/migration-added"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("triggers on schema.prisma / **/schema.*", async () => {
    const f = file("prisma/schema.prisma", [hunk("prisma/schema.prisma", [add("model User { id Int }", 1)])]);
    const result = await run(rule("db/migration-added"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on ordinary db client code", async () => {
    const f = file("src/db/client.ts", [hunk("src/db/client.ts", [add("export const c = 1;", 1)])]);
    const result = await run(rule("db/migration-added"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on docs mentioning migrations", async () => {
    const f = file("docs/migrations.md", [hunk("docs/migrations.md", [add("# migrations runbook", 1)])]);
    const result = await run(rule("db/migration-added"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("db/destructive-migration (▲ on)", () => {
  it("triggers on DROP TABLE in a migration (case-insensitive)", async () => {
    const f = file("src/db/migrations/002.sql", [
      hunk("src/db/migrations/002.sql", [add("drop table sessions;", 3)]),
    ]);
    const result = await run(rule("db/destructive-migration"), [f]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(3);
  });

  it("triggers on NOT NULL column without DEFAULT", async () => {
    const f = file("prisma/migrations/003/migration.sql", [
      hunk("prisma/migrations/003/migration.sql", [add("ALTER TABLE users ADD COLUMN age integer NOT NULL;", 2)]),
    ]);
    const result = await run(rule("db/destructive-migration"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on NOT NULL column WITH a DEFAULT", async () => {
    const f = file("prisma/migrations/003/migration.sql", [
      hunk("prisma/migrations/003/migration.sql", [
        add("ALTER TABLE users ADD COLUMN age integer NOT NULL DEFAULT 0;", 2),
      ]),
    ]);
    const result = await run(rule("db/destructive-migration"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on DELETE ... WHERE (targeted delete)", async () => {
    const f = file("src/db/migrations/004.sql", [
      hunk("src/db/migrations/004.sql", [add("DELETE FROM sessions WHERE expired_at < now();", 1)]),
    ]);
    const result = await run(rule("db/destructive-migration"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on DROP TABLE outside migration/db globs", async () => {
    const f = file("scripts/scratch.sql", [hunk("scripts/scratch.sql", [add("DROP TABLE users;", 1)])]);
    const result = await run(rule("db/destructive-migration"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("db/raw-sql-injection (▲ opt-in)", () => {
  it("triggers on template-literal interpolation after query(", async () => {
    const f = file("src/users/repo.ts", [
      hunk("src/users/repo.ts", [
        add("  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);", 6),
      ]),
    ]);
    const result = await run(rule("db/raw-sql-injection"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("triggers on string concatenation after query(", async () => {
    const f = file("src/users/repo.ts", [
      hunk("src/users/repo.ts", [add('  db.query("SELECT * FROM t WHERE x = " + req.query.x);', 7)]),
    ]);
    const result = await run(rule("db/raw-sql-injection"), [f]);
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger on parameterized queries", async () => {
    const f = file("src/users/repo.ts", [
      hunk("src/users/repo.ts", [add("  db.query(`SELECT * FROM users WHERE id = $1`, [id]);", 6)]),
    ]);
    const result = await run(rule("db/raw-sql-injection"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on static SQL strings", async () => {
    const f = file("src/users/repo.ts", [
      hunk("src/users/repo.ts", [add('  db.query("SELECT * FROM users");', 6)]),
    ]);
    const result = await run(rule("db/raw-sql-injection"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("secrets/hardcoded-secret (▲ on)", () => {
  it("triggers on an api-key-shaped assignment", async () => {
    const f = file("src/config.ts", [
      hunk("src/config.ts", [add('  const apiKey = "sk-live-a1b2c3d4e5f6g7h8";', 2)]),
    ]);
    const result = await run(rule("secrets/hardcoded-secret"), [f]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]!.severity).toBe("high");
  });

  it("triggers on known key shapes (AKIA…)", async () => {
    const f = file("src/aws.ts", [
      hunk("src/aws.ts", [add('export const key = "AKIAIOSFODNN7EXAMPLE";', 1)]),
    ]);
    const result = await run(rule("secrets/hardcoded-secret"), [f]);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("does NOT fire on env-based loading (const password = process.env.DB_PASS)", async () => {
    const f = file("src/config.ts", [
      hunk("src/config.ts", [add("  const password = process.env.DB_PASS;", 2)]),
    ]);
    const result = await run(rule("secrets/hardcoded-secret"), [f]);
    expect(result.findings).toHaveLength(0);
  });

  it("does NOT fire on a short placeholder (< 8 chars)", async () => {
    // The §7.4 pattern requires 8+ non-space chars between quotes; short
    // placeholders stay below the threshold by design.
    const f = file("src/config.ts", [hunk("src/config.ts", [add('  const apiKey = "example";', 2)])]);
    const result = await run(rule("secrets/hardcoded-secret"), [f]);
    expect(result.findings).toHaveLength(0);
  });
});

describe("crypto/weak-hash (▲ on, AST)", () => {
  it('triggers on crypto.createHash("md5") inside an added range', async () => {
    const ast = await astFor("src/tokens.ts", WEAK_HASH_MD5);
    const f = file("src/tokens.ts", [
      hunk("src/tokens.ts", [add('  return crypto.createHash("md5").update(token).digest("hex");', 4)]),
    ]);
    const result = await run(rule("crypto/weak-hash"), [f], { ast });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(4);
  });

  it('triggers on crypto.createHash("sha1")', async () => {
    const src = `import crypto from "crypto";\nexport const d = crypto.createHash("sha1").update(x).digest("hex");\n`;
    const ast = await astFor("src/digest.ts", src);
    const f = file("src/digest.ts", [
      hunk("src/digest.ts", [add('export const d = crypto.createHash("sha1").update(x).digest("hex");', 2)]),
    ]);
    const result = await run(rule("crypto/weak-hash"), [f], { ast });
    expect(result.findings).toHaveLength(1);
  });

  it('does not trigger on crypto.createHash("sha256")', async () => {
    const ast = await astFor("src/tokens.ts", WEAK_HASH_SHA256);
    const f = file("src/tokens.ts", [
      hunk("src/tokens.ts", [add('  return crypto.createHash("sha256").update(token).digest("hex");', 4)]),
    ]);
    const result = await run(rule("crypto/weak-hash"), [f], { ast });
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on other calls that merely mention md5", async () => {
    const src = `export const h = hash.update("md5-looking-string");\n`;
    const ast = await astFor("src/h.ts", src);
    const f = file("src/h.ts", [hunk("src/h.ts", [add('export const h = hash.update("md5-looking-string");', 1)])]);
    const result = await run(rule("crypto/weak-hash"), [f], { ast });
    expect(result.findings).toHaveLength(0);
  });
});

describe("crypto/insecure-random (● opt-in, AST + security-adjacent globs)", () => {
  it("triggers on Math.random() in an auth-adjacent file", async () => {
    const ast = await astFor("src/auth/token.ts", TOKEN_UTIL_RANDOM);
    const f = file("src/auth/token.ts", [
      hunk("src/auth/token.ts", [add("    token += Math.floor(Math.random() * 16).toString(16);", 4)]),
    ]);
    const result = await run(rule("crypto/insecure-random"), [f], { ast });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(4);
  });

  it("triggers on Math.random() in a session path", async () => {
    const src = `export function newSessionId(): string {\n  return Math.random().toString(36).slice(2);\n}\n`;
    const ast = await astFor("src/session/id.ts", src);
    const f = file("src/session/id.ts", [
      hunk("src/session/id.ts", [add("  return Math.random().toString(36).slice(2);", 2)]),
    ]);
    const result = await run(rule("crypto/insecure-random"), [f], { ast });
    expect(result.findings).toHaveLength(1);
  });

  it("does not trigger outside security-adjacent globs", async () => {
    const ast = await astFor("src/components/shuffle.ts", TOKEN_UTIL_RANDOM);
    const f = file("src/components/shuffle.ts", [
      hunk("src/components/shuffle.ts", [add("    token += Math.floor(Math.random() * 16).toString(16);", 4)]),
    ]);
    const result = await run(rule("crypto/insecure-random"), [f], { ast });
    expect(result.findings).toHaveLength(0);
  });

  it("does not trigger on crypto.randomUUID() (callee mismatch)", async () => {
    const src = `import crypto from "crypto";\nexport const id = crypto.randomUUID();\n`;
    const ast = await astFor("src/auth/token.ts", src);
    const f = file("src/auth/token.ts", [
      hunk("src/auth/token.ts", [add("export const id = crypto.randomUUID();", 2)]),
    ]);
    const result = await run(rule("crypto/insecure-random"), [f], { ast });
    expect(result.findings).toHaveLength(0);
  });
});
