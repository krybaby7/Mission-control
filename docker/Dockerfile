# Mission Control image: Playwright's Ubuntu image (Node + browsers) plus the pinned Claude Code and Codex CLIs.
# Build it with `scripts/mc-docker.sh build`, which passes your Ubuntu user's ids as MC_UID / MC_GID.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

# Tools for agents and for you inside `mc-docker.sh shell`: compilers for native npm modules (better-sqlite3
# falls back to building from source), ripgrep (both CLIs prefer it for searching), an editor and a pager.
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make ripgrep nano less \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs, pinned to the versions Mission Control was verified against (config: cli.claudeVersion and
# cli.codexVersion). npm's global folder belongs to root, so this runs before switching to pwuser.
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.295 @openai/codex@0.162.0 \
 && npm cache clean --force

# Commits made in the container need an author; the same fallback identity src/git.ts uses.
RUN git config --system user.name "Mission Control" \
 && git config --system user.email "mission-control@localhost"

# Give pwuser your Ubuntu user's uid/gid, so files in the ~/mc-apps bind mount belong to you on both sides.
# The base image's unused "ubuntu" account holds uid 1000 (the usual WSL uid), so it goes first.
ARG MC_UID=1000
ARG MC_GID=1000
RUN if id ubuntu >/dev/null 2>&1; then userdel ubuntu && rm -rf /home/ubuntu; fi \
 && groupmod --non-unique --gid "$MC_GID" pwuser \
 && usermod --non-unique --uid "$MC_UID" --gid "$MC_GID" pwuser

# Mount points for the named volumes. Docker copies a mount point's owner and mode into a new, empty named
# volume, so creating them here (owned by pwuser) keeps the volumes writable without running as root.
RUN install -d -m 700 -o pwuser -g pwuser \
      /home/pwuser/.claude /home/pwuser/.codex /home/pwuser/.mission-control \
 && install -d -m 755 -o pwuser -g pwuser /home/pwuser/mc-apps \
 && chown -R pwuser:pwuser /home/pwuser

# Mission Control itself. It stays owned by root, so agents running as pwuser cannot modify the orchestrator.
# The final `mc --help` fails the build when the CLI didn't get linked or can't start without dev dependencies.
WORKDIR /opt/mission-control
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prompts ./prompts
COPY stacks ./stacks
RUN npm run build \
 && npm link \
 && npm prune --omit=dev \
 && npm cache clean --force \
 && mc --help >/dev/null

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/mc-entrypoint.sh

# CLAUDE_CONFIG_DIR also moves Claude Code's settings file (normally ~/.claude.json) into the mc-claude volume,
# so the login survives between containers. DISABLE_AUTOUPDATER keeps Claude Code at the pinned version.
# mc-docker.sh keeps the browsers in /ms-playwright in the mc-browsers volume. Apps can need other Playwright
# versions than this image's, and `npx playwright install` would otherwise delete the browsers of every version
# that never ran it (the image's own included), breaking the other apps' tests.
ENV MC_IN_CONTAINER=1 \
    CLAUDE_CONFIG_DIR=/home/pwuser/.claude \
    CODEX_HOME=/home/pwuser/.codex \
    DISABLE_AUTOUPDATER=1 \
    PLAYWRIGHT_SKIP_BROWSER_GC=1

USER pwuser
WORKDIR /home/pwuser
ENTRYPOINT ["/usr/local/bin/mc-entrypoint.sh"]
CMD ["mc", "--help"]
