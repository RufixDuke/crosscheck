import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/config/defaults.js";
import {
  applyFlags,
  ConfigError,
  DEFAULT_PROJECT_CONFIG_TEXT,
  loadConfig,
  writeProjectConfig,
} from "../../../src/config/load.js";
import type { CrossCheckConfig } from "../../../src/types.js";

let root: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "crosscheck-cfg-"));
  home = await mkdtemp(path.join(tmpdir(), "crosscheck-home-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): Promise<void> {
  return writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("loadConfig — defaults", () => {
  it("returns deep-cloned defaults when no config files exist", async () => {
    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.config).not.toBe(DEFAULT_CONFIG);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.sources).toEqual([]);
    expect(loaded.projectConfigPath).toBe(path.join(root, "crosscheck.config.json"));
  });

  it("never mutates DEFAULT_CONFIG across loads", async () => {
    await writeJson(path.join(root, "crosscheck.config.json"), { rules: { disable: ["x"] }, ignore: ["a/**"] });
    await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(DEFAULT_CONFIG.rules.disable).toEqual([]);
    expect(DEFAULT_CONFIG.ignore).toEqual([]);
  });
});

describe("loadConfig — precedence (§12.1)", () => {
  it("merges defaults < global < project", async () => {
    await mkdir(path.join(home, ".crosscheck"), { recursive: true });
    await writeJson(path.join(home, ".crosscheck", "config.json"), {
      output: { maxTests: 3 },
      llm: { provider: "anthropic" },
    });
    await writeJson(path.join(root, "crosscheck.config.json"), {
      output: { color: false },
      rules: { disable: ["crypto/weak-hash"] },
    });

    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(3); // from global
    expect(loaded.config.output.color).toBe(false); // from project
    expect(loaded.config.output.maxClusters).toBe(8); // default untouched
    expect(loaded.config.llm.provider).toBe("anthropic");
    expect(loaded.config.rules.disable).toEqual(["crypto/weak-hash"]);
    expect(loaded.sources).toEqual([
      path.join(home, ".crosscheck", "config.json"),
      path.join(root, "crosscheck.config.json"),
    ]);
    expect(loaded.projectConfigPath).toBe(path.join(root, "crosscheck.config.json"));
  });

  it("lets env vars beat the project config (§12.3)", async () => {
    await writeJson(path.join(root, "crosscheck.config.json"), {
      llm: { provider: "anthropic", model: "claude-sonnet-4-5" },
      output: { color: true },
    });
    const loaded = await loadConfig({
      cwd: root,
      env: { CROSSCHECK_LLM_PROVIDER: "openai", CROSSCHECK_LLM_MODEL: "gpt-5-mini", NO_COLOR: "1" },
      homeDir: home,
    });
    expect(loaded.config.llm.provider).toBe("openai");
    expect(loaded.config.llm.model).toBe("gpt-5-mini");
    expect(loaded.config.output.color).toBe(false);
  });

  it("treats empty env vars as unset", async () => {
    const loaded = await loadConfig({
      cwd: root,
      env: { CROSSCHECK_LLM_PROVIDER: "", CROSSCHECK_LLM_MODEL: "", NO_COLOR: "" },
      homeDir: home,
    });
    expect(loaded.config.llm.provider).toBeNull();
    expect(loaded.config.llm.model).toBeNull();
    expect(loaded.config.output.color).toBe(true);
  });

  it("throws ConfigError for an invalid CROSSCHECK_LLM_PROVIDER", async () => {
    await expect(loadConfig({ cwd: root, env: { CROSSCHECK_LLM_PROVIDER: "gemini" }, homeDir: home })).rejects.toThrow(
      ConfigError,
    );
    await expect(
      loadConfig({ cwd: root, env: { CROSSCHECK_LLM_PROVIDER: "gemini" }, homeDir: home }),
    ).rejects.toThrow(/invalid CROSSCHECK_LLM_PROVIDER "gemini"/);
  });
});

describe("loadConfig — deep-merge semantics", () => {
  it("merges objects, replaces arrays, merges consentGiven by key", async () => {
    await mkdir(path.join(home, ".crosscheck"), { recursive: true });
    await writeJson(path.join(home, ".crosscheck", "config.json"), {
      rules: {
        disable: ["crypto/weak-hash"],
        severityOverrides: { "db/destructive-migration": "medium" },
      },
      ignore: ["fixtures/**"],
      llm: { consentGiven: { anthropic: true } },
    });
    await writeJson(path.join(root, "crosscheck.config.json"), {
      rules: { disable: ["db/raw-sql-injection"], enable: ["payments/amount-math"] },
      llm: { consentGiven: { openai: true } },
    });

    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    // arrays REPLACE, not concat
    expect(loaded.config.rules.disable).toEqual(["db/raw-sql-injection"]);
    expect(loaded.config.ignore).toEqual(["fixtures/**"]); // project omitted → global survives
    expect(loaded.config.rules.enable).toEqual(["payments/amount-math"]);
    // objects merge key-by-key
    expect(loaded.config.rules.severityOverrides).toEqual({ "db/destructive-migration": "medium" });
    expect(loaded.config.llm.consentGiven).toEqual({ anthropic: true, openai: true });
  });
});

describe("loadConfig — project discovery (§11.7)", () => {
  it("nearest config walking up from cwd wins when no repo root is known", async () => {
    const pkg = path.join(root, "pkg");
    const sub = path.join(pkg, "sub");
    await mkdir(sub, { recursive: true });
    await writeJson(path.join(root, "crosscheck.config.json"), { output: { maxTests: 11 } });
    await writeJson(path.join(pkg, "crosscheck.config.json"), { output: { maxTests: 22 } });

    const loaded = await loadConfig({ cwd: sub, env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(22);
    expect(loaded.projectConfigPath).toBe(path.join(pkg, "crosscheck.config.json"));
  });

  it("uses the repo-root config when a repo root is known and no scope is given", async () => {
    const pkg = path.join(root, "pkg");
    const sub = path.join(pkg, "sub");
    await mkdir(sub, { recursive: true });
    await writeJson(path.join(root, "crosscheck.config.json"), { output: { maxTests: 11 } });
    await writeJson(path.join(pkg, "crosscheck.config.json"), { output: { maxTests: 22 } });

    const loaded = await loadConfig({ cwd: sub, repoRoot: root, env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(11);
    expect(loaded.projectConfigPath).toBe(path.join(root, "crosscheck.config.json"));
  });

  it("walks up from the scope directory when --scope is given", async () => {
    const pkg = path.join(root, "pkg");
    const sub = path.join(pkg, "sub");
    await mkdir(sub, { recursive: true });
    await writeJson(path.join(root, "crosscheck.config.json"), { output: { maxTests: 11 } });
    await writeJson(path.join(pkg, "crosscheck.config.json"), { output: { maxTests: 22 } });

    const loaded = await loadConfig({ cwd: root, repoRoot: root, scope: "pkg/sub", env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(22);
    expect(loaded.projectConfigPath).toBe(path.join(pkg, "crosscheck.config.json"));
  });

  it("walks above the repo root when nothing is found below", async () => {
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeJson(path.join(root, "crosscheck.config.json"), { output: { maxTests: 7 } });

    const loaded = await loadConfig({ cwd: nested, repoRoot: path.join(root, "a"), env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(7);
  });
});

describe("loadConfig — errors (§12.1)", () => {
  it("throws ConfigError with a pointer for invalid project config", async () => {
    const filePath = path.join(root, "crosscheck.config.json");
    await writeJson(filePath, { llm: { maxTokensPerReview: "lots" } });
    const err = await loadConfig({ cwd: root, env: {}, homeDir: home }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      `invalid config at ${filePath}: llm.maxTokensPerReview: expected number, got string`,
    );
  });

  it("throws ConfigError for unparseable JSON", async () => {
    const filePath = path.join(root, "crosscheck.config.json");
    await writeFile(filePath, "{ not json ", "utf8");
    const err = await loadConfig({ cwd: root, env: {}, homeDir: home }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(new RegExp(`^invalid config at ${filePath.replace(/[/.]/g, "\\$&")}: `));
  });

  it("surfaces unknown-key warnings without failing", async () => {
    await writeJson(path.join(root, "crosscheck.config.json"), { llm: { maxToken: 1 } });
    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(loaded.warnings).toEqual(['unknown config key "llm.maxToken" — did you mean "llm.maxTokensPerReview"?']);
  });

  it("loads JSONC project configs (comments + trailing commas)", async () => {
    await writeFile(
      path.join(root, "crosscheck.config.json"),
      `// team config
{ "output": { "maxTests": 5, }, }
`,
      "utf8",
    );
    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(5);
  });
});

describe("loadConfig — --config / CROSSCHECK_CONFIG bypass", () => {
  it("loads exactly the given file and skips discovery", async () => {
    const elsewhere = path.join(root, "elsewhere.json");
    await writeJson(elsewhere, { output: { maxTests: 42 } });
    await writeJson(path.join(root, "crosscheck.config.json"), { output: { maxTests: 1 } });

    const loaded = await loadConfig({ cwd: root, configPath: elsewhere, env: {}, homeDir: home });
    expect(loaded.config.output.maxTests).toBe(42);
    expect(loaded.sources).toEqual([elsewhere]);
    expect(loaded.projectConfigPath).toBeNull();
  });

  it("honors CROSSCHECK_CONFIG when no explicit configPath is given", async () => {
    const elsewhere = path.join(root, "env-picked.json");
    await writeJson(elsewhere, { strict: { failOn: "low" } });
    const loaded = await loadConfig({ cwd: root, env: { CROSSCHECK_CONFIG: elsewhere }, homeDir: home });
    expect(loaded.config.strict.failOn).toBe("low");
    expect(loaded.sources).toEqual([elsewhere]);
  });

  it("is fatal when the bypass file is missing or invalid", async () => {
    const missing = path.join(root, "nope.json");
    await expect(loadConfig({ cwd: root, configPath: missing, env: {}, homeDir: home })).rejects.toThrow(
      `config file not found: ${missing}`,
    );

    const bad = path.join(root, "bad.json");
    await writeJson(bad, { version: 2 });
    await expect(loadConfig({ cwd: root, configPath: bad, env: {}, homeDir: home })).rejects.toThrow(ConfigError);
  });
});

describe("applyFlags (§12.4)", () => {
  const base: CrossCheckConfig = structuredClone(DEFAULT_CONFIG);

  it("maps format, maxTests, failOn, and color onto config", () => {
    const next = applyFlags(base, { format: "markdown", maxTests: 4, failOn: "low", color: false }, {});
    expect(next.output.format).toBe("markdown");
    expect(next.output.maxTests).toBe(4);
    expect(next.strict.failOn).toBe("low");
    expect(next.output.color).toBe(false);
  });

  it("does not mutate the input config", () => {
    const next = applyFlags(base, { format: "json" }, {});
    expect(next).not.toBe(base);
    expect(base.output.format).toBe("terminal");
  });

  it("lets NO_COLOR win over --color", () => {
    const next = applyFlags(base, { color: true }, { NO_COLOR: "1" });
    expect(next.output.color).toBe(false);
  });

  it("leaves unspecified flags untouched", () => {
    const next = applyFlags(base, {}, {});
    expect(next).toEqual(base);
  });
});

describe("writeProjectConfig", () => {
  it("writes the canonical text and round-trips through loadConfig", async () => {
    const filePath = await writeProjectConfig(root);
    expect(filePath).toBe(path.join(root, "crosscheck.config.json"));

    const loaded = await loadConfig({ cwd: root, env: {}, homeDir: home });
    expect(loaded.sources).toEqual([filePath]);
    expect(loaded.projectConfigPath).toBe(filePath);
    expect(loaded.config.version).toBe(1);
    expect(loaded.config.rules.enable).toEqual([]);
    expect(loaded.config.ignore).toEqual([]);
    expect(loaded.config.strict.failOn).toBe("high");
    expect(loaded.config.llm.provider).toBeNull();
    expect(loaded.warnings).toEqual([]);
  });

  it("refuses to overwrite without force, overwrites with force", async () => {
    const filePath = await writeProjectConfig(root);
    await expect(writeProjectConfig(root)).rejects.toThrow(ConfigError);
    await expect(writeProjectConfig(root)).rejects.toThrow(/already exists/);
    await expect(writeProjectConfig(root, { force: true })).resolves.toBe(filePath);
  });

  it("exports DEFAULT_PROJECT_CONFIG_TEXT with $schema, version 1 and the minimal body", () => {
    const parsed = JSON.parse(DEFAULT_PROJECT_CONFIG_TEXT) as Record<string, unknown>;
    expect(parsed.$schema).toContain("schema/crosscheck.config.schema.json");
    expect(parsed.version).toBe(1);
    expect((parsed.rules as Record<string, unknown>).enable).toEqual([]);
    expect(parsed.ignore).toEqual([]);
    expect((parsed.strict as Record<string, unknown>).failOn).toBe("high");
    expect((parsed.llm as Record<string, unknown>).provider).toBeNull();
  });
});
