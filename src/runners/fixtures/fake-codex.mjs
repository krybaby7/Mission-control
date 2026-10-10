#!/usr/bin/env node
// Fake `codex exec --json` for the CodexRunner tests. It reads the whole prompt from stdin before doing anything,
// so it blocks forever when the caller leaves stdin open, exactly like the real CLI does.
//
// Environment:
//   FAKE_CODEX_SCENARIO     steps to play, joined by "+" (see STEPS), e.g. "start+work+finish" (the default)
//   FAKE_CODEX_RECORD       if set, write {argv, cwd, stdin, env, schema, pid} here as JSON
//   FAKE_CODEX_MESSAGE      overrides the final agent message (and the -o file content)
//   FAKE_CODEX_CALLS        if set, append one line per `sandbox` probe and app-server request here
//   FAKE_CODEX_SANDBOX      "broken": `codex sandbox` fails as bubblewrap does in a default Docker container
//   FAKE_CODEX_APP_SERVER   "missing" (no app-server subcommand) or "hang" (never answers); default answers
//   FAKE_CODEX_ACCOUNT      account/read: "chatgpt" (default), "apiKey", "amazonBedrock" or "none" (not logged in)
//   FAKE_CODEX_RATE_LIMITS  account/rateLimits/read's rateLimits snapshot as JSON; unset: an error, as for API keys
//   FAKE_CODEX_WRITE_FILE   the "write-file" step writes "changed by codex" to this path (relative to the cwd)
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] === "sandbox") sandboxProbe();
if (process.argv[2] === "app-server") await appServer();

const DEFAULT_MESSAGE =
  'Added the quota banner. It reads:\nYou\'ve hit your usage limit. Try again at 3:45 PM.\n' +
  "The API now returns 429 Too Many Requests when the rate limit is exceeded.";
const USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.";
const NETWORK_WAIT = "Reconnecting... waiting for network (Connection failed: error sending request)";
const AUTH_FAILURE =
  "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
const REFRESH_FAILURE =
  "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.";
const USAGE = {
  input_tokens: 1200,
  cached_input_tokens: 800,
  cache_write_input_tokens: 50,
  output_tokens: 300,
  reasoning_output_tokens: 120,
};

const stdin = await readAllStdin();
const args = parseArgs(process.argv.slice(2));
if (args.error) fail(2, `error: ${args.error}`);
record();

const message = process.env.FAKE_CODEX_MESSAGE ?? DEFAULT_MESSAGE;
const STEPS = {
  start: () => {
    emit({ type: "thread.started", thread_id: "thread-123" });
    emit({ type: "turn.started" });
  },
  /** thread.started only: the run ends before any turn. */
  "thread-only": () => emit({ type: "thread.started", thread_id: "thread-short" }),
  work,
  finish: () => {
    emit(agentMessage(message));
    writeLastMessage(message);
    emit({ type: "turn.completed", usage: USAGE });
  },
  "finish-without-file": () => {
    emit(agentMessage(message));
    emit({ type: "turn.completed", usage: USAGE });
  },
  /** One line holding junk and two glued events, then another holding two more. */
  glued: () => {
    process.stdout.write(`junk before{"type":"thread.started","thread_id":"thread-glued"}{"type":"turn.started"}\n`);
    process.stdout.write(
      `${JSON.stringify(agentMessage(message))}${JSON.stringify({ type: "turn.completed", usage: USAGE })}\n`,
    );
    writeLastMessage(message);
  },
  /** Throttled retries, logged on stdout and stderr; they count as recovered once further items arrive. */
  "throttled-retries": () => {
    emit({ type: "error", message: "Reconnecting... 1/5 (stream error: rate limit exceeded; retrying in 1s)" });
    emit({ type: "error", message: "Reconnecting... 2/5 (unexpected status 429 Too Many Requests)" });
    process.stderr.write("WARN codex_core::client: stream error: rate limit exceeded; retrying\n");
  },
  "retry-429": () => emit({ type: "error", message: "Reconnecting... 3/5 (unexpected status 429 Too Many Requests)" }),
  "mcp-auth-warning": () => {
    process.stderr.write("ERROR codex_core::mcp: MCP client for `github` failed to start: authentication required\n");
    process.stderr.write("ERROR codex_rmcp_client: MCP server `docs` requires OAuth authentication; skipping\n");
  },
  "usage-limit": () => {
    emit({ type: "error", message: USAGE_LIMIT });
    turnFailed(USAGE_LIMIT);
  },
  /** The limit only reaches an error event before codex exits: no turn.failed. */
  "usage-limit-error": () => {
    emit({ type: "error", message: USAGE_LIMIT });
    process.exitCode = 1;
  },
  "usage-limit-stderr": () => {
    process.stderr.write(`Error: ${USAGE_LIMIT}\n`);
    process.exitCode = 1;
  },
  auth: () => {
    emit({ type: "error", message: `Reconnecting... 1/5 (${AUTH_FAILURE})` });
    turnFailed(AUTH_FAILURE);
  },
  "refresh-token": () => {
    emit({ type: "error", message: REFRESH_FAILURE });
    turnFailed(REFRESH_FAILURE);
  },
  forbidden: () => turnFailed("unexpected status 403 Forbidden: this workspace does not have access to Codex"),
  "not-logged-in": () => {
    process.stderr.write("Error: Not logged in. Run `codex login` first.\n");
    process.exitCode = 1;
  },
  "turn-failed": () => turnFailed("The model produced an invalid tool call"),
  /** The network went away: codex's retries give up (as codex 0.162.0 words it). */
  offline: () => {
    const lost = "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)";
    emit({ type: "error", message: `Reconnecting... 5/5 (${lost})` });
    turnFailed(lost);
  },
  "server-error": () => turnFailed("unexpected status 503 Service Unavailable: upstream connect error"),
  /** How codex 0.162.0 reports an HTTP 500 once its retries are spent. */
  "high-demand": () => {
    const text = "We’re currently experiencing high demand, which may cause temporary errors.";
    emit({ type: "error", message: `Reconnecting... 1/1 (${text})` });
    emit({ type: "error", message: text });
    turnFailed(text);
  },
  "retry-limit-500": () => turnFailed("exceeded retry limit, last status: 500 Internal Server Error"),
  /** The network is gone: codex 0.162.0 waits for it indefinitely, printing this every few seconds. */
  "waiting-for-network": () => {
    const waiting = () => emit({ type: "error", message: NETWORK_WAIT });
    waiting();
    setInterval(waiting, 50);
  },
  /** A short outage that codex rides out: two waiting notices, 250 ms without progress, then work goes on. */
  "brief-outage": () => {
    emit({ type: "error", message: NETWORK_WAIT });
    emit({ type: "error", message: NETWORK_WAIT });
    sleep(250);
  },
  /** 1.8 s of quiet work (a long command), with no error pending. */
  pause: () => sleep(1_800),
  /** Changes a file in the working directory, as an agent ignoring a read-only brief would. */
  "write-file": () => writeFileSync(process.env.FAKE_CODEX_WRITE_FILE ?? "codex-was-here.txt", "changed by codex\n"),
  panic: () => {
    process.stderr.write("mcp server listening on 127.0.0.1:40123\n");
    process.stderr.write("thread 'main' panicked at core/src/codex.rs:42: boom\n");
    process.exitCode = 101;
  },
  "exit-error": () => {
    process.stderr.write("Error: failed to write last message file\n");
    process.exitCode = 1;
  },
  hang: () => setInterval(() => {}, 1 << 30),
};

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "start+work+finish";
const steps = scenario.split("+").map((name) => STEPS[name] ?? fail(2, `fake codex: unknown step ${name}`));
for (const step of steps) step();

function work() {
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Planning the change" } });
  const command = { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'" };
  emit({ type: "item.started", item: { ...command, status: "in_progress" } });
  emit({ type: "item.completed", item: { ...command, aggregated_output: "ok", exit_code: 0, status: "completed" } });
  emit({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "file_change",
      changes: [
        { path: "src/app.ts", kind: "update" },
        { path: "src/limit.ts", kind: "add" },
      ],
      status: "completed",
    },
  });
}

/** `codex sandbox -c sandbox_mode="read-only" -- true`: works, or fails as bubblewrap does without user namespaces. */
function sandboxProbe() {
  logCall(`sandbox ${process.argv.slice(3).join(" ")}`);
  if (process.env.FAKE_CODEX_SANDBOX === "broken") {
    process.stderr.write(
      "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

/** JSON-RPC over stdio, one message per line, answering as codex 0.162.0 does; it quits when stdin closes. */
async function appServer() {
  const mode = process.env.FAKE_CODEX_APP_SERVER ?? "answer";
  if (mode === "missing") {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n");
    process.exit(2);
  }
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method !== undefined) logCall(`app-server ${request.method}`);
    if (mode === "hang" || request.id === undefined) continue;
    process.stdout.write(`${JSON.stringify({ id: request.id, ...appServerAnswer(request.method) })}\n`);
  }
  process.exit(0);
}

function appServerAnswer(method) {
  if (method === "initialize") return { result: { userAgent: "fake-codex/0.162.0", platformFamily: "unix" } };
  if (method === "account/read") {
    const type = process.env.FAKE_CODEX_ACCOUNT ?? "chatgpt";
    const account = type === "none" ? null : type === "chatgpt" ? { type, email: null, planType: "plus" } : { type };
    return { result: { account, requiresOpenaiAuth: true, workspaceRouting: null } };
  }
  if (method === "account/rateLimits/read") {
    const limits = process.env.FAKE_CODEX_RATE_LIMITS;
    if (limits === undefined) return { error: { code: -32600, message: "chatgpt authentication required to read rate limits" } };
    return { result: { ordinaryUsageAllowed: true, rateLimits: JSON.parse(limits), rateLimitsByLimitId: null } };
  }
  return { error: { code: -32601, message: `unknown method ${method}` } };
}

function logCall(text) {
  if (process.env.FAKE_CODEX_CALLS) appendFileSync(process.env.FAKE_CODEX_CALLS, `${text}\n`);
}

function turnFailed(text) {
  emit({ type: "turn.failed", error: { message: text } });
  process.exitCode = 1;
}

function agentMessage(text) {
  return { type: "item.completed", item: { id: "item_9", type: "agent_message", text } };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`); // synchronous for pipes on Linux, so sleep() keeps the order
}

/** Blocks the fake for `ms`, as codex is quiet while it waits; later steps' events come after the pause. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeLastMessage(text) {
  if (args.lastMessageFile) writeFileSync(args.lastMessageFile, text);
}

function fail(code, text) {
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

function record() {
  const path = process.env.FAKE_CODEX_RECORD;
  if (!path) return;
  const schema = args.schemaFile ? JSON.parse(readFileSync(args.schemaFile, "utf8")) : null;
  const data = { argv: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env, schema, pid: process.pid };
  writeFileSync(path, JSON.stringify(data));
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Accepts the subset of `codex exec` the runner uses; rejects anything the real CLI would not take. */
function parseArgs(argv) {
  if (argv[0] !== "exec") return { error: "expected the exec subcommand" };
  if (argv.at(-1) !== "-") return { error: "expected '-' (prompt on stdin) as the last argument" };
  const parsed = {};
  const withValue = new Set(["-C", "-m", "-c", "-s", "-o", "--output-schema"]);
  for (let i = 1; i < argv.length - 1; i++) {
    const flag = argv[i];
    if (flag === "--json" || flag === "--skip-git-repo-check") continue;
    if (flag === "resume") {
      if (i + 2 !== argv.length - 1) return { error: "resume takes exactly a session id before '-'" };
      parsed.resume = argv[++i];
      continue;
    }
    if (!withValue.has(flag) || i + 1 >= argv.length - 1) return { error: `unexpected argument ${flag}` };
    const value = argv[++i];
    if (flag === "-c" && !isTomlOverride(value)) return { error: `invalid -c override: ${value}` };
    if (flag === "-o") parsed.lastMessageFile = value;
    if (flag === "--output-schema") parsed.schemaFile = value;
  }
  return parsed;
}

/** key=value where value is a TOML string ("…"), boolean or integer. */
function isTomlOverride(arg) {
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*=("([^"\\]|\\.)*"|true|false|-?\d+)$/.test(arg);
}
