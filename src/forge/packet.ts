import { randomUUID } from "node:crypto";
import path from "node:path";
import { CouncilService } from "../core/council.js";
import type { Synthesis } from "../core/schemas.js";
import { readRuntimeConfig } from "../providers/index.js";
import type { ProviderMode } from "../providers/types.js";
import { RunStore } from "../store/runStore.js";
import {
  implementationPacketSchema,
  type ImplementationPacket
} from "../contracts/schemas.js";
import {
  investigateRepository,
  investigationSummary,
  seatOverlay,
  type InvestigationRecord
} from "./investigate.js";

const fence = /```structured-packet\s*([\s\S]*?)```/i;
const expectedFileLine = /^expected file:\s*(.+)$/gim;

export type PacketBuild = {
  packet: ImplementationPacket;
  exitCode: number;
  investigation?: InvestigationRecord;
};

export function derivePacket(input: {
  mode: ProviderMode;
  question: string;
  context: string;
  repository: string;
  sourceRunId: string;
  synthesis?: Synthesis;
}): PacketBuild {
  const sourceRunId = input.sourceRunId;
  const base = {
    schema_version: 1 as const,
    packet_id: `pkt_${randomUUID()}`,
    source_run_id: sourceRunId,
    objective: input.question.trim(),
    repository: input.repository,
    context_summary: summarizeContext(input.context),
    scope: "Bounded to the expected files.",
    prohibited_changes: ["Do not modify files outside expected_files."],
    required_tests: [] as string[],
    risks: input.synthesis?.uncertainties?.slice(0, 4) ?? [],
    assumptions: [] as string[],
    disagreements: input.synthesis?.disagreements?.slice(0, 6) ?? []
  };

  if (!input.synthesis) {
    return finish({
      ...base,
      derivation: "fallback",
      expected_files: [],
      instructions: ["Structured extraction failed because the chamber did not synthesize."],
      acceptance_criteria: []
    }, 2);
  }

  const fromSynthesis = expectedFilesFromText([
    input.synthesis.finalAnswer,
    ...input.synthesis.nextActions
  ].join("\n"));
  if (input.mode !== "mock" && fromSynthesis.length > 0) {
    return finish({
      ...base,
      derivation: "council",
      expected_files: fromSynthesis,
      instructions: input.synthesis.nextActions.slice(0, 5),
      acceptance_criteria: input.synthesis.nextActions.slice(0, 5)
    }, 0);
  }

  if (input.mode === "mock") {
    const structured = readStructuredFixture(input.context) ?? readStructuredFixture(input.question);
    if (structured) {
      return finish({
        ...base,
        derivation: "council",
        expected_files: structured.expected_files,
        instructions: structured.instructions,
        acceptance_criteria: structured.acceptance_criteria,
        prohibited_changes: structured.prohibited_changes ?? base.prohibited_changes,
        required_tests: structured.required_tests ?? [],
        scope: structured.scope ?? base.scope
      }, 0);
    }
  }

  return finish({
    ...base,
    derivation: "fallback",
    expected_files: fromSynthesis,
    instructions: input.synthesis.nextActions.slice(0, 5),
    acceptance_criteria: [],
    risks: [
      ...base.risks,
      "Structured file extraction did not produce an implementation-ready specification."
    ]
  }, 2);
}

export async function createPacket(input: {
  question: string;
  context: string;
  repository: string;
  mode: ProviderMode;
  storeDir: string;
  investigate?: boolean;
}): Promise<PacketBuild> {
  const repository = path.resolve(input.repository);
  const investigation = input.investigate
    ? await investigateRepository(repository, input.question)
    : undefined;
  const store = new RunStore(input.storeDir);
  await store.initialize();
  const council = new CouncilService(store, readRuntimeConfig());
  const record = await council.runAndWait({
    question: input.question,
    context: input.context,
    seatContexts: investigation
      ? Object.fromEntries(investigation.seats.map((seat) => [seat.seat_id, seatOverlay(seat)]))
      : undefined,
    mode: input.mode,
    lens: "code",
    research: false
  });
  const built = derivePacket({
    mode: input.mode,
    question: input.question,
    context: input.context,
    repository,
    sourceRunId: record.runId,
    synthesis: record.synthesis
  });
  if (!investigation) return built;
  return {
    packet: implementationPacketSchema.parse({
      ...built.packet,
      context_summary: investigationSummary(investigation)
    }),
    exitCode: built.exitCode,
    investigation
  };
}

function finish(packet: ImplementationPacket, exitCode: number): PacketBuild {
  return {
    packet: implementationPacketSchema.parse(packet),
    exitCode
  };
}

function summarizeContext(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) {
    return "No repository context was attached. This is not independent per-seat investigation.";
  }
  return (
    "Shared bounded repository context. This is not independent per-seat investigation. "
    + trimmed.slice(0, 500)
  );
}

function expectedFilesFromText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(expectedFileLine)) {
    const relative = match[1].trim().replace(/\\/g, "/");
    if (relative && !relative.includes("..") && !/^[A-Za-z]:/.test(relative) && !relative.startsWith("/")) {
      found.push(relative);
    }
  }
  return [...new Set(found)];
}

function readStructuredFixture(text: string): {
  expected_files: string[];
  instructions: string[];
  acceptance_criteria: string[];
  prohibited_changes?: string[];
  required_tests?: string[];
  scope?: string;
} | undefined {
  const match = text.match(fence);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as {
      expected_files?: unknown;
      instructions?: unknown;
      acceptance_criteria?: unknown;
      prohibited_changes?: unknown;
      required_tests?: unknown;
      scope?: unknown;
    };
    if (!Array.isArray(parsed.expected_files) || parsed.expected_files.length === 0) return undefined;
    if (!parsed.expected_files.every((item) => typeof item === "string")) return undefined;
    return {
      expected_files: parsed.expected_files,
      instructions: stringList(parsed.instructions),
      acceptance_criteria: stringList(parsed.acceptance_criteria),
      prohibited_changes: stringList(parsed.prohibited_changes),
      required_tests: stringList(parsed.required_tests),
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined
    };
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
