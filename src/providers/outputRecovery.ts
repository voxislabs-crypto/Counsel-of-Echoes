import { z } from "zod";

// Shared mechanics for one schema-aware recovery pass.
// Stage adapters decide which transforms are safe and how a field merges.
// This module does not invent values and does not default missing judgments.

export type NormalizationNote = {
  field: string;
  action: string;
};

export type ValidationIssue = {
  path: string;
  code: string;
  expected: string;
  message: string;
};

export type OutputRepairRequest = {
  fields: ValidationIssue[];
  preserved: Record<string, unknown>;
  prompt: string;
};

export type OutputTrace = {
  seat: string;
  model: string;
  stage: "proposal" | "critique";
  raw: unknown;
  normalizations: NormalizationNote[];
  validationErrors: ValidationIssue[];
  repairRequest?: OutputRepairRequest;
  repairRaw?: unknown;
  finalValidationErrors?: ValidationIssue[];
  result: "accepted" | "failed";
};

export class StructuredOutputError extends Error {
  readonly trace: OutputTrace;

  constructor(message: string, trace: OutputTrace) {
    super(message);
    this.name = "StructuredOutputError";
    this.trace = trace;
  }
}

export type PreparedOutput = {
  record: Record<string, unknown>;
  notes: NormalizationNote[];
  issues: ValidationIssue[];
};

type RecoverOptions<T> = {
  stage: "proposal" | "critique";
  stageLabel: string;
  schema: z.ZodTypeAny;
  raw: Record<string, unknown>;
  seat: string;
  model: string;
  identity: Record<string, unknown>;
  fieldGuide: Record<string, string>;
  normalize: (raw: Record<string, unknown>) => PreparedOutput;
  prepare?: (record: Record<string, unknown>) => PreparedOutput;
  mergeField?: (field: string, original: Record<string, unknown>, repair: Record<string, unknown>) => unknown;
  describeFailure: (phase: "first" | "repair", issues: ValidationIssue[]) => string;
  repair?: (request: OutputRepairRequest) => Promise<unknown>;
  onTrace?: (trace: OutputTrace) => void;
  contextLines?: string[];
  extraLines?: (issues: ValidationIssue[], preserved: Record<string, unknown>) => string[];
  refusal: string;
};

export async function recoverStructuredOutput<T>(options: RecoverOptions<T>): Promise<T> {
  const raw = snapshot(options.raw);
  const first = evaluate(options, raw);
  if (first.issues.length === 0 && first.parsed) {
    const trace = traceOf(options, raw, first.notes, [], undefined, undefined, [], "accepted");
    options.onTrace?.(trace);
    return first.parsed;
  }

  const failedFields = topLevelFields(first.issues);
  const preserved = preservedSnapshot(first.record, failedFields, options.mergeField);
  const repairRequest = buildRepairRequest(options, first.issues, preserved);
  let repairRaw: unknown;
  let repairedRecord = first.record;
  let repairError: ValidationIssue | undefined;

  if (options.repair) {
    try {
      repairRaw = snapshot(await options.repair(repairRequest));
      repairedRecord = mergeFailedFields(first.record, repairRaw, failedFields, options.mergeField);
    } catch (error) {
      repairError = {
        path: "(repair)",
        code: "repair_failed",
        expected: "a JSON object containing only the failed fields",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const second = evaluate(options, repairedRecord);
  const finalIssues = repairError ? [repairError, ...second.issues] : second.issues;
  const notes = [...first.notes, ...second.notes];

  if (!repairError && finalIssues.length === 0 && second.parsed && options.repair) {
    const trace = traceOf(options, raw, notes, first.issues, repairRequest, repairRaw, [], "accepted");
    options.onTrace?.(trace);
    return second.parsed;
  }

  if (!options.repair) {
    const trace = traceOf(options, raw, first.notes, first.issues, undefined, undefined, first.issues, "failed");
    const message = `${options.stageLabel} failed for ${options.seat} (${options.model}): ${options.describeFailure("first", first.issues)}`;
    const error = new StructuredOutputError(message, trace);
    options.onTrace?.(trace);
    throw error;
  }

  const trace = traceOf(options, raw, notes, first.issues, repairRequest, repairRaw, finalIssues, "failed");
  const message = `${options.stageLabel} failed for ${options.seat} (${options.model}): ${options.describeFailure("repair", finalIssues)}`;
  const error = new StructuredOutputError(message, trace);
  options.onTrace?.(trace);
  throw error;
}

export function issuesFromZod(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    code: issue.code,
    expected: "expected" in issue ? String(issue.expected) : issue.message,
    message: issueMessage(issue)
  }));
}

export function outputFailurePayload(error: unknown): { message: string; outputTrace?: OutputTrace } {
  if (error instanceof StructuredOutputError) {
    return { message: error.message, outputTrace: error.trace };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function evaluate<T>(options: RecoverOptions<T>, source: Record<string, unknown>): {
  record: Record<string, unknown>;
  notes: NormalizationNote[];
  issues: ValidationIssue[];
  parsed?: T;
} {
  let notes: NormalizationNote[] = [];
  let record = source;
  const issues: ValidationIssue[] = [];

  try {
    const normalized = options.normalize(source);
    record = normalized.record;
    notes = normalized.notes;
    issues.push(...normalized.issues);
  } catch (error) {
    issues.push({
      path: "(normalize)",
      code: "normalize_failed",
      expected: "a safe deterministic normalization",
      message: error instanceof Error ? error.message : String(error)
    });
  }

  if (options.prepare) {
    try {
      const prepared = options.prepare(record);
      record = prepared.record;
      notes = [...notes, ...prepared.notes];
      issues.push(...prepared.issues);
    } catch (error) {
      issues.push({
        path: "(prepare)",
        code: "prepare_failed",
        expected: "a prepared record",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const candidate = applyIdentity(record, options.identity);
  const parsed = options.schema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(...issuesFromZod(parsed.error));
  }

  if (issues.length > 0 || !parsed.success) {
    return { record: candidate, notes, issues };
  }

  return { record: candidate, notes, issues: [], parsed: parsed.data as T };
}

function mergeFailedFields(
  original: Record<string, unknown>,
  repair: unknown,
  failedFields: Set<string>,
  mergeField: RecoverOptions<unknown>["mergeField"]
): Record<string, unknown> {
  const next = { ...original };
  if (!repair || typeof repair !== "object" || Array.isArray(repair)) return next;
  const incoming = repair as Record<string, unknown>;

  for (const field of failedFields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    if (incoming[field] === undefined) continue;
    next[field] = mergeField ? mergeField(field, original, incoming) : incoming[field];
  }

  return next;
}

function preservedSnapshot(
  record: Record<string, unknown>,
  failedFields: Set<string>,
  mergeField: RecoverOptions<unknown>["mergeField"]
): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "agentId" || key === "model") continue;
    if (!failedFields.has(key)) {
      preserved[key] = value;
      continue;
    }
    if (mergeField && key === "claims") {
      preserved.claims = mergeField(key, { claims: value }, { claims: [] });
    }
  }
  return preserved;
}

function buildRepairRequest<T>(
  options: RecoverOptions<T>,
  issues: ValidationIssue[],
  preserved: Record<string, unknown>
): OutputRepairRequest {
  const fields = dedupeIssues(issues);
  const keys = [...topLevelFields(fields)];
  const lines = [
    `Task: correct only the failed ${options.stage} fields.`,
    options.refusal,
    "Return one JSON object containing only the failed keys listed below.",
    "Do not repeat keys that already passed.",
    ...(options.contextLines ?? []),
    ...(options.extraLines?.(fields, preserved) ?? []),
    "Failed fields:"
  ];

  for (const issue of fields) {
    const top = issue.path.split(".")[0] || issue.path;
    const expected = options.fieldGuide[top] ?? issue.expected;
    lines.push(`- ${issue.path}: ${expected}. Validation: ${issue.message}.`);
  }

  lines.push(`Keys you may return: ${keys.join(", ") || "(none)"}.`);
  lines.push(`Preserved values, already kept: ${JSON.stringify(preserved)}`);
  return { fields, preserved, prompt: lines.join("\n") };
}

function traceOf(
  options: RecoverOptions<unknown>,
  raw: unknown,
  normalizations: NormalizationNote[],
  validationErrors: ValidationIssue[],
  repairRequest: OutputRepairRequest | undefined,
  repairRaw: unknown,
  finalValidationErrors: ValidationIssue[],
  result: "accepted" | "failed"
): OutputTrace {
  return {
    seat: options.seat,
    model: options.model,
    stage: options.stage,
    raw,
    normalizations,
    validationErrors,
    ...(repairRequest ? { repairRequest } : {}),
    ...(repairRaw !== undefined ? { repairRaw } : {}),
    ...(result === "failed" || finalValidationErrors.length > 0 ? { finalValidationErrors } : {}),
    result
  };
}

function applyIdentity(record: Record<string, unknown>, identity: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const [key, value] of Object.entries(identity)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function topLevelFields(issues: ValidationIssue[]): Set<string> {
  const fields = new Set<string>();
  for (const issue of issues) {
    const top = issue.path.split(".")[0];
    if (top && !top.startsWith("(")) fields.add(top);
  }
  return fields;
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const unique: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.path}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

function issueMessage(issue: z.ZodIssue): string {
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `Required (${issue.expected})`;
  }
  return issue.message;
}

function snapshot<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
