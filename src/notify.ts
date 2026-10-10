// Push notifications through ntfy (https://ntfy.sh): one POST per message. Failures are logged and swallowed,
// so a flaky network or a bad URL can never break a mission.
import type { Logger } from "./types.js";
import { nullLogger } from "./util/logger.js";

export interface NotifyOptions {
  priority?: "default" | "high";
  tags?: string[];
}

export interface Notifier {
  /** Never rejects. */
  notify(title: string, message: string, opts?: NotifyOptions): Promise<void>;
}

export const NTFY_TIMEOUT_MS = 10_000;
/** ntfy turns bodies over 4096 bytes into attachments, which many servers refuse; stay under that. */
export const MAX_MESSAGE_BYTES = 4000;
const PRIORITY_HEADER = { default: "3", high: "4" } as const;
const MAX_ERROR_BODY_CHARS = 200;

/** A notifier posting to ntfyUrl; a silent no-op when the URL is empty or unset. */
export function createNotifier(
  ntfyUrl: string | undefined,
  logger: Logger = nullLogger,
  fetchImpl: typeof fetch = globalThis.fetch,
): Notifier {
  const url = ntfyUrl?.trim();
  if (!url) return { notify: async () => {} };

  return {
    async notify(title, message, opts = {}) {
      try {
        await postWithTimeout(fetchImpl, url, {
          method: "POST",
          headers: ntfyHeaders(title, opts),
          body: truncateUtf8(message, MAX_MESSAGE_BYTES),
        });
        logger.info(`notification sent: ${title}`);
      } catch (err) {
        // The topic in the URL acts as a password, so only the host goes into the log.
        logger.warn(`could not send notification "${title}": ${errorText(err)}`, { host: hostOf(url) });
      }
    },
  };
}

function ntfyHeaders(title: string, opts: NotifyOptions): Record<string, string> {
  const headers: Record<string, string> = { Priority: PRIORITY_HEADER[opts.priority ?? "default"] };
  const cleanTitle = headerValue(title);
  if (cleanTitle) headers.Title = cleanTitle;
  const tags = (opts.tags ?? []).map((t) => t.trim()).filter((t) => t !== "");
  if (tags.length > 0) headers.Tags = headerValue(tags.join(","));
  return headers;
}

/**
 * HTTP header values must be single-line Latin-1. Control characters become spaces; anything non-ASCII is sent as an
 * RFC 2047 encoded word, which ntfy decodes.
 */
function headerValue(s: string): string {
  const flat = s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/**
 * Sends the request and reads the reply, failing after NTFY_TIMEOUT_MS even if fetchImpl ignores the abort signal.
 * Rejects on network errors, timeouts and non-2xx replies.
 */
async function postWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${NTFY_TIMEOUT_MS / 1000} s`);
      controller.abort(err);
      reject(err);
    }, NTFY_TIMEOUT_MS);
  });
  const send = async (): Promise<void> => {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await res.text().catch(() => ""); // drain the body so the connection is released
    if (!res.ok) throw new Error(`ntfy replied HTTP ${res.status}${body.trim() ? `: ${body.trim().slice(0, MAX_ERROR_BODY_CHARS)}` : ""}`);
  };
  const sending = send();
  sending.catch(() => {}); // when the timeout wins, the late failure has nobody left to report to
  try {
    await Promise.race([sending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cuts s to at most maxBytes of UTF-8 (ending in "…") without splitting a character. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  const ellipsis = "…";
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  // Decoding a cut-off multi-byte sequence yields U+FFFD; drop it.
  const cut = Buffer.from(s, "utf8").subarray(0, budget).toString("utf8").replace(/�+$/, "");
  return cut + ellipsis;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici wraps the real reason (ECONNREFUSED, ENOTFOUND, …) in err.cause
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err.message}${cause}`;
}
