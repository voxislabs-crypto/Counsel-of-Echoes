import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPacket } from "./packet.js";
import { investigateRepository, openRelative } from "./investigate.js";

const exec = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await exec("git", ["-C", repo, ...args], { windowsHide: true });
}

test("each seat opens only its own tracked files", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "coe-invest-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coe-outside-"));
  await mkdir(path.join(repo, "src"), { recursive: true });
  await mkdir(path.join(repo, "tests"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(repo, "README.md"), "greeting helper\n", "utf8");
  await writeFile(path.join(repo, "src", "app.py"), "def value():\n    return 'stub'\n", "utf8");
  await writeFile(path.join(repo, "tests", "test_app.py"), "def test_app():\n    assert True\n", "utf8");
  await writeFile(path.join(repo, ".env"), "TOKEN=secret\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "SECRET_TOKEN_OUTSIDE\n", "utf8");
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "council-tests@example.com"]);
  await git(repo, ["config", "user.name", "Council Tests"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await exec("cmd", ["/c", "mklink", "/J", path.join(repo, "linked"), outside], { windowsHide: true });
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);

  const record = await investigateRepository(repo, "Add a greeting helper in the implementation.");
  assert.equal(record.write_authority, false);
  assert.equal(record.shell_authority, false);
  assert.equal(record.seats.length, 3);
  const bySeat = Object.fromEntries(record.seats.map((seat) => [seat.seat_id, seat]));
  assert.deepEqual(bySeat.gpt.files_opened, ["README.md"]);
  assert.ok(bySeat.claude.files_opened.every((file) => file.startsWith("tests/")));
  assert.deepEqual(bySeat.grok.files_opened, ["src/app.py"]);
  const excerpts = record.seats.flatMap((seat) => seat.excerpts.map((item) => item.text)).join("\n");
  assert.equal(excerpts.includes("TOKEN=secret"), false);
  assert.equal(excerpts.includes("SECRET_TOKEN_OUTSIDE"), false);
  assert.equal(await openRelative(repo, "../secret.txt"), null);
  assert.equal(await openRelative(repo, "linked/secret.txt"), null);

  const status = await exec("git", ["-C", repo, "status", "--porcelain"], { windowsHide: true });
  assert.equal(status.stdout.trim(), "");

  const store = path.join(repo, ".council-store");
  const built = await createPacket({
    question: "Add the greeting helper described in the structured packet.",
    context: [
      "```structured-packet",
      JSON.stringify({
        expected_files: ["hello.py"],
        instructions: ["Create hello.py."],
        acceptance_criteria: ["hello.py exists."]
      }),
      "```"
    ].join("\n"),
    repository: repo,
    mode: "mock",
    storeDir: store,
    investigate: true
  });
  assert.equal(built.exitCode, 0);
  assert.match(built.packet.context_summary, /Independent read-only investigation/);
  assert.doesNotMatch(built.packet.context_summary, /not independent/i);
  assert.match(built.packet.context_summary, /README\.md/);
  assert.match(built.packet.context_summary, /src\/app\.py/);
});
