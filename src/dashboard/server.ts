// The dashboard's HTTP server (docs/dashboard-spec.md, 2.3). It knows nothing about the Mission Control home: it is
// given the page and a function that builds a snapshot. It serves GET and HEAD from a fixed list of routes and
// nothing from the disk, so there is no path to traverse and no folder to list. Everything else is answered 405.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { SNAPSHOT_CACHE_MS } from "./constants.js";
import { SCHEMA_VERSION, type Snapshot } from "./types.js";

export interface DashboardServerOptions {
  host: string;
  port: number;
  /** The contents of dashboard/index.html. */
  pageHtml: string;
  /** Builds a snapshot; the server never reads the Mission Control home itself. */
  build: () => Snapshot;
  /** A snapshot is built at most once in this time. Default SNAPSHOT_CACHE_MS. */
  cacheMs?: number;
  /** Extra values for /healthz (the server adds `ok` and `schemaVersion`). */
  healthz?: () => Record<string, unknown>;
  /** Where a failed snapshot build is reported (at most once a minute). Default: stderr. */
  logError?: (message: string) => void;
}

export interface RunningDashboard {
  /** Where to open it, as shown to a person: "localhost" for a loopback or wildcard address. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** A failure is written to the log at most this often, so a broken home does not fill it. */
const ERROR_LOG_EVERY_MS = 60_000;
const WILDCARD_OR_LOOPBACK = new Set(["", "0.0.0.0", "::", "127.0.0.1", "::1", "localhost"]);

const SNAPSHOT_FAILED = JSON.stringify({ error: "The snapshot could not be built." });
const NOT_FOUND = "Not found.";
const ONLY_READS = "This page only reads.";
const BAD_REQUEST = "Bad request.";

/** The text of every `<script>` and `<style>` element, in page order. */
function inlineTexts(pageHtml: string, tag: "script" | "style"): string[] {
  const element = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi");
  return [...pageHtml.matchAll(element)].map((match) => match[1] ?? "");
}

/** `'sha256-...'` of a text as the browser hashes it: the HTML parser turns CRLF and lone CR into LF first. */
function sourceHash(text: string): string {
  const normalised = text.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(normalised, "utf8").digest("base64")}'`;
}

function hashList(texts: string[]): string {
  return texts.length === 0 ? "'none'" : [...new Set(texts.map(sourceHash))].join(" ");
}

/**
 * The Content-Security-Policy for a page: the hash of each inline script and style, so no 'unsafe-inline' is needed,
 * and nothing may be loaded from anywhere else. The page may only ask its own server (connect-src 'self').
 */
export function contentSecurityPolicy(pageHtml: string): string {
  return [
    "default-src 'none'",
    `script-src ${hashList(inlineTexts(pageHtml, "script"))}`,
    `style-src ${hashList(inlineTexts(pageHtml, "style"))}`,
    "connect-src 'self'",
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Wraps a log function so it writes at most once a minute (the same message is not repeated). */
export function atMostOncePerMinute(write: (message: string) => void, now: () => number = Date.now): (message: string) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (message) => {
    const at = now();
    if (at - last < ERROR_LOG_EVERY_MS) return;
    last = at;
    write(message);
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shownAddress(host: string, port: number): string {
  if (WILDCARD_OR_LOOPBACK.has(host)) return `http://localhost:${port}`;
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

export function startDashboardServer(o: DashboardServerOptions): Promise<RunningDashboard> {
  const cacheMs = o.cacheMs ?? SNAPSHOT_CACHE_MS;
  const page = Buffer.from(o.pageHtml, "utf8");
  const policy = contentSecurityPolicy(o.pageHtml);
  const logFailure = atMostOncePerMinute(o.logError ?? ((message) => void process.stderr.write(`${message}\n`)));

  // `build` is synchronous, so requests that arrive while it runs cannot interleave: one build per cache window is
  // enough to make concurrent requests share it.
  let cached: { at: number; body: Buffer } | undefined;
  function snapshotBody(): Buffer | undefined {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < cacheMs) return cached.body;
    try {
      cached = { at: now, body: Buffer.from(JSON.stringify(o.build()), "utf8") };
      return cached.body;
    } catch (err) {
      cached = undefined;
      logFailure(`mc dashboard: the snapshot could not be built: ${errorText(err)}`);
      return undefined;
    }
  }

  function healthBody(): Buffer {
    let extra: Record<string, unknown> = {};
    try {
      extra = o.healthz?.() ?? {};
    } catch {
      // /healthz only says the server is up; a failing detail must not turn that into an error
    }
    return Buffer.from(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, ...extra }), "utf8");
  }

  function send(res: ServerResponse, head: boolean, status: number, type: string | undefined, body: Buffer, more: Record<string, string> = {}): void {
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": policy,
      ...(type !== undefined && { "Content-Type": type, "Content-Length": String(body.length) }),
      ...more,
    });
    res.end(head || status === 204 ? undefined : body);
  }

  const text = (res: ServerResponse, head: boolean, status: number, message: string, more?: Record<string, string>) =>
    send(res, head, status, "text/plain; charset=utf-8", Buffer.from(message, "utf8"), more);

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? "";
    if (method !== "GET" && method !== "HEAD") {
      // The body is never read; closing the connection stops a client from sending the rest of it.
      text(res, false, 405, ONLY_READS, { Allow: "GET, HEAD", Connection: "close" });
      return;
    }
    const head = method === "HEAD";
    const url = req.url ?? "";
    // The route is the raw path before any "?": nothing is normalised, so "//x", "/./" and "/%2e%2e/x" are just unknown.
    if (!url.startsWith("/")) {
      text(res, head, 400, BAD_REQUEST);
      return;
    }
    const path = url.split("?", 1)[0];
    switch (path) {
      case "/":
        send(res, head, 200, "text/html; charset=utf-8", page);
        return;
      case "/api/snapshot": {
        const body = snapshotBody();
        if (body === undefined) send(res, head, 500, "application/json; charset=utf-8", Buffer.from(SNAPSHOT_FAILED, "utf8"));
        else send(res, head, 200, "application/json; charset=utf-8", body);
        return;
      }
      case "/healthz":
        send(res, head, 200, "application/json; charset=utf-8", healthBody());
        return;
      case "/favicon.ico":
        send(res, head, 204, undefined, Buffer.alloc(0));
        return;
      default:
        text(res, head, 404, NOT_FOUND);
    }
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // Nothing above should throw; if it does the request still gets an answer and the server keeps running.
      logFailure(`mc dashboard: a request failed: ${errorText(err)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end();
    }
  });
  // Requests Node refuses before they reach `handle` (a bad request line, a CONNECT) still get a plain answer with
  // the same headers, written by hand because there is no response object.
  function refuse(socket: Duplex, status: string, message: string, more = ""): void {
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const body = Buffer.from(message, "utf8");
    socket.end(
      `HTTP/1.1 ${status}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n` +
        `Content-Security-Policy: ${policy}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n${more}Connection: close\r\n\r\n${message}`,
    );
  }
  server.on("clientError", (_err, socket) => refuse(socket, "400 Bad Request", BAD_REQUEST));
  server.on("connect", (_req, socket) => refuse(socket, "405 Method Not Allowed", ONLY_READS, "Allow: GET, HEAD\r\n"));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : o.port;
      let closing: Promise<void> | undefined;
      resolve({
        url: shownAddress(o.host, port),
        port,
        close: () => {
          closing ??= new Promise<void>((done) => {
            server.close(() => done());
            // Keep-alive connections of browsers would hold the port for seconds.
            server.closeAllConnections();
          });
          return closing;
        },
      });
    });
  });
}
