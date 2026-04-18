import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  councilEventSchema,
  type CouncilEvent,
  type Critique,
  type Proposal,
  type RunRecord,
  type RunRequest,
  type RunStatus,
  type Synthesis
} from "../core/schemas.js";

type StoreEvents = {
  event: (event: CouncilEvent) => void;
};

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly emitter = new EventEmitter();
  private readonly baseDir: string;

  constructor(baseDir = path.resolve(process.cwd(), "data", "runs")) {
    this.baseDir = baseDir;
  }

  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  createRun(request: RunRequest): RunRecord {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const record: RunRecord = {
      runId,
      request,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      events: [],
      proposals: [],
      critiques: []
    };

    this.runs.set(runId, record);

    return record;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  subscribe(listener: (event: CouncilEvent) => void): () => void {
    this.emitter.on("event", listener);

    return () => {
      this.emitter.off("event", listener);
    };
  }

  async setStatus(runId: string, status: RunStatus, error?: string): Promise<void> {
    const record = this.requireRun(runId);
    record.status = status;
    record.error = error;
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
  }

  async appendEvent(runId: string, event: Omit<CouncilEvent, "eventId" | "seq" | "ts">): Promise<CouncilEvent> {
    const record = this.requireRun(runId);
    const fullEvent = councilEventSchema.parse({
      ...event,
      eventId: randomUUID(),
      runId,
      seq: record.events.length,
      ts: new Date().toISOString()
    });

    record.events.push(fullEvent);
    record.updatedAt = fullEvent.ts;

    if (fullEvent.type === "proposal.completed") {
      record.proposals.push(fullEvent.payload.proposal as Proposal);
    }

    if (fullEvent.type === "critique.completed") {
      record.critiques.push(fullEvent.payload.critique as Critique);
    }

    if (fullEvent.type === "synthesis.completed") {
      record.synthesis = fullEvent.payload.synthesis as Synthesis;
    }

    this.emitter.emit("event", fullEvent);
    await this.persist(record);

    return fullEvent;
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);

    if (!record) {
      throw new Error(`Unknown run: ${runId}`);
    }

    return record;
  }

  private async persist(record: RunRecord): Promise<void> {
    const target = path.join(this.baseDir, `${record.runId}.json`);
    await writeFile(target, JSON.stringify(record, null, 2), "utf8");
  }
}