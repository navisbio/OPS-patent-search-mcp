#!/usr/bin/env bash
set -euo pipefail

# ── Bench runner for the ops-patent-search plugin ─────────────────────────────
# Scenarios come from scenarios.json. Each runs as one headless Claude Code
# session with up to three messages:
#   1. the task, with the MCP tools and skills loaded
#   2. a grounding check: re-query every entity and count the report cited
#   3. a critique of the tools — dev suite only; hold-out scenarios are graded
#      and judged but their critiques are never collected, so the coding agent
#      cannot improve them by reading feedback
# Afterwards grade.py checks the ground-truth assertions and writes summary.json.
#
# Usage:
#   ./smoketest/run.sh                    # every scenario
#   ./smoketest/run.sh basic-search       # one scenario
# Environment:
#   SMOKETEST_MODEL=sonnet|opus|<id>      evaluator model (default: CLI default)
#   SMOKETEST_SUITE=all|dev|holdout       which scenarios (default all)
#   SMOKETEST_JUDGE=1                     run judge.py score after the bench
#   SMOKETEST_BASELINE=<results dir>      also run judge.py compare against it
#   SMOKETEST_FINDINGS=1                  run findings.py extract after the bench
#   SMOKETEST_JUDGE_MODEL=opus            model for judge and comparison
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PLUGIN_DIR/.env"
CATALOG="$SCRIPT_DIR/scenarios.json"
OUTPUT_DIR="$SCRIPT_DIR/results/$(date +%Y%m%d_%H%M%S)${SMOKETEST_MODEL:+_$SMOKETEST_MODEL}"
SINGLE_TEST="${1:-}"
SUITE="${SMOKETEST_SUITE:-all}"
MODEL="${SMOKETEST_MODEL:-}"
MODEL_FLAGS=()
if [[ -n "$MODEL" ]]; then MODEL_FLAGS+=(--model "$MODEL"); fi

FOLLOWUP_PROMPT="Now reflect on the task you just completed. Based on your experience using the MCP tools and skills in this session:

1. What worked well? Which tools and workflows were effective?
2. What failed or underperformed? (e.g. CQL queries that returned errors or unexpected results, tools that didn't return useful data, workflow steps that were inefficient)
3. What information was missing or hard to find? Were there gaps in tool coverage?
4. What specific improvements would you suggest for the MCP tools, tool descriptions, or skill workflows?
5. Were there any tool calls you wanted to make but couldn't, or parameters you wished existed?

Be concrete and specific — reference actual tool calls, error messages, and query strings from this session. This feedback will be used to improve the plugin.

Note: the patent-search MCP server is intentionally not loaded for this reflection message, so any system notice that its tools are unavailable or disconnected now is expected. Do not report it as an outage; judge the tools only on how they behaved while you were using them."

HALLUCINATION_CHECK_PROMPT="I want you to check for each of the companies/entities/patents you mentioned if they really exist or if you hallucinated them. For each one, verify by searching the patent database again. Report a table with: entity name, claimed count, verified count, and whether the verification passed or failed."

# Every registered tool must be listed here or the evaluator is blocked from it.
MCP_TOOLS=$(python3 - "$PLUGIN_DIR/src/index.ts" <<'EOF'
import re, sys
src = open(sys.argv[1]).read()
names = re.findall(r'server\.registerTool\(\s*\n\s*"([a-z_]+)"', src)
print(",".join("mcp__plugin_ops-patent-search_ops-patent-search__" + n for n in names))
EOF
)
ALLOWED_TOOLS="$MCP_TOOLS,Read,Write,Edit,Grep,Glob,Bash,WebSearch,WebFetch,Skill,Agent"

# ── Credentials and CLI ──────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Create it with PATENT_CONSUMER_KEY and PATENT_CONSUMER_SECRET_KEY."; exit 1
fi
set -a; source "$ENV_FILE"; set +a
if [[ -z "${PATENT_CONSUMER_KEY:-}" || -z "${PATENT_CONSUMER_SECRET_KEY:-}" ]]; then
  echo "ERROR: PATENT_CONSUMER_KEY and PATENT_CONSUMER_SECRET_KEY must be set in $ENV_FILE"; exit 1
fi
if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"; exit 1
fi
if [[ ! -f "$PLUGIN_DIR/dist/index.js" ]]; then
  echo "ERROR: $PLUGIN_DIR/dist/index.js missing. Run npm run build first."; exit 1
fi

mkdir -p "$OUTPUT_DIR"
echo "Output directory: $OUTPUT_DIR"
cp "$CATALOG" "$OUTPUT_DIR/scenarios.json"   # the catalog as it was when this run happened
git -C "$PLUGIN_DIR" rev-parse HEAD 2>/dev/null > "$OUTPUT_DIR/git-commit.txt" || true

# Run the evaluator from a scratch directory outside the repo. Anywhere inside
# the repo (the results dir included) makes Claude Code load the repo's .mcp.json
# as a project server too; its ${CLAUDE_PLUGIN_ROOT} path only expands under
# --plugin-dir, so that copy dies with CONNECTION_CLOSED and every critique
# reported a phantom outage. A scratch cwd also keeps the repo's hooks and
# CLAUDE.md out of the evaluator's context.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ops-smoketest.XXXXXX")"
cd "$WORK_DIR"

# ── Helper: extract the final text from a stream-json file ───────────────────
extract_text() {
  local stream_file="$1" text_file="$2" json_file="$3"
  grep '"type":"result"' "$stream_file" | tail -1 > "$json_file" 2>/dev/null || true
  python3 - "$stream_file" "$json_file" <<'EOF' > "$text_file" 2>/dev/null || true
import sys, json
stream, resfile = sys.argv[1], sys.argv[2]
result_text = ''
for line in open(resfile):
    try:
        obj = json.loads(line)
        if obj.get('type') == 'result' and obj.get('result'):
            result_text = obj['result']
    except Exception:
        pass
if result_text:
    print(result_text)
else:
    parts = []
    for line in open(stream):
        try:
            obj = json.loads(line)
            if obj.get('type') == 'assistant':
                for block in obj.get('message', {}).get('content', []):
                    if block.get('type') == 'text':
                        parts.append(block['text'])
        except Exception:
            pass
    print('\n'.join(parts) if parts else '(no result)')
EOF
}

# ── Scenarios from the catalog ───────────────────────────────────────────────
# One line per scenario: id|suite|max_turns|max_budget|base64(prompt)
SCENARIOS=$(python3 - "$CATALOG" "$SUITE" "$SINGLE_TEST" <<'EOF'
import json, sys, base64
cat, suite, single = json.load(open(sys.argv[1]))["scenarios"], sys.argv[2], sys.argv[3]
for s in cat:
    if single and s["id"] != single: continue
    if suite != "all" and s.get("suite", "dev") != suite: continue
    print("|".join([s["id"], s.get("suite", "dev"), str(s.get("max_turns", 0)), str(s.get("max_budget_usd", 0)),
                    base64.b64encode(s["prompt"].encode()).decode()]))
EOF
)
if [[ -z "$SCENARIOS" ]]; then echo "No scenarios match (suite=$SUITE, test=$SINGLE_TEST)"; exit 1; fi

PASS=0; FAIL=0; TOTAL=0
while IFS='|' read -r name suite max_turns max_budget prompt_b64; do
  [[ -z "$name" ]] && continue
  prompt=$(printf '%s' "$prompt_b64" | base64 -d)
  TOTAL=$((TOTAL + 1))
  LIMIT_FLAGS=()
  if [[ "$max_turns" != "0" ]]; then LIMIT_FLAGS+=(--max-turns "$max_turns"); fi
  if [[ "$max_budget" != "0" && "$max_budget" != "0.0" ]]; then LIMIT_FLAGS+=(--max-budget-usd "$max_budget"); fi
  SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $name [$suite] (max_turns=${max_turns}, budget=${max_budget})"
  echo "  Session: $SESSION_ID"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Message 1: the task ──────────────────────────────────────────────────
  task_stream="$OUTPUT_DIR/${name}.task.stream.jsonl"
  echo "  [1/3] Running task..."
  if CLAUDECODE= claude -p "$prompt" \
      --plugin-dir "$PLUGIN_DIR" --allowedTools "$ALLOWED_TOOLS" --output-format stream-json \
      --session-id "$SESSION_ID" "${MODEL_FLAGS[@]}" "${LIMIT_FLAGS[@]}" --verbose > "$task_stream" 2>&1; then
    extract_text "$task_stream" "$OUTPUT_DIR/${name}.task.txt" "$OUTPUT_DIR/${name}.task.json"
    mcp_calls=$(grep -c 'mcp__plugin_ops-patent-search' "$task_stream" 2>/dev/null || echo "0")
    if [[ "$mcp_calls" -gt 0 ]]; then
      echo "  ran - $mcp_calls MCP tool calls"; PASS=$((PASS + 1))
    else
      echo "  FAIL - no MCP tool calls (server not connected?)"; FAIL=$((FAIL + 1)); continue
    fi
  else
    echo "  FAIL - claude exited with error"; FAIL=$((FAIL + 1)); continue
  fi

  # ── Message 2: grounding check ───────────────────────────────────────────
  hallu_stream="$OUTPUT_DIR/${name}.hallucination.stream.jsonl"
  echo "  [2/3] Grounding check..."
  if CLAUDECODE= claude -p "$HALLUCINATION_CHECK_PROMPT" --resume "$SESSION_ID" \
      --plugin-dir "$PLUGIN_DIR" --allowedTools "$ALLOWED_TOOLS" --output-format stream-json \
      "${MODEL_FLAGS[@]}" --verbose > "$hallu_stream" 2>&1; then
    extract_text "$hallu_stream" "$OUTPUT_DIR/${name}.hallucination.txt" "$OUTPUT_DIR/${name}.hallucination.json"
    echo "  collected ($(wc -c < "$OUTPUT_DIR/${name}.hallucination.txt" | tr -d ' ') bytes)"
  else
    echo "  WARN - grounding check failed"
  fi

  # ── Message 3: critique (dev suite only) ─────────────────────────────────
  if [[ "$suite" == "holdout" ]]; then
    echo "  [3/3] Critique skipped (hold-out scenario)"
    continue
  fi
  feedback_stream="$OUTPUT_DIR/${name}.feedback.stream.jsonl"
  echo "  [3/3] Collecting critique..."
  if CLAUDECODE= claude -p "$FOLLOWUP_PROMPT" --resume "$SESSION_ID" --output-format stream-json \
      "${MODEL_FLAGS[@]}" --max-turns 1 --verbose > "$feedback_stream" 2>&1; then
    extract_text "$feedback_stream" "$OUTPUT_DIR/${name}.feedback.txt" "$OUTPUT_DIR/${name}.feedback.json"
    echo "  collected ($(wc -c < "$OUTPUT_DIR/${name}.feedback.txt" | tr -d ' ') bytes)"
  else
    echo "  WARN - critique failed"
  fi
done <<< "$SCENARIOS"

# ── Grade, judge, extract ────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RAN: $PASS/$TOTAL scenarios completed with tool calls, $FAIL failed to run"
python3 "$SCRIPT_DIR/grade.py" "$OUTPUT_DIR"
if [[ "${SMOKETEST_JUDGE:-0}" == "1" ]]; then
  python3 "$SCRIPT_DIR/judge.py" score "$OUTPUT_DIR"
fi
if [[ -n "${SMOKETEST_BASELINE:-}" ]]; then
  python3 "$SCRIPT_DIR/judge.py" compare "$SMOKETEST_BASELINE" "$OUTPUT_DIR"
fi
if [[ "${SMOKETEST_FINDINGS:-0}" == "1" ]]; then
  python3 "$SCRIPT_DIR/findings.py" extract "$OUTPUT_DIR"
fi
echo ""
echo "Output: $OUTPUT_DIR"
echo "  <case>.task.txt / .hallucination.txt / .feedback.txt   evaluator output"
echo "  <case>.grade.json, summary.json                          ground-truth grades and metrics"
echo "  <case>.judge.json / .pairwise.json / .findings.json      when judge and findings were run"
