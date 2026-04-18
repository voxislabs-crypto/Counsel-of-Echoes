import "dotenv/config";
import { readRuntimeConfig } from "../providers/index.js";
import { RunStore } from "../store/runStore.js";
import { CouncilService } from "../core/council.js";
import { EvalStore } from "./store.js";
import { EvalService } from "./service.js";

async function main() {
  const config = readRuntimeConfig();
  const modeArg = process.argv.find((arg) => arg === "--mode");
  const modeValue = modeArg ? process.argv[process.argv.indexOf(modeArg) + 1] : undefined;
  const mode = modeValue === "live" ? "live" : modeValue === "mock" ? "mock" : config.providerMode;

  const runStore = new RunStore();
  await runStore.initialize();

  const council = new CouncilService(runStore, config);
  const evalStore = new EvalStore();
  const evalService = new EvalService(council, config, evalStore);
  const result = await evalService.runSuite({ mode });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});