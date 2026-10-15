#!/usr/bin/env bash
# For developers in a throwaway cloud container (root, no Docker), never for the owner's PC.
# Makes a fresh Mission Control home at ~/.mission-control (config tuned for a short Claude-only test) and a tiny app at
# ~/mc-apps/word-tools, then prints how to queue a job. It deletes both folders first. See docs/dev-real-run.md.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
[ -f "$repo/dist/cli.js" ] || { echo "Run npm run build first (dist/cli.js is missing)." >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "This is for a throwaway container where you are root. Refusing to touch the home folder of a real user." >&2; exit 1; }

home="$HOME/.mission-control"
apps="$HOME/mc-apps"
app="$apps/word-tools"
rm -rf "$home" "$apps"
mkdir -p "$app/src"

cd "$app"
cat > package.json <<'EOF'
{
  "name": "word-tools",
  "version": "1.0.0",
  "description": "Tiny text helpers",
  "type": "module",
  "main": "src/index.js",
  "scripts": { "test": "node --test" }
}
EOF
cat > src/capitalize.js <<'EOF'
/** Upper-cases the first letter of a word and lower-cases the rest. */
export function capitalize(word) {
  if (typeof word !== "string") throw new TypeError("capitalize expects a string");
  if (word === "") return "";
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}
EOF
printf 'export { capitalize } from "./capitalize.js";\n' > src/index.js
cat > src/capitalize.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "./index.js";

test("capitalize upper-cases the first letter and lower-cases the rest", () => {
  assert.equal(capitalize("hELLO"), "Hello");
});

test("capitalize returns an empty string for an empty string", () => {
  assert.equal(capitalize(""), "");
});

test("capitalize rejects non-strings", () => {
  assert.throws(() => capitalize(42), TypeError);
});
EOF
printf '# word-tools\n\nTiny text helpers, with no dependencies.\n\n## capitalize(word)\n\nUpper-cases the first letter and lower-cases the rest.\n\n## Tests\n\n`npm test`\n' > README.md
printf 'node_modules/\n' > .gitignore
git init -q -b main
git -c user.name=Owner -c user.email=owner@example.invalid add -A
git -c user.name=Owner -c user.email=owner@example.invalid commit -q -m "Initial commit: capitalize helper"

cd "$repo"
MC_IN_CONTAINER=1 "$repo/scripts/dev/scrub.sh" node dist/cli.js init > /dev/null
cfg="$home/config.yaml"
[ -f "$cfg" ] || { echo "mc init did not write $cfg" >&2; exit 1; }
sed -i -E 's/^defaultProfile: mixed/defaultProfile: claude/; s/^(  agentTimeoutMs: )2700000.*/\11200000/; s/^(  maxAgentRunsPerMission: )150.*/\140/' "$cfg"

echo "Ready. Throwaway home: $home. Throwaway app: $app (git, branch main)."
echo "Queue a plan:  MC_IN_CONTAINER=1 scripts/dev/scrub.sh node dist/cli.js plan queue - < your-plan.txt"
echo "Then:          MC_IN_CONTAINER=1 scripts/dev/scrub.sh node dist/cli.js run"
