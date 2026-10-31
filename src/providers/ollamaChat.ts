import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// stream:false does not send headers until generation ends. Node's fetch
// aborts that wait at 300s, which is what turned the queued Qwen call into
// "fetch failed" after 5m10s. One CPU proposal on this machine can run
// past that, so the idle timeout sits well above it.
export const OLLAMA_CHAT_TIMEOUT_MS = 600_000;

export type OllamaResponse = {
  status: number;
  body: string;
};

export type OllamaPost = (url: string, payload: unknown, timeoutMs: number) => Promise<OllamaResponse>;

export async function requestOllamaChat(
  endpoint: string,
  payload: unknown,
  post: OllamaPost = postOllamaJson
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await post(endpoint, payload, OLLAMA_CHAT_TIMEOUT_MS);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`ollama request failed with ${response.status}`);
      }

      const body = JSON.parse(response.body) as { message?: { content?: string } };
      const content = body.message?.content;
      if (!content) throw new Error("ollama returned an empty response");
      return content;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && isTransientOllamaFetchError(error)) continue;
      throw describeOllamaFetchError(error);
    }
  }

  throw describeOllamaFetchError(lastError);
}

export function isTransientOllamaFetchError(error: unknown): boolean {
  const text = errorText(error);
  return text.includes("fetch failed")
    || text.includes("fetch timed out")
    || text.includes("timeout")
    || text.includes("econnreset")
    || text.includes("econnrefused")
    || text.includes("socket hang up")
    || text.includes("network");
}

export function describeOllamaFetchError(error: unknown): Error {
  if (error instanceof Error && (error.message.startsWith("fetch timed out") || error.message.startsWith("ollama request failed") || error.message === "ollama returned an empty response")) {
    return error;
  }

  const text = errorText(error);
  if (text.includes("timeout") || text.includes("aborted")) {
    return new Error(`fetch timed out after ${OLLAMA_CHAT_TIMEOUT_MS / 1000}s`);
  }
  if (text.includes("fetch failed") || text.includes("econnreset") || text.includes("econnrefused") || text.includes("socket") || text.includes("network")) {
    return new Error("fetch failed");
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export function postOllamaJson(url: string, payload: unknown, timeoutMs: number): Promise<OllamaResponse> {
  const target = new URL(url);
  const body = JSON.stringify(payload);
  const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    },
    timeout: timeoutMs
  });

  return new Promise((resolve, reject) => {
    request.on("timeout", () => {
      request.destroy(new Error(`fetch timed out after ${timeoutMs / 1000}s`));
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    request.write(body);
    request.end();
  });
}

function errorText(error: unknown): string {
  const parts = [error];
  if (error && typeof error === "object" && "cause" in error) parts.push(error.cause);
  return parts.map((part) => {
    if (part instanceof Error) return `${part.name} ${part.message}`;
    if (part && typeof part === "object") return JSON.stringify(part);
    return String(part ?? "");
  }).join(" ").toLowerCase();
}
