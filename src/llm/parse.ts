/**
 * Parses a model's raw text response into the constrained shape the system
 * prompt asked for (§9.4: `what changed` + `what to double-check`). Any
 * deviation — non-JSON, wrong field types — degrades to `null`, which every
 * adapter turns into `status: "unavailable", reason: "unparseable model
 * response — ignored"` (§11.6) rather than guessing at a malformed payload.
 */

export interface ParsedModelOutput {
  summary: string;
  doubleCheck: string[];
}

export function parseModelJson(text: string): ParsedModelOutput | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Defensive: strip a markdown code fence even though the prompt asks the
  // model not to use one — models don't always comply.
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let data: unknown;
  try {
    data = JSON.parse(unfenced);
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.summary !== "string" || obj.summary.trim().length === 0) return null;
  if (!Array.isArray(obj.doubleCheck) || !obj.doubleCheck.every((item) => typeof item === "string")) {
    return null;
  }

  return {
    summary: obj.summary,
    doubleCheck: (obj.doubleCheck as string[]).slice(0, 3),
  };
}
