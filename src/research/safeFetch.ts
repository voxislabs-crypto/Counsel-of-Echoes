import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 800_000;
const MAX_REDIRECTS = 3;

const REQUEST_HEADERS = {
  "User-Agent": "CounselOfEchoes/0.1 (research; local)",
  Accept: "application/json, text/html, text/plain;q=0.9",
  "Accept-Encoding": "identity"
};

export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchResult = {
  finalUrl: string;
  contentType: string;
  text: string;
};

export async function safeFetch(rawUrl: string, parentSignal?: AbortSignal): Promise<SafeFetchResult> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await assertPublicHttpUrl(current);
    const response = await requestOnce(target, parentSignal);

    if (response.status >= 300 && response.status < 400) {
      const location = response.location;
      if (!location || hop === MAX_REDIRECTS) {
        throw new SafeFetchError("Redirect cap exceeded");
      }
      current = new URL(location, target.url).toString();
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError(`Fetch failed with ${response.status}`);
    }

    const text = response.contentType.includes("html") ? htmlToText(response.body) : response.body;
    return {
      finalUrl: target.url.toString(),
      contentType: response.contentType,
      text
    };
  }

  throw new SafeFetchError("Redirect cap exceeded");
}

export function htmlToText(value: string): string {
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

export function clampExcerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 800) {
    return compact;
  }

  const window = compact.slice(0, 800);
  const boundary = window.lastIndexOf(" ");
  const clipped = boundary >= 500 ? window.slice(0, boundary) : window;
  return clipped.trim();
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isBlockedAddress(mapped[1]);
  }

  if (normalized.includes(".")) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }

    const [first, second] = parts;
    if (first === 10 || first === 127) {
      return true;
    }
    if (first === 192 && second === 168) {
      return true;
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
    if (first === 169 && second === 254) {
      return true;
    }
    return false;
  }

  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  if (/^fe[89ab]/i.test(normalized)) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  return false;
}

type VettedUrl = {
  url: URL;
  address: string;
};

async function assertPublicHttpUrl(rawUrl: string): Promise<VettedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("URL is not valid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("Only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("URLs with credentials are not allowed");
  }

  const addresses = await resolveAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => isBlockedAddress(address))) {
    throw new SafeFetchError("Resolved address is not public");
  }

  return {
    url,
    address: addresses[0]
  };
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  const literal = isIP(hostname);
  if (literal) {
    return [hostname];
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    throw new SafeFetchError("DNS resolution failed");
  }
}

type FetchResponse = {
  status: number;
  location?: string;
  contentType: string;
  body: string;
};

function requestOnce(target: VettedUrl, parentSignal?: AbortSignal): Promise<FetchResponse> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const lib = target.url.protocol === "https:" ? https : http;
  const family = isIP(target.address) as 4 | 6;

  return new Promise((resolve, reject) => {
    const request = lib.request({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      headers: REQUEST_HEADERS,
      servername: target.url.hostname,
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address, family);
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const fail = (error: Error) => {
        response.destroy();
        reject(error);
      };

      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          fail(new SafeFetchError("Response exceeded the size cap"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location,
          contentType: String(response.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
      response.on("error", fail);
    });

    const abort = () => {
      request.destroy(new SafeFetchError("Fetch timed out"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.end();
  });
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}
