// `mc dashboard`: starts the read-only server over a Mission Control home and runs until it is told to stop
// (docs/dashboard-spec.md, 2.5). The commander action in src/cli.ts only gathers the options and calls this.
import { readdirSync, statSync } from "node:fs";
import { parseUntil } from "../run.js";
import { DEFAULT_PORT } from "./constants.js";
import { loadPage } from "./page.js";
import { atMostOncePerMinute, startDashboardServer } from "./server.js";
import { buildSnapshot, type DashboardSettings } from "./snapshot.js";

export interface DashboardCommandOptions {
  /** Absolute path of the Mission Control home. */
  home: string;
  settings: DashboardSettings;
  host: string;
  port: number;
  /** "HH:MM": the stop time that was given to `mc run`, so the page can count down to it. */
  until?: string;
  /** Receives the lines for stdout (without a line break). */
  say: (line: string) => void;
  /** Aborting it stops the server; the CLI wires SIGINT and SIGTERM to it. */
  signal?: AbortSignal;
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/** The port number in `text` (a whole number from 1 to 65535). Throws a plain Error otherwise. */
export function parsePort(text: string): number {
  const port = /^\d{1,5}$/.test(text.trim()) ? Number(text) : Number.NaN;
  return checkedPort(port, text);
}

function checkedPort(port: number, shown: string | number = port): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`"${shown}" is not a port number. Use a whole number from ${MIN_PORT} to ${MAX_PORT}, for example: mc dashboard --port ${DEFAULT_PORT}`);
  }
  return port;
}

/** Whether the Mission Control folder can be listed. Only reads. */
function homeState(home: string): "readable" | "missing" | "unreadable" {
  try {
    if (!statSync(home).isDirectory()) return "unreadable";
    readdirSync(home);
    return "readable";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

/** Starts the dashboard and resolves after it was stopped. Throws a plain Error when it cannot start. */
export async function runDashboard(o: DashboardCommandOptions): Promise<void> {
  const port = checkedPort(o.port);
  // The engine's own check and message, and the same function the snapshot uses for the countdown.
  if (o.until !== undefined) parseUntil(o.until, Date.now());
  const pageHtml = loadPage();
  const logError = atMostOncePerMinute((message) => void process.stderr.write(`${message}\n`));

  let running: Awaited<ReturnType<typeof startDashboardServer>>;
  try {
    running = await startDashboardServer({
      host: o.host,
      port,
      pageHtml,
      build: () =>
        buildSnapshot({
          home: o.home,
          settings: o.settings,
          ...(o.until !== undefined && { until: o.until }),
          onError: (err) => logError(`mc dashboard: the snapshot could not be built: ${err instanceof Error ? err.message : String(err)}`),
        }),
      healthz: () => ({ settings: o.settings.source, home: homeState(o.home) }),
      logError,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") throw new Error(`Port ${port} is already in use. Choose another with --port.`);
    throw new Error(`The dashboard could not start on ${o.host} port ${port}: ${err instanceof Error ? err.message : String(err)}`);
  }

  o.say(`Dashboard ready: ${running.url}`);
  o.say("It only reads Mission Control's files. Press Ctrl+C to stop it.");
  // Without a signal it runs until the process ends.
  const signal = o.signal;
  if (signal === undefined) return new Promise<void>(() => {});
  if (!signal.aborted) await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
  await running.close();
}
