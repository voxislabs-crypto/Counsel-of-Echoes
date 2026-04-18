import express from "express";
import path from "node:path";
import { RunStore } from "../store/runStore.js";
import { CouncilService } from "../core/council.js";
import type { RuntimeConfig } from "../providers/index.js";
import { agentProfiles } from "../core/agents.js";

type AppDependencies = {
  council: CouncilService;
  store: RunStore;
  config: RuntimeConfig;
};

export function createApp({ council, store, config }: AppDependencies) {
  const app = express();
  const publicDir = path.resolve(process.cwd(), "public");

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(publicDir));

  app.get("/api/config", (_request, response) => {
    response.json({
      providerMode: config.providerMode,
      includeVoxis: config.includeVoxis,
      agents: Object.values(agentProfiles)
    });
  });

  app.get("/api/runs", (_request, response) => {
    response.json({
      runs: store.listRuns()
    });
  });

  app.get("/api/runs/:runId", (request, response) => {
    const run = store.getRun(request.params.runId);

    if (!run) {
      response.status(404).json({ message: "Run not found" });
      return;
    }

    response.json(run);
  });

  app.post("/api/runs", async (request, response) => {
    try {
      const run = await council.startRun(request.body);
      response.status(202).json(run);
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "Invalid run request"
      });
    }
  });

  app.get("*", (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });

  return app;
}