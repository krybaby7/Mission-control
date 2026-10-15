# Real runs in a cloud container (for developers)

A real run drives the real Claude Code CLI through the engine on a tiny throwaway app. It proves what the mock harness cannot: real AI output, real stage timing, real quota readings. It costs about 1% of the weekly Claude allowance for a one-feature job. It is for a throwaway cloud container (you are root, no Docker). **Never run it on the owner's PC.**

## Recipe

1. `npm run build` (the run uses `dist/cli.js`).
2. `scripts/dev/real-run-setup.sh` makes `~/.mission-control` (Claude-only profile, 20-minute agent timeout, 40 agent runs) and `~/mc-apps/word-tools` (a tiny app on branch `main` with tests). It deletes both folders first.
3. Every engine command goes through the scrub wrapper, which removes this session's identity and cloud credentials from the environment, because the engine's agents run with broad permissions:
   `MC_IN_CONTAINER=1 scripts/dev/scrub.sh node dist/cli.js <command>`
4. Queue a job, for example a plan from a file: `... plan queue - < plan.txt` (see `leader/CLAUDE.md` and `docs/plans-spec.md` for the plan format), or `... feature ~/mc-apps/word-tools "Add a shout(text) function ..." --name Shout --profile claude --checkpoint plan`.
5. `... run` runs until the queue is empty or a check waits for you. A stop for your check ends the run with exit code 0. Look with `... status`, `... report`, `... plan show <id>`. Answer with `... approve <id>` or `... send-back <id> --note "..."`, then `... run --mission <id>`.
6. Look at the result in the app folder: `git -C ~/mc-apps/word-tools branch -a`, then `git checkout --detach mc/<id>`, run its tests, and `git checkout main`. The engine never moves `main` for a change to an existing app.
7. Read `~/.mission-control/quota.json` (the weekly and 5-hour readings the engine took) and `usage.jsonl` (one row per AI call) for the cost.
8. Keep the evidence you need (`cp -r ~/.mission-control/missions <somewhere>`), then `rm -rf ~/.mission-control ~/mc-apps`.

## Facts learned the hard way

* The engine downgrades Claude's permission mode to `auto` when it runs as root. That works.
* Codex is not available in the container. Use `--profile claude`.
* A plan file given to `mc plan preview/queue` must be inside `~/mc-apps`; send it on standard input (`-`) instead.
* The dashboard can be served on the real home: `MC_IN_CONTAINER=1 scripts/dev/scrub.sh node dist/cli.js dashboard --port 8787 --host 127.0.0.1` (start it in the background; stop it by process id, see below).
* `pkill -f <text>` kills your own shell when the text appears in your own command line (exit code 144). Use `pgrep -f`, read the pid, and `kill <pid>`.
* Nested `claude -p` runs (for example to test Claude Code's permission rules) did not apply a project `.claude/settings.json`; pass `--allowedTools "Bash(...)"` on the command line instead. See `docs/plans-spec.md` section 17 for the spike.
* The Bash tool of Claude Code refuses commands with a curly bracket followed by a quote, here-documents with an unquoted delimiter, and commands after a here-document. It also refuses a `bash -c '...|...'` that contains a removal. Write a script file and run it.
