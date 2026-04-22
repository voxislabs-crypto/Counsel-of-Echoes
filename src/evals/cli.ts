import "dotenv/config";
import { readRuntimeConfig } from "../providers/index.js";
import { RunStore } from "../store/runStore.js";
import { CouncilService } from "../core/council.js";
import { EvalStore } from "./store.js";
import { EvalService } from "./service.js";
import { benchmarkEvalCases, defaultEvalCases } from "./fixtures.js";
import type { EvalSuiteResult } from "./schemas.js";

async function main() {
  const config = readRuntimeConfig();
  const modeArg = process.argv.find((arg) => arg === "--mode");
  const modeValue = modeArg ? process.argv[process.argv.indexOf(modeArg) + 1] : undefined;
  const mode = modeValue === "live" ? "live" : modeValue === "mock" ? "mock" : config.providerMode;
  const suiteArg = process.argv.find((arg) => arg === "--suite");
  const suiteValue = suiteArg ? process.argv[process.argv.indexOf(suiteArg) + 1] : undefined;
  const suite = suiteValue === "benchmark" ? "benchmark" : "default";
  const report = process.argv.includes("--report");
  const reportOnly = process.argv.includes("--report-only");

  const runStore = new RunStore();
  await runStore.initialize();

  const council = new CouncilService(runStore, config);
  const evalStore = new EvalStore();
  const evalService = new EvalService(council, config, evalStore);
  const result = await evalService.runSuite({
    mode,
    cases: suite === "benchmark" ? benchmarkEvalCases : defaultEvalCases
  });

  if (report || reportOnly) {
    renderReport(result);
  }

  if (!reportOnly) {
    console.log(JSON.stringify(result, null, 2));
  }
}

function renderReport(result: EvalSuiteResult): void {
  const header = [
    "Case",
    "Winner",
    "Council",
    "Baseline",
    "VoteReq",
    "ChlgAbs",
    "Minority",
    "Proxy"
  ];

  const rows = result.results.map((entry) => [
    entry.case.id,
    entry.winner,
    String(entry.councilScore.total),
    String(entry.baselineScore.total),
    entry.deliberationMetrics.voteRequired ? "Y" : "N",
    entry.deliberationMetrics.challengeAbsent ? "Y" : "N",
    entry.deliberationMetrics.minorityOverruled ? "Y" : "N",
    `${entry.deliberationMetrics.minorityCorrectnessProxy}:${entry.deliberationMetrics.minoritySignalScore.toFixed(2)}`
  ]);

  const widths = header.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index], " ")).join(" | ");

  console.log(`\n=== Eval Report (${result.mode}) ===`);
  console.log(formatRow(header));
  console.log(widths.map((width) => "-".repeat(width)).join("-+-"));
  rows.forEach((row) => console.log(formatRow(row)));
  console.log("\nSummary:");
  console.log(`- Cases: ${result.summary.casesRun}`);
  console.log(`- Council wins: ${result.summary.councilWins}, baseline wins: ${result.summary.baselineWins}, ties: ${result.summary.ties}`);
  console.log(`- Avg scores: council ${result.summary.averageCouncilScore}, baseline ${result.summary.averageBaselineScore}`);
  console.log(`- Agreement rate: ${toPercent(result.summary.agreementRate)}`);
  console.log(`- Vote required: ${toPercent(result.summary.voteRequiredFrequency)}`);
  console.log(`- Challenge absent: ${toPercent(result.summary.challengeAbsentFrequency)}`);
  console.log(`- Minority overruled: ${toPercent(result.summary.minorityOverruledFrequency)}`);
  console.log(`- Minority correctness proxy: ${toPercent(result.summary.minorityCorrectnessProxyRate)}`);
}

function toPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});