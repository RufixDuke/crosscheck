/**
 * The 12 built-in rules (§7.2): 4 categories, 9 on by default, 3 opt-in
 * (payments/amount-math, db/raw-sql-injection, crypto/insecure-random).
 */
import type { RiskRule } from "../../types.js";
import { AUTH_RULES } from "./auth.js";
import { PAYMENT_RULES } from "./payments.js";
import { DB_RULES } from "./db.js";
import { CRYPTO_RULES } from "./crypto.js";

export { AUTH_RULES } from "./auth.js";
export { PAYMENT_RULES } from "./payments.js";
export { DB_RULES } from "./db.js";
export { CRYPTO_RULES } from "./crypto.js";

export const BUILTIN_RULES: RiskRule[] = [
  ...AUTH_RULES,
  ...PAYMENT_RULES,
  ...DB_RULES,
  ...CRYPTO_RULES,
];
