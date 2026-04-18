import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { RunStore } from "../store/runStore.js";

type ClientState = {
  socket: WebSocket;
  subscribedRunId?: string;
};

export function attachCouncilWebSocket(server: Server, store: RunStore) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();

  server.on("upgrade", (request, socket, head) => {
    if (!request.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      const state: ClientState = { socket: websocket };
      clients.add(state);

      websocket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as { type?: string; runId?: string };

          if (message.type === "subscribe" && message.runId) {
            state.subscribedRunId = message.runId;
            const run = store.getRun(message.runId);

            if (run) {
              for (const event of run.events) {
                websocket.send(JSON.stringify(event));
              }
            }
          }
        } catch {
          websocket.send(JSON.stringify({ type: "error", message: "Invalid websocket message" }));
        }
      });

      websocket.on("close", () => {
        clients.delete(state);
      });
    });
  });

  store.subscribe((event) => {
    for (const client of clients) {
      if (client.subscribedRunId === event.runId && client.socket.readyState === client.socket.OPEN) {
        client.socket.send(JSON.stringify(event));
      }
    }
  });
}