/**
 * Built-in configuration defaults (§12.2 — every value here is normative).
 *
 * `loadConfig` starts from a deep clone of this object and merges global,
 * project, env, and flag layers over it. Never mutate this constant.
 */

import type { CrossCheckConfig } from "../types.js";

export const DEFAULT_CONFIG: CrossCheckConfig = {
  version: 1,
  rules: {
    disable: [],
    enable: [],
    dependencySignals: true,
    severityOverrides: {},
    custom: [],
  },
  ignore: [],
  llm: {
    provider: null,
    model: null,
    apiKeyEnv: null,
    maxTokensPerReview: 48000,
    maxTokensPerCluster: 6000,
    maxCostUsdPerReview: 0.25,
    temperature: 0.2,
    timeoutMs: 30000,
    anonymizePaths: false,
    consentGiven: {},
  },
  strict: {
    failOn: "high",
  },
  output: {
    format: "terminal",
    color: true,
    maxTests: 12,
    maxClusters: 8,
  },
  history: {
    enabled: true,
    dbPath: ".git/crosscheck/history.db",
  },
};
