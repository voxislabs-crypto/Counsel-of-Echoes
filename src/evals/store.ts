import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { evalSuiteResultSchema, type EvalSuiteResult } from "./schemas.js";

export class EvalStore {
  private readonly baseDir: string;

  constructor(baseDir = path.resolve(process.cwd(), "data", "evals")) {
    this.baseDir = baseDir;
  }

  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  createId(): string {
    return randomUUID();
  }

  async persist(result: EvalSuiteResult): Promise<void> {
    const target = path.join(this.baseDir, `${result.evalId}.json`);
    await writeFile(target, JSON.stringify(result, null, 2), "utf8");
  }

  async list(): Promise<Array<Pick<EvalSuiteResult, "evalId" | "createdAt" | "mode" | "baselineAgent" | "summary">>> {
    await this.initialize();
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const results: Array<Pick<EvalSuiteResult, "evalId" | "createdAt" | "mode" | "baselineAgent" | "summary">> = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const record = await this.get(path.basename(entry.name, ".json"));

      if (record) {
        results.push({
          evalId: record.evalId,
          createdAt: record.createdAt,
          mode: record.mode,
          baselineAgent: record.baselineAgent,
          summary: record.summary
        });
      }
    }

    return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async get(evalId: string): Promise<EvalSuiteResult | undefined> {
    try {
      const target = path.join(this.baseDir, `${evalId}.json`);
      const content = await readFile(target, "utf8");
      return evalSuiteResultSchema.parse(JSON.parse(content));
    } catch {
      return undefined;
    }
  }
}