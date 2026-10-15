// Leftover processes. An agent's `npm run start -- -p 3100 &`, a nohup'd dev server, or a Playwright web server that
// outlived its test run keeps a port (and memory) busy for the rest of the run, and with CI=1 Playwright refuses to
// start on a busy port, so every later e2e check would fail. runProcess only kills a run's own process tree; a
// process that left it (its own session, or a parent that exited) is re-parented to the init process.
//
// Inside the container mc itself runs directly under that init process (`docker run --init`, the entrypoint execs
// mc), and nothing else should: so between steps, every other child of init is such a leftover. Outside the
// container there is no such rule (a desktop session has plenty of legitimate orphans), so nothing is reaped there.
import { readdirSync, readFileSync } from "node:fs";

export interface ProcInfo {
  pid: number;
  ppid: number;
}

/** How long leftovers get to exit after SIGTERM before SIGKILL. */
const GRACE_MS = 2_000;
const POLL_MS = 100;

/**
 * The pids to kill: each child of `initPid` other than `self`, with all of its descendants. `self` and its own
 * descendants (the run mc is waiting for) are never included.
 */
export function orphanTrees(table: ProcInfo[], self: number, initPid = 1): number[] {
  const children = new Map<number, number[]>();
  for (const p of table) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const seen = new Set<number>([self, initPid]);
  const stack = table.filter((p) => p.ppid === initPid && !seen.has(p.pid)).map((p) => p.pid);
  const out: number[] = [];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out.sort((a, b) => a - b);
}

/** True when mc runs as the container's main process: MC_IN_CONTAINER=1 and a direct child of init (pid 1). */
export function reapingApplies(env: NodeJS.ProcessEnv = process.env, ppid: number = process.ppid): boolean {
  return env.MC_IN_CONTAINER === "1" && ppid === 1;
}

/**
 * Kills the leftovers (SIGTERM, then SIGKILL after a grace period) and returns their pids. A no-op, returning [],
 * unless reapingApplies(). Never throws.
 */
export async function reapOrphans(opts: { graceMs?: number } = {}): Promise<number[]> {
  if (!reapingApplies()) return [];
  try {
    const pids = orphanTrees(readProcTable(), process.pid);
    if (pids.length === 0) return [];
    for (const pid of pids) signal(pid, "SIGTERM");
    const deadline = Date.now() + (opts.graceMs ?? GRACE_MS);
    while (Date.now() < deadline && pids.some(alive)) await new Promise((r) => setTimeout(r, POLL_MS));
    for (const pid of pids) if (alive(pid)) signal(pid, "SIGKILL");
    return pids;
  } catch {
    return [];
  }
}

function readProcTable(): ProcInfo[] {
  const table: ProcInfo[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid …": comm may contain spaces and parentheses.
      const [state, ppid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (state === "Z") continue; // already dead, waiting for init to reap it
      table.push({ pid: Number(name), ppid: Number(ppid) });
    } catch {
      // exited meanwhile
    }
  }
  return table;
}

/** Still running: a zombie (dead, not yet collected by init) does not count. */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, sig);
  } catch {
    // gone already, or not ours
  }
}
