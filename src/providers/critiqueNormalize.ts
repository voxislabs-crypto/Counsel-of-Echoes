import { agentIds } from "../core/agents.js";
import { normalizeStringList } from "./proposalNormalize.js";

const councilSeatIds = new Set<string>(agentIds);

// Turns model-shaped critique lists into the strings critiqueSchema requires.
// The list rules stay in the schema. This only renders each item.
export function normalizeCritiqueRecord(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    concerns: normalizeStringListField("concerns", raw.concerns),
    usefulAgreements: normalizeStringListField("usefulAgreements", raw.usefulAgreements)
  };
}

// Uses the critiqued seat only when the model omitted targetAgentId.
// Any other token is rejected so an unmentioned seat is never invented.
export function resolveCritiqueTargetAgentId(raw: unknown, critiquedSeat?: string): string {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return deriveCritiquedSeat(critiquedSeat, "blank");
    if (!councilSeatIds.has(value)) {
      throw new Error(`targetAgentId was "${value}", which is not a council seat`);
    }
    return value;
  }

  if (raw === undefined || raw === null) {
    return deriveCritiquedSeat(critiquedSeat, "missing");
  }

  throw new Error(`targetAgentId was ${describeReceived(raw)}, expected a seat id string`);
}

function deriveCritiquedSeat(critiquedSeat: string | undefined, reason: "missing" | "blank"): string {
  const derived = critiquedSeat?.trim() ?? "";
  if (derived && councilSeatIds.has(derived)) return derived;
  throw new Error(`targetAgentId was ${reason} and no single critiqued seat was available`);
}

function describeReceived(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

function normalizeStringListField(field: string, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return normalizeStringList(field, value);
}
