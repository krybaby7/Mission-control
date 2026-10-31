#!/usr/bin/env node
// Fake `claude` CLI for ClaudeRunner tests. Reads the whole prompt from stdin (so it hangs if stdin is never
// closed), records argv / stdin / cwd / env / the system prompt file to $FAKE_CLAUDE_RECORD, then plays the
// stream-json scenario named by $FAKE_CLAUDE_SCENARIO.
import { readFileSync, writeFileSync } from "node:fs";

// Scenario controls are fixture files; they are never worker environment overrides.
let fixture = {};
try { fixture = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_DIR + "/mc-fixture.json", "utf8")); } catch {}

const SESSION = "sess-fake-1";
const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const out = (text) => process.stdout.write(text);
const line = (event) => out(JSON.stringify(event) + "\n");
const err = (text) => process.stderr.write(text + "\n");

const init = { type: "system", subtype: "init", session_id: SESSION, model: flag("--model") ?? "unknown", tools: [] };
/** Stays alive like a CLI with more to do (or waiting on a background shell), until it is killed. */
const keepRunning = () => setInterval(() => {}, 1_000);
const assistant = (...content) => ({ type: "assistant", message: { content }, session_id: SESSION });
const text = (value) => ({ type: "text", text: value });
const toolUse = (name, input) => ({ type: "tool_use", id: `tool-${name}`, name, input });
const rateLimit = (info) => ({ type: "rate_limit_event", rate_limit_info: info, uuid: "rl-1", session_id: SESSION });
const apiRetry = (attempt, status) => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 10,
  retry_delay_ms: 10,
  error_status: status,
  error: "rate_limit",
  session_id: SESSION,
});
const result = (fields) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  num_turns: 3,
  result: "Done.",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700 },
  session_id: SESSION,
  ...fields,
});
const errorResult = (fields) => result({ is_error: true, num_turns: 1, total_cost_usd: 0, ...fields });

const LONG_TEXT = "I will start by reading the code. ".repeat(20);
const SUCCESS_MENTIONING_429 =
  "API Error: 429 Too Many Requests is what the new middleware returns once the rate limit is exceeded.";
/** A retry notice the CLI leaves on stderr even when the retry works. */
const RETRY_NOTICE = "API Error: 429 Too Many Requests (retrying)";
/** Paid extra usage absorbs the five-hour rejection, as CLI 2.1.296 reports it. */
const EXTRA_USAGE = {
  status: "rejected",
  rateLimitType: "five_hour",
  resetsAt: 1791600000,
  overageStatus: "allowed",
  isUsingOverage: true,
  unifiedWindows: { five_hour: { utilization: 1.01, resetsAt: 1791600000 } },
};

const scenarios = {
  success() {
    line(init);
    line(assistant(text(LONG_TEXT), toolUse("Read", { file_path: "src/app.ts" })));
    line(assistant(toolUse("Bash", { command: "npm test", description: "run tests" })));
    line(assistant(toolUse("Grep", { pattern: "TODO" }), toolUse("TodoWrite", { todos: [] })));
    line({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] }, session_id: SESSION });
    line(assistant(text("All tests pass.")));
    line(result({ result: "All tests pass." }));
  },
  "no-result-text"() {
    line(init);
    line(assistant(text("Final words from the assistant.")));
    line(result({ subtype: "error_during_execution", is_error: true, result: undefined, errors: [] }));
  },
  "api-retry"() {
    line(init);
    line(apiRetry(1, 529));
    line(apiRetry(2, null));
    line(result({}));
  },
  glued() {
    out("\u001b[2Kwarming up...\n");
    // Two events glued together behind junk text.
    out("noise " + JSON.stringify(init) + JSON.stringify(assistant(text("Working on it."))) + "\n");
    // A truncated event followed by a complete one.
    const truncated = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"';
    const window = { five_hour: { utilization: 0.4, resetsAt: 1791600000 } };
    out(truncated + JSON.stringify(rateLimit({ status: "allowed", unifiedWindows: window })) + "\n");
    out("not json at all\n\n{broken\n");
    out(JSON.stringify(assistant(toolUse("Edit", { file_path: "src/kept.ts" }))) + "\r\n");
    out(JSON.stringify(result({ result: "Glued but fine." })) + " trailing garbage\r\n");
  },
  utilization() {
    line(init);
    line(
      rateLimit({
        status: "allowed_warning",
        rateLimitType: "seven_day_opus",
        utilization: 0.81,
        resetsAt: 1791700000,
        unifiedWindows: {
          five_hour: { utilization: 0.42, resetsAt: 1791590000 },
          seven_day: { utilization: 0.77, resetsAt: 1792000000 },
        },
      }),
    );
    // The top-level window is also a unified window: reported once.
    line(
      rateLimit({
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.5,
        resetsAt: 1791590000,
        unifiedWindows: { five_hour: { utilization: 0.43, resetsAt: 1791590000 } },
      }),
    );
    line(rateLimit({ status: "allowed" }));
    line(result({}));
  },
  "rate-limit-rejected"() {
    line(init);
    line(
      rateLimit({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1791600000,
        unifiedWindows: { five_hour: { utilization: 1.02, resetsAt: 1791600000 } },
      }),
    );
    line(errorResult({ result: "You've hit your session limit · resets 3:45pm" }));
  },
  "rate-limit-rejected-no-reset"() {
    line(init);
    line(rateLimit({ status: "rejected", rateLimitType: "seven_day_opus" }));
    line(errorResult({ result: "You've hit your Opus limit · resets in 2 hours" }));
  },
  "rejected-then-success"() {
    line(init);
    line(rateLimit({ status: "rejected", rateLimitType: "overage", resetsAt: 1791600000 }));
    line(result({ result: "Finished anyway." }));
  },
  "extra-usage-success"() {
    line(init);
    line(rateLimit(EXTRA_USAGE));
    // Older shape: no isUsingOverage, only the overage status.
    line(rateLimit({ status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed_warning" }));
    line(result({ result: "", structured_output: { verdict: "approve", issues: [] } }));
  },
  /** Extra usage covers the rejection, so the CLI keeps working (and billing) until it is stopped. */
  "extra-usage-continues"() {
    line(init);
    line(assistant(text("Working on it.")));
    line(rateLimit(EXTRA_USAGE));
    line(assistant(toolUse("Bash", { command: "npm test" })));
    keepRunning();
  },
  /** The older event shape: no isUsingOverage, only the overage status, and no reset time or utilization. */
  "extra-usage-continues-old-shape"() {
    line(init);
    line(rateLimit({ status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed_warning" }));
    keepRunning();
  },
  /** Extra usage is used up too: nothing covers the rejection, and the CLI stops by itself. */
  "extra-usage-exhausted"() {
    line(init);
    line(
      rateLimit({
        status: "rejected",
        rateLimitType: "overage",
        resetsAt: 1792000000,
        overageStatus: "rejected",
        isUsingOverage: false,
      }),
    );
    line(errorResult({ result: "You're out of extra usage" }));
  },
  "rejected-no-result"() {
    line(init);
    line(rateLimit({ status: "rejected", rateLimitType: "seven_day", resetsAt: 1792000000 }));
    err("fatal: request rejected");
    process.exitCode = 1;
  },
  "limit-text"() {
    line(init);
    line(errorResult({ result: "You've hit your weekly limit · resets in 3 days" }));
  },
  "limit-errors"() {
    line(init);
    line(
      errorResult({
        subtype: "error_during_execution",
        result: undefined,
        errors: ["You've hit your session limit · resets in 45 minutes"],
      }),
    );
  },
  "limit-stderr"() {
    line(init);
    err('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}');
    process.exitCode = 1;
  },
  "success-mentions-429"() {
    line(init);
    line(apiRetry(1, 429));
    line(assistant(text(SUCCESS_MENTIONING_429)));
    err(RETRY_NOTICE);
    line(result({ result: SUCCESS_MENTIONING_429 }));
  },
  structured() {
    line(init);
    line(result({ result: "", structured_output: { verdict: "approve", issues: [] } }));
  },
  "structured-text"() {
    line(init);
    line(result({ result: '{"verdict":"revise","issues":["missing tests"]}' }));
  },
  "structured-embedded"() {
    line(init);
    const answer =
      'Review complete.\n```json\n{"verdict":"approve","issues":["draft"]}\n```\n' +
      'Final answer: {"verdict":"revise","issues":["final"]}';
    line(result({ result: answer }));
  },
  "structured-invalid"() {
    line(init);
    line(result({ result: "", structured_output: { verdict: "maybe", issues: "none" } }));
  },
  "structured-missing"() {
    line(init);
    line(result({ result: "I could not produce the JSON." }));
  },
  auth() {
    line(init);
    line(errorResult({ api_error_status: 401, result: "Failed to authenticate. API Error: 401 token rejected" }));
  },
  "auth-status-only"() {
    line(init);
    line(errorResult({ api_error_status: 403, result: "Request not allowed" }));
  },
  "auth-text"() {
    line(init);
    line(errorResult({ result: "OAuth token has expired. Please obtain a new token or refresh your existing token." }));
  },
  "auth-stderr"() {
    err("Error: Not logged in · Please run /login");
    process.exitCode = 1;
  },
  "max-turns"() {
    line(init);
    line(assistant(text("Still working...")));
    line(errorResult({ subtype: "error_max_turns", result: undefined, num_turns: 40 }));
  },
  "max-turns-after-retry"() {
    line(init);
    err(RETRY_NOTICE);
    line(errorResult({ subtype: "error_max_turns", result: undefined, num_turns: 40 }));
  },
  "auth-after-retry"() {
    line(init);
    err(RETRY_NOTICE);
    line(errorResult({ api_error_status: 401, result: "Failed to authenticate. API Error: 401 token rejected" }));
  },
  error() {
    line(init);
    line(
      errorResult({
        subtype: "error_during_execution",
        result: undefined,
        errors: ["Tool permission stream closed unexpectedly", { code: "E_TOOL" }],
      }),
    );
  },
  "api-error"() {
    // Shaped like CLI 2.1.296 once it gives up on the API: a synthetic assistant message, then an is_error result.
    const message = fixture.FAKE_CLAUDE_API_ERROR ?? "API Error: 500 Internal server error";
    const status = fixture.FAKE_CLAUDE_API_STATUS ? Number(fixture.FAKE_CLAUDE_API_STATUS) : null;
    line(init);
    line(assistant(text(message)));
    line(errorResult({ api_error_status: status, terminal_reason: "api_error", result: message }));
    process.exitCode = 1;
  },
  crash() {
    line(init);
    out('{"type":"assistant","message":{"content":[{"type":"te');
    err("\u001b[31mTypeError: x is not a function\u001b[0m\n    at main (cli.js:1:1)");
    process.exitCode = 3;
  },
  garbage() {
    out("Segmentation fault?\n{not json}\n");
  },
  hang() {
    line(init);
    keepRunning();
  },
  /** The login bills an API key ($FAKE_CLAUDE_KEY_SOURCE, as the init event names it); the CLI would go on. */
  "api-key"() {
    line({ ...init, apiKeySource: fixture.FAKE_CLAUDE_KEY_SOURCE ?? "ANTHROPIC_API_KEY" });
    line(assistant(text("Working on it.")));
    keepRunning();
  },
  "subscription-login"() {
    line({ ...init, apiKeySource: "none" });
    line(result({ result: "Done." }));
  },
  /** Prints its result, then keeps waiting (a background shell, a hung MCP child). */
  linger() {
    line(init);
    line(result({ result: "Finished; the dev server is still running." }));
    keepRunning();
  },
  /**
   * Prints its result, then a background shell wakes the model: a second turn that goes quiet for 2.5 s (a long
   * tool call) before its own result, after which the CLI exits by itself.
   */
  "result-then-new-turn"() {
    line(init);
    line(result({ result: "First answer." }));
    setTimeout(() => {
      line(assistant(toolUse("Bash", { command: "npm test" })));
      setTimeout(() => line(result({ result: "Second answer." })), 2_500);
    }, 100);
  },
};

const stdin = await readStdin();
const promptFile = flag("--append-system-prompt-file");
if (fixture.FAKE_CLAUDE_RECORD) {
  const record = {
    argv: args,
    stdin,
    cwd: process.cwd(),
    env: process.env,
    pid: process.pid,
    systemPromptFile: promptFile ?? null,
    systemPrompt: promptFile ? readFileSync(promptFile, "utf8") : null,
  };
  writeFileSync(fixture.FAKE_CLAUDE_RECORD, JSON.stringify(record));
}
const play = scenarios[fixture.FAKE_CLAUDE_SCENARIO ?? "success"];
if (play) {
  play();
} else {
  err(`fake-claude: unknown scenario ${fixture.FAKE_CLAUDE_SCENARIO}`);
  process.exitCode = 64;
}
