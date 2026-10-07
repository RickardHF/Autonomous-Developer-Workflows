#!/usr/bin/env bash
# Hook script: blocks any tool call that reads from the advanced workshop folder.
# Receives a JSON payload on stdin describing the tool call.
# Outputs a PreToolUse permission denial; exits 0 with no output to allow.
#
# Intentionally searches the entire raw payload rather than a specific field so
# that it works across different hook payload shapes (Claude sends tool_input,
# Copilot sends input, etc.).

set -euo pipefail

input=$(cat)

# Block if any argument in the payload references the Agentic Workflows & Evaluation directory.
if echo "$input" | grep -qiF 'exercises/Agentic Workflows & Evaluation/'; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Access to the exercises/Agentic Workflows & Evaluation/ folder is restricted. Agents are not allowed to read files from this directory."}}'
    exit 0
fi

# Allow the tool call.
exit 0
