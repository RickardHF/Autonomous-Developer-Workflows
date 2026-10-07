#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
hook="$script_dir/restrict-exercises.sh"
expected='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Access to the exercises/Agentic Workflows & Evaluation/ folder is restricted. Agents are not allowed to read files from this directory."}}'

assert_denied() {
    local payload=$1
    local output

    output=$(printf '%s' "$payload" | "$hook")
    [[ "$output" == "$expected" ]]
}

assert_allowed() {
    local payload=$1
    local output

    output=$(printf '%s' "$payload" | "$hook")
    [[ -z "$output" ]]
}

assert_denied '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/workspace/exercises/Agentic Workflows & Evaluation/README.md"}}'
assert_denied '{"hookEventName":"PreToolUse","toolName":"read_file","input":{"filePath":"/workspace/exercises/AGENTIC WORKFLOWS & EVALUATION/README.md"}}'
assert_denied '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"cat exercises/Agentic Workflows & Evaluation/README.md"}}'
assert_allowed '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/workspace/exercises/GitHub Copilot Customization 101/README.md"}}'
assert_allowed '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/workspace/README.md"}}'

printf 'restrict-exercises hook tests passed\n'