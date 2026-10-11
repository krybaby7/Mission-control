// Tests for the dashboard's HTTP server (docs/dashboard-spec.md, 2.3 and 15: T-SRV, T-RO-3 and T-RO-5 server parts,
// T-EDGE-36). Most tests give the server a stub build function, because it knows nothing about the home; the
// read-only proofs serve a real copy of a fixture home through the real snapshot builder.
import { createHash } from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSnapshotShape, copyHome, hashTree, touch, withLock, withStop } from "../../test/dashboard-helpers.js";
import { SNAPSHOT_CACHE_MS } from "./constants.js";
import { atMostOncePerMinute, contentSecurityPolicy, type DashboardServerOptions, type RunningDashboard, startDashboardServer } from "./server.js";
import { buildSnapshot } from "./snapshot.js";
import type { Snapshot } from "./types.js";

// The runtime guard of T-RO-3: every function of node:fs that can change a file throws while `guard.on` is set.
const guard = vi.hoisted(() => ({ on: false, calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const everything = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  const blocked = [
    "writeFileSync", "appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync", "renameSync", "linkSync",
    "symlinkSync", "unlinkSync", "utimesSync", "futimesSync", "lutimesSync", "copyFileSync", "cpSync", "truncateSync",
    "ftruncateSync", "chmodSync", "fchmodSync", "chownSync", "fchownSync", "writeSync", "writevSync", "fsyncSync", "createWriteStream",
  ];
  const patched: Record<string, unknown> = { ...actual };
  for (const name of blocked) {
    patched[name] = (...args: unknown[]) => {
      if (guard.on) {
        guard.calls.push(name);
        throw new Error(`${name} is not allowed while the dashboard serves requests`);
      }
      return everything[name]?.(...args);
    };
  }
  patched.openSync = (path: unknown, flags?: unknown, ...rest: unknown[]) => {
    if (guard.on && flags !== undefined && flags !== "r" && flags !== actual.constants.O_RDONLY) {
      guard.calls.push(`openSync(${String(flags)})`);
      throw new Error("openSync with a write flag is not allowed while the dashboard serves requests");
    }
    return everything.openSync?.(path, flags, ...rest);
  };
  return { ...patched, default: patched };
});

const SCRIPT = 'document.title = "Mission Control";';
const DATA = '{"demo":true}';
const STYLE = "body { margin: 0; }";
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mission Control</title><style>${STYLE}</style></head><body><p>Tonight</p><script>${SCRIPT}</script><script type="application/json" id="d">${DATA}</script></body></html>`;

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request with the path exactly as given (fetch would tidy "/../x" and "//x" before sending them). */
function raw(port: number, method: string, path: string, o: { body?: string | Buffer; agent?: http.Agent } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent: o.agent ?? false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    // Node sends no length for the body of a DELETE or OPTIONS unless asked, and the server would take it for a request.
    if (o.body !== undefined) req.setHeader("Content-Length", Buffer.byteLength(o.body));
    req.end(o.body);
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const started: RunningDashboard[] = [];

async function serve(o: Partial<DashboardServerOptions> = {}): Promise<RunningDashboard> {
  const running = await startDashboardServer({
    host: "127.0.0.1",
    port: 0,
    pageHtml: PAGE,
    build: () => ({ schemaVersion: 1 }) as unknown as Snapshot,
    ...o,
  });
  started.push(running);
  return running;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((running) => running.close()));
  guard.on = false;
  guard.calls.length = 0;
});

describe("T-SRV: the page and the routes", () => {
  it("serves the page file as it is, on / and on / with a query", async () => {
    const { port } = await serve();
    for (const path of ["/", "/?x=1", "/?"]) {
      const r = await raw(port, "GET", path);
      expect(r.status, path).toBe(200);
      expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(r.body).toBe(PAGE);
    }
  });

  it("serves the snapshot as JSON on /api/snapshot, ignoring the query", async () => {
    const { port } = await serve({ build: () => ({ schemaVersion: 1, marker: "ä" }) as unknown as Snapshot });
    for (const path of ["/api/snapshot", "/api/snapshot?t=123"]) {
      const r = await raw(port, "GET", path);
      expect(r.status).toBe(200);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(r.headers["content-length"]).toBe(String(Buffer.byteLength(r.body)));
      expect(JSON.parse(r.body)).toEqual({ schemaVersion: 1, marker: "ä" });
    }
  });

  it("answers /healthz with the server's own facts and the caller's, without building a snapshot", async () => {
    const build = vi.fn(() => ({}) as Snapshot);
    const { port } = await serve({ build, healthz: () => ({ settings: "saved", home: "readable" }) });
    const r = await raw(port, "GET", "/healthz");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(r.body)).toEqual({ ok: true, schemaVersion: 1, settings: "saved", home: "readable" });
    expect(build).not.toHaveBeenCalled();
  });

  it("answers /healthz even with no extra facts, or when getting them fails", async () => {
    const plain = await serve();
    expect(JSON.parse((await raw(plain.port, "GET", "/healthz")).body)).toEqual({ ok: true, schemaVersion: 1 });
    const failing = await serve({
      healthz: () => {
        throw new Error("nope");
      },
    });
    const r = await raw(failing.port, "GET", "/healthz");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, schemaVersion: 1 });
  });

  it("answers /favicon.ico with 204 and no body", async () => {
    const { port } = await serve();
    const r = await raw(port, "GET", "/favicon.ico");
    expect(r.status).toBe(204);
    expect(r.body).toBe("");
  });

  it.each([
    "/nope", "/index.html", "/dashboard/index.html", "/api", "/api/", "/api/snapshot/", "/api/snapshot.json", "/healthz/",
    "/healthz.json", "/mc.lock", "/missions/", "/quota.json", "/src/dashboard/server.ts", "/package.json",
  ])("says 404 to %s", async (path) => {
    const { port } = await serve();
    const r = await raw(port, "GET", path);
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.body).toBe("Not found.");
  });

  it.each([
    "/../etc/passwd", "/%2e%2e/x", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc/passwd", "//x", "///", "//etc/passwd",
    "/./", "/.", "/%2f", "/%00", "/api/../healthz", "/\\..\\x", `/${"a".repeat(5_000)}`,
  ])("says 404 to the traversal attempt or odd path %s", async (path) => {
    const build = vi.fn(() => ({}) as Snapshot);
    const { port } = await serve({ build });
    const r = await raw(port, "GET", path);
    expect(r.status).toBe(404);
    expect(r.body).toBe("Not found.");
    expect(build).not.toHaveBeenCalled();
  });

  it("says 400 to a request line that is not a path", async () => {
    const { port } = await serve();
    for (const path of ["http://example.com/", "*", "x"]) {
      const r = await raw(port, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.body).toBe("Bad request.");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("says 400 to a request that is not HTTP at all, and keeps serving", async () => {
    const { port } = await serve();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("this is not http\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString("utf8")));
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    expect(answer).toContain("Content-Security-Policy:");
    expect(answer.endsWith("Bad request.")).toBe(true);
    expect((await raw(port, "GET", "/healthz")).status).toBe(200);
  });
});

describe("T-SRV: only GET and HEAD", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "PROPFIND"])("answers %s with 405, Allow and a plain sentence", async (method) => {
    const build = vi.fn(() => ({}) as Snapshot);
    const { port } = await serve({ build });
    for (const path of ["/", "/api/snapshot", "/healthz", "/nope"]) {
      const r = await raw(port, method, path, { body: "x=1" });
      expect(r.status, `${method} ${path}`).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
      expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(r.body).toBe("This page only reads.");
    }
    expect(build).not.toHaveBeenCalled();
  });

  it("answers CONNECT with 405 too, though Node hands it over as a separate event", async () => {
    const { port } = await serve();
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString("utf8")));
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 405 /);
    expect(answer).toContain("Allow: GET, HEAD");
    expect(answer).toContain("This page only reads.");
    expect(answer).toContain("Cache-Control: no-store");
  });

  it("does not read the body of a refused request, and closes the connection instead", async () => {
    const { port } = await serve();
    const r = await raw(port, "POST", "/api/snapshot", { body: Buffer.alloc(4 * 1024 * 1024, 0x61) });
    expect(r.status).toBe(405);
    expect(r.headers.connection).toBe("close");
  });

  it.each(["/", "/api/snapshot", "/healthz", "/favicon.ico", "/nope"])("HEAD %s has the headers of GET and no body", async (path) => {
    const { port } = await serve();
    const get = await raw(port, "GET", path);
    const head = await raw(port, "HEAD", path);
    expect(head.status).toBe(get.status);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.headers["content-security-policy"]).toBe(get.headers["content-security-policy"]);
  });
});

describe("T-SRV: headers and the Content-Security-Policy", () => {
  it("sends the same four headers on every kind of answer", async () => {
    const failing = await serve({
      build: () => {
        throw new Error("boom");
      },
      logError: () => {},
    });
    const csp = contentSecurityPolicy(PAGE);
    const answers: [string, Answer][] = [];
    for (const [method, path] of [["GET", "/"], ["GET", "/api/snapshot"], ["GET", "/healthz"], ["GET", "/favicon.ico"], ["GET", "/nope"], ["GET", "x"], ["POST", "/"], ["HEAD", "/"]] as const) {
      answers.push([`${method} ${path}`, await raw(failing.port, method, path)]);
    }
    expect(answers.map(([, a]) => a.status)).toEqual([200, 500, 200, 204, 404, 400, 405, 200]);
    for (const [name, a] of answers) {
      expect(a.headers["cache-control"], name).toBe("no-store");
      expect(a.headers["x-content-type-options"], name).toBe("nosniff");
      expect(a.headers["referrer-policy"], name).toBe("no-referrer");
      expect(a.headers["content-security-policy"], name).toBe(csp);
    }
  });

  it("lists the hash of every inline script and style and allows nothing inline", () => {
    const csp = contentSecurityPolicy(PAGE);
    expect(csp).toBe(
      [
        "default-src 'none'",
        `script-src ${sha(SCRIPT)} ${sha(DATA)}`,
        `style-src ${sha(STYLE)}`,
        "connect-src 'self'",
        "img-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("hashes the text the browser sees: CRLF line breaks become LF", () => {
    const lf = "<script>\nlet a = 1;\nlet b = 2;\n</script>";
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(contentSecurityPolicy(crlf)).toBe(contentSecurityPolicy(lf));
    expect(contentSecurityPolicy(lf)).toContain(sha("\nlet a = 1;\nlet b = 2;\n"));
  });

  it("finds elements with attributes and upper-case tags, and lists a repeated text once", () => {
    const page = '<STYLE media="all">a{}</STYLE><style>a{}</style><script defer>1</script><SCRIPT>1</SCRIPT>';
    const csp = contentSecurityPolicy(page);
    expect(csp).toContain(`style-src ${sha("a{}")};`);
    expect(csp).toContain(`script-src ${sha("1")};`);
  });

  it("sends 'none' for a page with no inline script or style", () => {
    const csp = contentSecurityPolicy("<!doctype html><title>x</title><p>no code</p>");
    expect(csp).toContain("script-src 'none';");
    expect(csp).toContain("style-src 'none';");
    expect(csp.startsWith("default-src 'none'; ")).toBe(true);
  });
});

describe("T-SRV: one build serves many requests", () => {
  it("five concurrent requests share one build inside the cache time", async () => {
    let builds = 0;
    const { port } = await serve({
      cacheMs: 60_000,
      build: () => ({ schemaVersion: 1, n: ++builds }) as unknown as Snapshot,
    });
    const answers = await Promise.all(Array.from({ length: 5 }, () => raw(port, "GET", "/api/snapshot")));
    expect(builds).toBe(1);
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
    await raw(port, "GET", "/api/snapshot");
    expect(builds).toBe(1);
  });

  it("builds again once the cache time has passed", async () => {
    let builds = 0;
    const { port } = await serve({ cacheMs: 60, build: () => ({ schemaVersion: 1, n: ++builds }) as unknown as Snapshot });
    expect(JSON.parse((await raw(port, "GET", "/api/snapshot")).body).n).toBe(1);
    await sleep(120);
    expect(JSON.parse((await raw(port, "GET", "/api/snapshot")).body).n).toBe(2);
  });

  it("builds on every request when the cache time is 0", async () => {
    let builds = 0;
    const { port } = await serve({ cacheMs: 0, build: () => ({ schemaVersion: 1, n: ++builds }) as unknown as Snapshot });
    await raw(port, "GET", "/api/snapshot");
    await raw(port, "GET", "/api/snapshot");
    expect(builds).toBe(2);
  });

  it("caches for SNAPSHOT_CACHE_MS unless told otherwise", async () => {
    let builds = 0;
    const { port } = await serve({ build: () => ({ n: ++builds }) as unknown as Snapshot });
    await raw(port, "GET", "/api/snapshot");
    await raw(port, "HEAD", "/api/snapshot");
    expect(builds).toBe(1);
    expect(SNAPSHOT_CACHE_MS).toBe(1_500);
  });

  it("answers 500 with a JSON error when the build throws, logs it once, and recovers", async () => {
    let broken = true;
    const logged: string[] = [];
    const { port } = await serve({
      cacheMs: 0,
      logError: (message) => logged.push(message),
      build: () => {
        if (broken) throw new Error("disk on fire");
        return { schemaVersion: 1 } as unknown as Snapshot;
      },
    });
    for (let i = 0; i < 3; i++) {
      const r = await raw(port, "GET", "/api/snapshot");
      expect(r.status).toBe(500);
      expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(JSON.parse(r.body)).toEqual({ error: "The snapshot could not be built." });
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("disk on fire");
    // The page and the health check do not depend on the build.
    expect((await raw(port, "GET", "/")).status).toBe(200);
    expect((await raw(port, "GET", "/healthz")).status).toBe(200);
    broken = false;
    expect((await raw(port, "GET", "/api/snapshot")).status).toBe(200);
  });

  it("atMostOncePerMinute writes the first message, drops the rest for a minute, then writes again", () => {
    let now = 5_000_000;
    const written: string[] = [];
    const log = atMostOncePerMinute((m) => written.push(m), () => now);
    log("a");
    now += 59_999;
    log("b");
    now += 1;
    log("c");
    expect(written).toEqual(["a", "c"]);
  });
});

describe("T-SRV: starting and stopping", () => {
  it("port 0 picks a free port, and the address says localhost for a loopback or wildcard host", async () => {
    const loopback = await serve();
    expect(loopback.port).toBeGreaterThan(0);
    expect(loopback.url).toBe(`http://localhost:${loopback.port}`);
    const wildcard = await serve({ host: "0.0.0.0" });
    expect(wildcard.url).toBe(`http://localhost:${wildcard.port}`);
    expect((await raw(wildcard.port, "GET", "/healthz")).status).toBe(200);
  });

  it("close() frees the port", async () => {
    const first = await serve();
    await first.close();
    const again = await startDashboardServer({ host: "127.0.0.1", port: first.port, pageHtml: PAGE, build: () => ({}) as Snapshot });
    started.push(again);
    expect(again.port).toBe(first.port);
    expect((await raw(again.port, "GET", "/healthz")).status).toBe(200);
  });

  it("close() ends open keep-alive connections and may be called twice", async () => {
    const running = await serve();
    const agent = new http.Agent({ keepAlive: true });
    expect((await raw(running.port, "GET", "/", { agent })).status).toBe(200);
    const closed = await Promise.race([running.close().then(() => "closed"), sleep(3_000).then(() => "stuck")]);
    expect(closed).toBe("closed");
    await running.close();
    agent.destroy();
    await expect(raw(running.port, "GET", "/")).rejects.toThrow();
  });

  it("fails with EADDRINUSE when the port is taken", async () => {
    const first = await serve();
    await expect(startDashboardServer({ host: "127.0.0.1", port: first.port, pageHtml: PAGE, build: () => ({}) as Snapshot })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("T-RO-5 and T-RO-3: serving a home changes nothing in it", () => {
  const NOW = Date.parse("2026-10-11T13:03:30.000Z");

  /** Every kind of request, several times, against a server over `home`; each answer is checked. */
  async function requestCycle(home: string): Promise<void> {
    const { port } = await serve({
      cacheMs: 0,
      build: () => buildSnapshot({ home, now: NOW, timeZone: "UTC", until: "07:00", onError: (err) => { throw err; } }),
      healthz: () => ({ settings: "saved", home: "readable" }),
    });
    const missionId = "habit-tracker";
    for (let round = 0; round < 6; round++) {
      expect((await raw(port, "GET", "/")).status).toBe(200);
      const snapshot = await raw(port, "GET", "/api/snapshot");
      expect(snapshot.status).toBe(200);
      assertSnapshotShape(JSON.parse(snapshot.body));
      expect((await raw(port, "GET", "/healthz")).status).toBe(200);
      expect((await raw(port, "HEAD", "/")).status).toBe(200);
      expect((await raw(port, "HEAD", "/api/snapshot")).status).toBe(200);
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        expect((await raw(port, method, "/api/snapshot", { body: '{"stop":true}' })).status).toBe(405);
        expect((await raw(port, method, "/STOP")).status).toBe(405);
      }
      // Nothing under the home is reachable by name, whatever the path looks like.
      for (const path of [
        "/mc.lock", "/STOP", "/quota.json", "/usage.jsonl", "/missions/", `/missions/${missionId}/mission.json`,
        `/missions/${missionId}/events.jsonl`, "/../mc.lock", "/%2e%2e/mc.lock", "/missions/../mc.lock", "/config.yaml",
      ]) {
        const r = await raw(port, "GET", path);
        expect(r.status, path).toBe(404);
        expect(r.body).toBe("Not found.");
      }
    }
  }

  function homeWithRun(): string {
    const home = copyHome("multi-mission");
    withLock(home, { at: "2026-10-11T09:50:00.000Z", ageMs: 15_000, now: NOW });
    withStop(home);
    touch(join(home, "quota.json"), NOW - 60_000);
    return home;
  }

  it("T-RO-5: the home is byte-identical after many requests of every kind", async () => {
    const home = homeWithRun();
    const before = hashTree(home);
    await requestCycle(home);
    expect(hashTree(home)).toBe(before);
  });

  it("T-RO-3: a full request cycle completes while every write is blocked", async () => {
    const home = homeWithRun();
    guard.calls.length = 0;
    guard.on = true;
    try {
      await requestCycle(home);
    } finally {
      guard.on = false;
    }
    expect(guard.calls).toEqual([]);
  });

  it("T-RO-3: the guard really blocks a write (so the proof proves something)", () => {
    const home = copyHome("done");
    guard.on = true;
    try {
      expect(() => touch(join(home, "mc.lock"), 0)).toThrow(/not allowed/);
    } finally {
      guard.on = false;
    }
    expect(guard.calls).toEqual(["utimesSync"]);
    guard.calls.length = 0;
  });
});
