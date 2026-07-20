/**
 * Built-in rules — payments category (§7.2): provider-code and
 * webhook-endpoint on by default; amount-math opt-in (pattern-ambiguous
 * heuristic — enable on payment-heavy codebases, §7.2).
 *
 * payments/webhook-endpoint is verbatim §7.4 example 2, plus the
 * dependencySignals excerpt from §7.10.
 */
import type { RiskRule } from "../../types.js";

export const PAYMENT_RULES: RiskRule[] = [
  {
    id: "payments/provider-code",
    name: "Payment provider code changed",
    category: "payments",
    severity: "high",
    enabledByDefault: true,
    archetype: "A4",
    description:
      "Money-moving files are a trust boundary: agent edits there are always worth a slow, line-by-line re-read.",
    when: {
      // §7.2's `**/{paystack,stripe,payment,billing,checkout}**`, expanded to
      // picomatch-supported forms: `**` inside a segment is not a globstar in
      // picomatch, so the directory-segment and basename forms are spelled
      // out separately. Same intent: any path touching provider code.
      fileGlobs: [
        "**/{paystack,stripe,payment,billing,checkout}*/**",
        "**/*{paystack,stripe,payment,billing,checkout}*",
      ],
    },
    then: {
      message: "Payment provider code changed",
      checklist: [
        "Re-read every money-moving path that changed; confirm amounts flow server-side",
        "Confirm no amount, currency, or price is trusted from the client payload",
        "Confirm idempotency keys survive the change — a retried charge must not double-charge",
        "Confirm provider errors are mapped deliberately (no silent swallow, no raw leak to the client)",
      ],
      manualTests: [
        "Run a full test-mode purchase end to end against the provider sandbox",
        "Retry the same payment request twice — expect exactly one charge",
        "Force a provider failure (bad key / sandbox decline) — expect a clean error path",
      ],
    },
  },
  // Verbatim §7.4 example 2 (+ §7.10 dependencySignals excerpt).
  {
    id: "payments/webhook-endpoint",
    name: "Webhook/payment handler added without signature verification",
    category: "payments",
    severity: "high",
    enabledByDefault: true,
    archetype: "A1",
    description:
      "Payment webhooks are the canonical 'almost right' agent output: plausible handler, missing signature verification, no idempotency.",
    when: {
      fileGlobs: ["**/*{webhook,payment,billing,checkout,paystack,stripe}*.{ts,js}", "**/routes/**"],
      addedLines: [
        "\\b(post|get|use)\\s*\\(\\s*[\"'][^\"']*(webhook|payment|charge|payout)",
        "\\b(fulfill|grant|activate|upgrade|credit)\\w*\\s*\\(",
      ],
      notAddedWith: [
        "\\b(createHmac|timingSafeEqual|verifyWebhookSignature|verifySignature)\\b",
        "x-(paystack|stripe)-signature",
      ],
      verifyInFile: true,
    },
    dependencySignals: {
      "@paystack/paystack-sdk": {
        note: "Paystack SDK is installed — use its verification helper rather than hand-rolling HMAC",
        swapRemediation:
          "Verify with the SDK's helper: paystack.webhooks.verify(rawBody, signatureHeader, secret) — before express.json() consumes the raw body",
      },
    },
    then: {
      message: "Payment/webhook surface changed",
      checklist: [
        "Verify the provider signature/HMAC is checked BEFORE any business logic runs",
        "Confirm verification uses the raw request body (not the re-serialized JSON)",
        "Confirm the handler is idempotent: replay the same event twice, expect one fulfillment",
        "Confirm amounts/references are re-fetched or recomputed server-side, never trusted from the payload",
      ],
      manualTests: [
        "Send a forged webhook (no/invalid signature) — expect 4xx and zero side effects",
        "Replay the provider's test webhook twice — expect exactly one fulfillment",
        "Send a payload with a tampered amount — expect rejection or recomputation",
      ],
    },
  },
  {
    id: "payments/amount-math",
    name: "Amount math from request payload",
    category: "payments",
    severity: "medium",
    enabledByDefault: false,
    archetype: "A1",
    description:
      "Amounts computed from req.body are trusted-client-input bugs — opt-in because `amount` near `req.body` also fires on benign code; enable on payment-heavy codebases.",
    when: {
      addedLines: ["req\\.body.*amount\\s*[:=]|amount\\s*[:=].*req\\.body"],
    },
    then: {
      message: "Amount derived from the request payload",
      checklist: [
        "Recompute amounts server-side; never trust totals from the payload",
        "Re-fetch prices/amounts from your own datastore by id — ignore client-sent values",
        "Confirm currency and unit (kobo/cents vs naira/dollars) are fixed server-side",
      ],
      manualTests: [
        "Send a request with a tampered (lower) amount — expect the server to bill the real price",
        "Send a negative or zero amount — expect validation rejection",
      ],
    },
  },
];
