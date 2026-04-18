import "dotenv/config";
import http from "node:http";
import { readRuntimeConfig } from "./providers/index.js";
import { RunStore } from "./store/runStore.js";
import { CouncilService } from "./core/council.js";
import { createApp } from "./server/app.js";
import { attachCouncilWebSocket } from "./server/websocket.js";
import { EvalStore } from "./evals/store.js";
import { EvalService } from "./evals/service.js";

async function main() {
  const config = readRuntimeConfig();
  const store = new RunStore();
  await store.initialize();

  const council = new CouncilService(store, config);
  const evalStore = new EvalStore();
  await evalStore.initialize();
  const evals = new EvalService(council, config, evalStore);
  const app = createApp({ council, store, config, evals });
  const server = http.createServer(app);

  attachCouncilWebSocket(server, store);

  server.listen(config.port, () => {
    console.log(`Council of Echoes listening on http://localhost:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});