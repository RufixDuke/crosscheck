/**
 * Larger source snippets used by the rule/AST tests — kept as exported
 * template strings (valid TS) so `tsc --noEmit` over tests/** stays clean.
 * Line numbers called out in comments are 1-based and asserted in tests.
 */

/** crypto.createHash("md5") sits on line 4. */
export const WEAK_HASH_MD5 = `import crypto from "crypto";

export function hashResetToken(token: string): string {
  return crypto.createHash("md5").update(token).digest("hex");
}
`;

/** Same file, but sha256 — must NOT fire crypto/weak-hash. */
export const WEAK_HASH_SHA256 = `import crypto from "crypto";

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
`;

/** bcrypt.compareSync sits on line 5 (HEAD version of the session service). */
export const SESSION_SERVICE_HEAD = `import bcrypt from "bcrypt";

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;
  return bcrypt.compareSync(password, hash);
}

export function issueSession(userId: string): string {
  return \`sess_\${userId}\`;
}
`;

/** Rewritten session service — the compareSync call is gone. */
export const SESSION_SERVICE_REWRITTEN = `import bcrypt from "bcrypt";

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || !hash) return false;
  return hashPassword(password) === hash;
}

export function hashPassword(password: string): string {
  return password;
}

export function issueSession(userId: string): string {
  return \`sess_\${userId}\`;
}
`;

/**
 * Webhook routes file at HEAD where signature verification EXISTS elsewhere
 * in the file — the first createHmac occurrence is on line 4 (§7.9 fixture).
 */
export const WEBHOOK_HEAD_GUARDED = `import express from "express";

export function verifyPaystack(rawBody: Buffer, signature: string): boolean {
  const hmac = createHmac("sha512", process.env.PAYSTACK_SECRET ?? "");
  const digest = hmac.update(rawBody).digest("hex");
  return digest === signature;
}

export const router = express.Router();
`;

/** Webhook routes file at HEAD with NO verification anywhere (§7.9). */
export const WEBHOOK_HEAD_UNGUARDED = `import express from "express";

export const router = express.Router();

export function health(_req: unknown, res: { json: (b: unknown) => void }): void {
  res.json({ ok: true });
}
`;

/** Math.random() sits on line 4 of this token helper. */
export const TOKEN_UTIL_RANDOM = `export function generateResetToken(): string {
  let token = "";
  for (let i = 0; i < 32; i += 1) {
    token += Math.floor(Math.random() * 16).toString(16);
  }
  return token;
}
`;

/** Syntactically broken TS — must land in AstProjectHandle.skipped (§7.3). */
export const BROKEN_TS = `export function broken( {
  const x = ;
  return ~~~;
}
`;
