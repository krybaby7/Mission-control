#!/usr/bin/env node
// Fake `codex exec --json` for the CodexRunner tests. It reads the whole prompt from stdin before doing anything,
// so it blocks forever when the caller leaves stdin open, exactly like the real CLI does.
//
// Environment:
//   FAKE_CODEX_SCENARIO  steps to play, joined by "+" (see STEPS), e.g. "start+work+finish" (the default)
//   FAKE_CODEX_RECORD    if set, write {argv, cwd, stdin, env, schema, pid} here as JSON
//   FAKE_CODEX_MESSAGE   overrides the final agent message (and the -o file content)
import { readFileSync, writeFileSync } from "node:fs";

const DEFAULT_MESSAGE =
  'Added the quota banner. It reads:\nYou\'ve hit your usage limit. Try again at 3:45 PM.\n' +
  "The API now returns 429 Too Many Requests when the rate limit is exceeded.";
const USAGE_LIMIT =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit " +
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.";
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

function turnFailed(text) {
  emit({ type: "turn.failed", error: { message: text } });
  process.exitCode = 1;
}

function agentMessage(text) {
  return { type: "item.completed", item: { id: "item_9", type: "agent_message", text } };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
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
