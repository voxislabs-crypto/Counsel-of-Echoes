import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOC = /\.(md|markdown|txt|adoc|rst)$/i;
const MANIFEST = /^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|readme(\..*)?)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)(\/|$)/i;
const TEST_FILE = /\.(test|spec)\.[^.]+$/i;
const SOURCE = /\.(py|ts|tsx|js|jsx|go|rs|java|cs)$/i;
const GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM"
];

export type SeatId = "gpt" | "claude" | "grok";

export type SeatInvestigation = {
  seat_id: SeatId;
  seat: string;
  query: string;
  files_opened: string[];
  excerpts: Array<{ path: string; text: string }>;
  skipped: string[];
  authority: "read-only";
};

export type InvestigationRecord = {
  schema_version: 1;
  repository: string;
  authority: "read-only";
  write_authority: false;
  shell_authority: false;
  seats: SeatInvestigation[];
  errors: string[];
};

const SEATS: Array<{ seat_id: SeatId; seat: string; query: string; match: (relative: string) => boolean }> = [
  {
    seat_id: "gpt",
    seat: "The Strategist",
    query: "specifications, documentation, and project manifests",
    match: isDoc
  },
  {
    seat_id: "claude",
    seat: "The Analyst",
    query: "tests and verification files",
    match: isTest
  },
  {
    seat_id: "grok",
    seat: "Ara",
    query: "implementation source",
    match: isImpl
  }
];

export async function investigateRepository(repository: string, question: string): Promise<InvestigationRecord> {
  const root = path.resolve(repository);
  const seats: SeatInvestigation[] = [];
  const errors: string[] = [];
  for (const seat of SEATS) {
    let tracked: string[] = [];
    try {
      tracked = await listTracked(root);
    } catch (error) {
      errors.push(`${seat.seat_id}: ${error instanceof Error ? error.message : "git ls-files failed"}`);
    }
    const chosen = rank(tracked.filter(seat.match), question).slice(0, 3);
    const opened: SeatInvestigation["excerpts"] = [];
    const skipped: string[] = [];
    for (const relative of chosen) {
      if (isSecret(relative)) {
        skipped.push(relative);
        continue;
      }
      const text = await openRelative(root, relative);
      if (text === null) {
        skipped.push(relative);
        continue;
      }
      opened.push({ path: relative, text: text.slice(0, 800) });
    }
    seats.push({
      seat_id: seat.seat_id,
      seat: seat.seat,
      query: seat.query,
      files_opened: opened.map((item) => item.path),
      excerpts: opened,
      skipped,
      authority: "read-only"
    });
  }
  return {
    schema_version: 1,
    repository: root,
    authority: "read-only",
    write_authority: false,
    shell_authority: false,
    seats,
    errors
  };
}

export function seatOverlay(seat: SeatInvestigation): string {
  const excerpts = seat.excerpts.map((item) => `File ${item.path}\n${item.text}`).join("\n\n");
  const opened = seat.files_opened.length > 0
    ? `Files opened: ${seat.files_opened.join(", ")}.`
    : "This seat opened no files.";
  return [
    `Independent read-only investigation for ${seat.seat}.`,
    `Query: ${seat.query}.`,
    "Authority: read-only. This seat has no write authority and no shell authority.",
    opened,
    excerpts
  ].join("\n").slice(0, 3500);
}

export function investigationSummary(record: InvestigationRecord): string {
  const cites = record.seats
    .map((seat) => `${seat.seat_id}: ${seat.files_opened.join(", ") || "none"}`)
    .join(". ");
  return (
    "Independent read-only investigation. Each seat opened only its own files "
    + `and has no write or shell authority. ${cites}.`
  ).slice(0, 2000);
}

export async function openRelative(repository: string, relative: string): Promise<string | null> {
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").includes("..")
    || normalized.split("/").includes("")
  ) {
    return null;
  }
  let root: string;
  try {
    root = await realpath(repository);
  } catch {
    return null;
  }
  const full = path.resolve(root, normalized);
  let info;
  try {
    info = await lstat(full);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    return null;
  }
  const escaped = path.relative(root, real);
  if (escaped.startsWith("..") || path.isAbsolute(escaped)) return null;
  try {
    const text = await readFile(full, "utf8");
    if (text.includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

async function listTracked(repository: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", repository, "ls-files", "-z"], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitEnv()
  });
  return stdout.split("\0").map((item) => item.replace(/\\/g, "/")).filter((item) => item && !item.split("/").includes(".."));
}

function rank(files: string[], question: string): string[] {
  const words = question.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  return [...files].sort((left, right) => {
    const delta = score(right, words) - score(left, words);
    if (delta !== 0) return delta;
    return left.localeCompare(right);
  });
}

function score(file: string, words: string[]): number {
  const haystack = file.toLowerCase();
  return words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
}

function isDoc(relative: string): boolean {
  return DOC.test(relative) || MANIFEST.test(path.posix.basename(relative));
}

function isTest(relative: string): boolean {
  return TEST_PATH.test(relative) || TEST_FILE.test(relative);
}

function isImpl(relative: string): boolean {
  return SOURCE.test(relative) && !isTest(relative);
}

function isSecret(relative: string): boolean {
  const base = path.posix.basename(relative).toLowerCase();
  return base === ".env"
    || base.startsWith(".env.")
    || base.includes("credential")
    || base.includes("secret")
    || base.startsWith("id_rsa");
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_OVERRIDES) delete env[key];
  return env;
}
