import { afterEach, describe, expect, it, vi } from "vitest";
import { createNotifier, MAX_MESSAGE_BYTES, NTFY_TIMEOUT_MS } from "./notify.js";
import type { Logger } from "./types.js";

const URL_ = "https://ntfy.example.com/mc-secret-topic-123";

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double that records calls and answers with `reply` (or runs it, to throw or hang). */
function fakeFetch(reply: (call: Call) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function recordingLogger() {
  const warnings: { msg: string; data?: Record<string, unknown> }[] = [];
  const infos: string[] = [];
  const logger: Logger = {
    info: (msg) => infos.push(msg),
    warn: (msg, data) => warnings.push({ msg, data }),
    error: () => {},
  };
  return { logger, warnings, infos };
}

function headersOf(call: Call | undefined): Record<string, string> {
  return { ...(call?.init.headers as Record<string, string>) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createNotifier", () => {
  it("POSTs the message to the ntfy URL with Title, Priority and Tags headers", async () => {
    const { impl, calls } = fakeFetch();
    const { logger, warnings, infos } = recordingLogger();
    await createNotifier(URL_, logger, impl).notify("Habit tracker: done (5/6 features)", "Report: /home/me/report.md", {
      tags: ["white_check_mark", " moon "],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("Report: /home/me/report.md");
    expect(headersOf(calls[0])).toEqual({
      Title: "Habit tracker: done (5/6 features)",
      Priority: "3",
      Tags: "white_check_mark,moon",
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(warnings).toEqual([]);
    expect(infos).toEqual(["notification sent: Habit tracker: done (5/6 features)"]);
  });

  it("uses priority 4 for high and omits Tags when there are none", async () => {
    const { impl, calls } = fakeFetch();
    await createNotifier(URL_, undefined, impl).notify("Blocked", "Needs a login", { priority: "high", tags: [] });
    expect(headersOf(calls[0])).toEqual({ Title: "Blocked", Priority: "4" });
  });

  it("is a no-op when the URL is empty, blank or unset", async () => {
    const { impl } = fakeFetch();
    for (const url of ["", "   ", undefined]) {
      await createNotifier(url, undefined, impl).notify("t", "m");
    }
    expect(impl).not.toHaveBeenCalled();
  });

  it("trims the configured URL", async () => {
    const { impl, calls } = fakeFetch();
    await createNotifier(`  ${URL_}\n`, undefined, impl).notify("t", "m");
    expect(calls[0]!.url).toBe(URL_);
  });

  it("encodes non-ASCII header values (RFC 2047) and flattens newlines", async () => {
    const { impl, calls } = fakeFetch();
    await createNotifier(URL_, undefined, impl).notify("Café ☕ — done", "m", { tags: ["tada"] });
    await createNotifier(URL_, undefined, impl).notify("line one\r\nline two", "m");

    const title = headersOf(calls[0]).Title!;
    expect(title).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const encoded = /^=\?UTF-8\?B\?(.*)\?=$/.exec(title)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("Café ☕ — done");
    expect(headersOf(calls[0]).Tags).toBe("tada");
    expect(headersOf(calls[1]).Title).toBe("line one line two");
    // every header value must be something fetch accepts
    for (const call of calls) expect(() => new Headers(headersOf(call))).not.toThrow();
  });

  it("omits an empty title so ntfy falls back to the topic name", async () => {
    const { impl, calls } = fakeFetch();
    await createNotifier(URL_, undefined, impl).notify(" \n ", "m");
    expect(headersOf(calls[0])).toEqual({ Priority: "3" });
  });

  it("cuts very long messages below ntfy's attachment size without splitting characters", async () => {
    const { impl, calls } = fakeFetch();
    const long = "é".repeat(MAX_MESSAGE_BYTES); // 2 bytes each
    await createNotifier(URL_, undefined, impl).notify("t", long);
    const body = calls[0]!.init.body as string;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(body.endsWith("…")).toBe(true);
    expect(body).not.toContain("�");
    expect(body.slice(0, -1)).toMatch(/^é+$/);
  });

  it("never throws on a network error; logs a warning without the secret topic", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND ntfy.example.com") });
    });
    const { logger, warnings, infos } = recordingLogger();
    await expect(createNotifier(URL_, logger, impl).notify("Run finished", "m")).resolves.toBeUndefined();

    expect(infos).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe(
      'could not send notification "Run finished": fetch failed (getaddrinfo ENOTFOUND ntfy.example.com)',
    );
    expect(warnings[0]!.data).toEqual({ host: "ntfy.example.com" });
    expect(JSON.stringify(warnings)).not.toContain("mc-secret-topic-123");
  });

  it("warns on a non-2xx reply, including the start of the reply body", async () => {
    const { impl } = fakeFetch(() => new Response(`{"error":"too many requests"}${"x".repeat(500)}`, { status: 429 }));
    const { logger, warnings } = recordingLogger();
    await createNotifier(URL_, logger, impl).notify("t", "m");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toContain('ntfy replied HTTP 429: {"error":"too many requests"}');
    expect(warnings[0]!.msg.length).toBeLessThan(300);
  });

  it("warns on an invalid URL instead of throwing", async () => {
    const { logger, warnings } = recordingLogger();
    await createNotifier("not a url", logger, globalThis.fetch).notify("t", "m");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.data).toEqual({ host: "(invalid URL)" });
  });

  it("gives up after 10 s and aborts the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { impl } = fakeFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          signal = call.init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason));
        }),
    );
    const { logger, warnings } = recordingLogger();
    let settled = false;
    const done = createNotifier(URL_, logger, impl)
      .notify("t", "m")
      .then(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(NTFY_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(NTFY_TIMEOUT_MS).toBe(10_000);
    expect(signal?.aborted).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.msg).toBe('could not send notification "t": timed out after 10 s');
  });

  it("still resolves when the fetch implementation ignores the abort signal", async () => {
    vi.useFakeTimers();
    const { impl } = fakeFetch(() => new Promise<Response>(() => {})); // hangs forever
    const { logger, warnings } = recordingLogger();
    const done = createNotifier(URL_, logger, impl).notify("t", "m");
    await vi.advanceTimersByTimeAsync(NTFY_TIMEOUT_MS);
    await expect(done).resolves.toBeUndefined();
    expect(warnings[0]!.msg).toContain("timed out after 10 s");
  });

  it("times out a reply whose body never finishes", async () => {
    vi.useFakeTimers();
    const endless = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) });
    const { impl } = fakeFetch(() => new Response(endless, { status: 200 }));
    const { logger, warnings } = recordingLogger();
    const done = createNotifier(URL_, logger, impl).notify("t", "m");
    await vi.advanceTimersByTimeAsync(NTFY_TIMEOUT_MS);
    await expect(done).resolves.toBeUndefined();
    expect(warnings[0]!.msg).toContain("timed out");
  });

  it("uses the global fetch by default", async () => {
    const { impl, calls } = fakeFetch();
    vi.stubGlobal("fetch", impl);
    await createNotifier(URL_).notify("t", "m");
    expect(calls).toHaveLength(1);
  });
});
