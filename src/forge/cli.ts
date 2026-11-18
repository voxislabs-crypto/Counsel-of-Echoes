import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProviders, readRuntimeConfig } from "../providers/index.js";
import { examineWithProvider, reviewDiff } from "./diffReview.js";
import { createPacket } from "./packet.js";
import { mockReview } from "./verdict.js";
import type { ProviderMode } from "../providers/types.js";

type Args = Map<string, string | boolean>;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "packet") return writePacket(args);
  if (command === "review") return writeReview(args);
  console.error("Usage: forge:packet | forge:review");
  return 2;
}

async function writePacket(args: Args): Promise<number> {
  const question = required(args, "question");
  const repository = required(args, "repo");
  const mode = readMode(args.get("mode"));
  const context = await readOptionalText(args.get("context-file"), args.get("context"));
  const storeDir = typeof args.get("store") === "string"
    ? String(args.get("store"))
    : path.join(os.tmpdir(), "coe-forge-packet");
  await mkdir(storeDir, { recursive: true });
  const built = await createPacket({
    question,
    context,
    repository,
    mode,
    storeDir,
    investigate: args.get("investigate") === true
  });
  const out = args.get("out");
  const body = JSON.stringify(built.packet, null, 2);
  if (typeof out === "string") {
    await writeFile(out, body + "\n", "utf8");
    if (built.investigation) {
      const investigationOut = typeof args.get("investigation-out") === "string"
        ? String(args.get("investigation-out"))
        : path.join(path.dirname(out), "seat-investigations.json");
      await writeFile(investigationOut, JSON.stringify(built.investigation, null, 2) + "\n", "utf8");
    }
  }
  console.log(body);
  return built.exitCode;
}

async function writeReview(args: Args): Promise<number> {
  const mode = readMode(args.get("mode"));
  const packet = JSON.parse(await readFile(required(args, "packet"), "utf8"));
  const report = JSON.parse(await readFile(required(args, "report"), "utf8"));
  try {
    if (mode === "mock") {
      const verdict = mockReview(packet, report);
      console.log(JSON.stringify(verdict, null, 2));
      return 0;
    }
    const providers = createProviders(readRuntimeConfig(), mode);
    const verdict = await reviewDiff({
      packet,
      report,
      providers,
      examine: (seatId, diff) => {
        const provider = providers.find((item) => item.agentId === seatId);
        return provider ? examineWithProvider(provider, diff) : Promise.resolve(null);
      }
    });
    console.log(JSON.stringify(verdict, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Review rejected.");
    return 2;
  }
}

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, true);
      continue;
    }
    args.set(key, next);
    index += 1;
  }
  return args;
}

function required(args: Args, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function readMode(value: string | boolean | undefined): ProviderMode {
  if (value === "live" || value === "ollama" || value === "mock") return value;
  return "mock";
}

async function readOptionalText(file: string | boolean | undefined, inline: string | boolean | undefined): Promise<string> {
  if (typeof file === "string") return readFile(file, "utf8");
  if (typeof inline === "string") return inline;
  return "";
}

const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("/src/forge/cli.ts") || entry.endsWith("/forge/cli.js")) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
