import { describe, expect, it } from "vitest";
import { render } from "../../../src/render/index.js";
import { report } from "../checklist/factories.js";

describe("render — format dispatch (§5.7: render(report, format))", () => {
  it("dispatches to the terminal renderer, defaulting color to false (safe for non-TTY)", () => {
    const out = render(report(), "terminal");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
    expect(out).toContain("CrossCheck v0.1.0");
  });

  it("honors an explicit color:true option for terminal format", () => {
    const out = render(report(), "terminal", { color: true });
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true);
  });

  it("dispatches to the markdown renderer", () => {
    const out = render(report(), "markdown");
    expect(out).toContain("## CrossCheck review");
  });

  it("dispatches to the json renderer", () => {
    const out = render(report(), "json");
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
