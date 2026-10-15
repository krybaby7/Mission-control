#!/usr/bin/env bash
# For developers working in a throwaway cloud container, never for the owner's PC.
# Runs a command with this session's identity and unrelated credentials removed, so the engine's agents (which run with
# broad permissions) cannot message the session, push to GitHub or reach cloud credentials. Use it for every real engine run:
#   MC_IN_CONTAINER=1 scripts/dev/scrub.sh node dist/cli.js run
exec env \
  -u GH_TOKEN -u GITHUB_TOKEN -u GIT_ASKPASS \
  -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_KEY_2 \
  -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_VALUE_2 \
  -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_CA_BUNDLE \
  -u CLOUDSDK_AUTH_ACCESS_TOKEN -u CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE -u CLOUDSDK_PROXY_ADDRESS -u CLOUDSDK_PROXY_PORT -u CLOUDSDK_PROXY_TYPE \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u SBX_TELEMETRY_SOCKET -u TRACEPARENT \
  -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_REMOTE_SESSION_ID -u CLAUDE_PID -u CLAUDECODE \
  -u CLAUDE_CODE_DIAGNOSTICS_FILE -u CLAUDE_CODE_TEE_SDK_STDOUT -u DOCUMENTS_MCP_SCRATCH_ROOT \
  -u CLAUDE_CODE_ENTRYPOINT -u ANTHROPIC_API_KEY \
  GIT_AUTHOR_NAME="Mission Control" GIT_AUTHOR_EMAIL="mc@example.invalid" \
  GIT_COMMITTER_NAME="Mission Control" GIT_COMMITTER_EMAIL="mc@example.invalid" \
  GIT_TERMINAL_PROMPT=0 \
  "$@"
