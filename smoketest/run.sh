#!/usr/bin/env bash
set -euo pipefail

# ── Smoketest for ops-patent-search plugin ───────────────────────────────────────
# Each test runs three messages in the same conversation:
#   1. The task prompt — executed end-to-end
#   2. A hallucination check — verifies entities/counts from the response
#   3. A follow-up asking what should be improved about the MCP and tooling
#
# Usage:
#   ./smoketest/run.sh              # run all tests
#   ./smoketest/run.sh basic-search # run a single test
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PLUGIN_DIR/.env"
OUTPUT_DIR="$SCRIPT_DIR/results/$(date +%Y%m%d_%H%M%S)"
SINGLE_TEST="${1:-}"

FOLLOWUP_PROMPT="Now reflect on the task you just completed. Based on your experience using the MCP tools and skills in this session:

1. What worked well? Which tools and workflows were effective?
2. What failed or underperformed? (e.g. CQL queries that returned errors or unexpected results, tools that didn't return useful data, workflow steps that were inefficient)
3. What information was missing or hard to find? Were there gaps in tool coverage?
4. What specific improvements would you suggest for the MCP tools, tool descriptions, or skill workflows?
5. Were there any tool calls you wanted to make but couldn't, or parameters you wished existed?

Be concrete and specific — reference actual tool calls, error messages, and query strings from this session. This feedback will be used to improve the plugin."

HALLUCINATION_CHECK_PROMPT="I want you to check for each of the companies/entities/patents you mentioned if they really exist or if you hallucinated them. For each one, verify by searching the patent database again. Report a table with: entity name, claimed count, verified count, and whether the verification passed or failed."

ALLOWED_TOOLS="mcp__plugin_ops-patent-search_ops-patent-search__search_patents,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_details,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_claims,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_description,mcp__plugin_ops-patent-search_ops-patent-search__search_in_patent_text,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_family,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_legal_status,mcp__plugin_ops-patent-search_ops-patent-search__get_patent_citations,Read,Write,Edit,Grep,Glob,Bash,WebSearch,WebFetch,Skill,Agent"

# ── Load credentials ────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Create it with PATENT_CONSUMER_KEY and PATENT_CONSUMER_SECRET_KEY."
  exit 1
fi
set -a
source "$ENV_FILE"
set +a

if [[ -z "${PATENT_CONSUMER_KEY:-}" || -z "${PATENT_CONSUMER_SECRET_KEY:-}" ]]; then
  echo "ERROR: PATENT_CONSUMER_KEY and PATENT_CONSUMER_SECRET_KEY must be set in $ENV_FILE"
  exit 1
fi

# ── Verify Claude Code is available and authenticated ────────────────────────
if ! command -v claude &>/dev/null; then
  echo "ERROR: claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# ── Prepare output directory ────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
echo "Output directory: $OUTPUT_DIR"

# ── Helper: extract text result from stream-json ─────────────────────────────
extract_text() {
  local stream_file="$1"
  local text_file="$2"
  local json_file="$3"

  grep '"type":"result"' "$stream_file" | tail -1 > "$json_file" 2>/dev/null || true
  python3 -c "
import sys, json

# Try the result object first (present when conversation completes normally)
result_text = ''
for line in open('$json_file'):
    try:
        obj = json.loads(line)
        if obj.get('type') == 'result' and obj.get('result'):
            result_text = obj['result']
    except: pass

if result_text:
    print(result_text)
else:
    # Fallback: extract text from assistant messages (e.g. when max_turns hit)
    parts = []
    for line in open('$stream_file'):
        try:
            obj = json.loads(line)
            if obj.get('type') == 'assistant':
                for block in obj.get('message', {}).get('content', []):
                    if block.get('type') == 'text':
                        parts.append(block['text'])
        except: pass
    print('\n'.join(parts) if parts else '(no result)')
" > "$text_file" 2>/dev/null || true
}

# ── Define test cases ───────────────────────────────────────────────────────
# Each test: name|max_turns|max_budget|prompt
# Use 0 for max_turns or max_budget to leave them unlimited
#
# On max_turns: basic-search and keyword-search are the budget-constrained
# cases — they check that the tools let an agent finish a simple job without
# wandering. The original caps (3 and 4) were tuned against an earlier model
# and are below what the task actually needs: a 2026-09-08 run of basic-search
# hit the cap after 18 successful tool calls while still mid-task, discarding
# the result. The limits are now 8, which leaves room to finish while still
# failing an agent that flails. Cost is bounded by max_budget regardless, which
# is the real guard — raise turns before assuming a genuine efficiency problem.
TESTS=(
  "basic-search|8|2.00|Search for patents about CRISPR Cas9 gene editing. Use count_only=true first, then retrieve the top 5 results with detail_level=full. Report the publication numbers, titles, and applicants."
  "keyword-search|8|2.00|Get the bibliographic data for patent EP3401400, then search its full text for the keywords 'guide RNA' and 'Cas9'. Report the match count and show the first 3 context snippets."
  "prior-art-skill|0|0|Run a prior art search for: a bispecific antibody targeting both PD-1 and TIGIT for treatment of non-small cell lung cancer. Follow the prior-art-search skill workflow and produce the full structured prior art report."
  "fto-check|0|0|Perform a freedom-to-operate check for: an antibody-drug conjugate with a cleavable linker and a topoisomerase-I inhibitor payload. Follow the fto-analysis skill workflow and produce the full FTO risk report."
  "citation-network|0|0|Build a citation network starting from patent EP3401400. Get its backward citations, then check forward citations using the ct= CQL operator. Identify the most-cited patents. Follow the citation-network skill workflow and produce the full citation network report."
  "patent-landscape|0|0|Produce a patent landscape analysis for mRNA vaccine delivery using lipid nanoparticles. Follow the patent-landscape skill workflow. Map top applicants, filing trends by year, key technology sub-areas, and identify white spaces. Produce the full landscape report."
  "loe-analysis|0|0|Perform a loss-of-exclusivity analysis for Keytruda (pembrolizumab, Merck). Follow the loe-analysis skill workflow. Identify compound, formulation, and method-of-use patents. Check legal status and family coverage for US and EU markets. Produce the full LOE timeline and report."
  "landscape-doublecount|0|0|Give me an overview of patents filed in pan-RAS inhibition. Which are the companies active in the space? Which indications do they present data for? For each company, report the number of patent families and list the key patent numbers."
)

# ── Run tests ───────────────────────────────────────────────────────────────
PASS=0
FAIL=0
TOTAL=0

for test_entry in "${TESTS[@]}"; do
  IFS='|' read -r name max_turns max_budget prompt <<< "$test_entry"

  # Skip if single test requested and doesn't match
  if [[ -n "$SINGLE_TEST" && "$name" != "$SINGLE_TEST" ]]; then
    continue
  fi
  TOTAL=$((TOTAL + 1))

  # Build optional flags for the task message
  LIMIT_FLAGS=()
  if [[ "$max_turns" != "0" ]]; then
    LIMIT_FLAGS+=(--max-turns "$max_turns")
  fi
  if [[ "$max_budget" != "0" ]]; then
    LIMIT_FLAGS+=(--max-budget-usd "$max_budget")
  fi

  # Generate a unique session ID for this test
  SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "TEST: $name (max_turns=${max_turns:-unlimited}, budget=${max_budget:-unlimited})"
  echo "  Session: $SESSION_ID"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Message 1: Run the task ──────────────────────────────────────────────
  task_stream="$OUTPUT_DIR/${name}.task.stream.jsonl"
  task_text="$OUTPUT_DIR/${name}.task.txt"
  task_json="$OUTPUT_DIR/${name}.task.json"

  echo "  [1/3] Running task..."

  if CLAUDECODE= claude -p "$prompt" \
    --plugin-dir "$PLUGIN_DIR" \
    --allowedTools "$ALLOWED_TOOLS" \
    --output-format stream-json \
    --session-id "$SESSION_ID" \
    "${LIMIT_FLAGS[@]}" \
    --verbose \
    > "$task_stream" 2>&1; then

    extract_text "$task_stream" "$task_text" "$task_json"

    # Check if MCP tools were actually used
    mcp_calls=$(grep -c 'mcp__plugin_ops-patent-search' "$task_stream" 2>/dev/null || echo "0")

    if [[ "$mcp_calls" -gt 0 ]]; then
      echo "  PASS - $mcp_calls MCP tool calls made"
      echo "  Preview: $(head -c 300 "$task_text" 2>/dev/null)..."
      PASS=$((PASS + 1))
    else
      echo "  FAIL - No MCP tool calls detected (server likely not connected)"
      grep '"type":"system"' "$task_stream" | head -1 | python3 -c "
import sys, json
for line in sys.stdin:
    obj = json.loads(line)
    for s in obj.get('mcp_servers', []):
        if 'espacenet' in s.get('name',''):
            print(f\"    MCP: {s['name']} -> {s['status']}\")
" 2>/dev/null || true
      FAIL=$((FAIL + 1))
      continue  # skip follow-up if task failed
    fi
  else
    echo "  FAIL - Claude exited with error"
    FAIL=$((FAIL + 1))
    continue  # skip follow-up if task failed
  fi

  # ── Message 2: Hallucination check ─────────────────────────────────────
  hallu_stream="$OUTPUT_DIR/${name}.hallucination.stream.jsonl"
  hallu_text="$OUTPUT_DIR/${name}.hallucination.txt"
  hallu_json="$OUTPUT_DIR/${name}.hallucination.json"

  echo "  [2/3] Running hallucination check..."

  if CLAUDECODE= claude -p "$HALLUCINATION_CHECK_PROMPT" \
    --resume "$SESSION_ID" \
    --plugin-dir "$PLUGIN_DIR" \
    --allowedTools "$ALLOWED_TOOLS" \
    --output-format stream-json \
    --verbose \
    > "$hallu_stream" 2>&1; then

    extract_text "$hallu_stream" "$hallu_text" "$hallu_json"
    echo "  Hallucination check collected ($(wc -c < "$hallu_text" | tr -d ' ') bytes)"
  else
    echo "  WARN - Hallucination check failed (task result still valid)"
  fi

  # ── Message 3: Ask for feedback ────────────────────────────────────────
  feedback_stream="$OUTPUT_DIR/${name}.feedback.stream.jsonl"
  feedback_text="$OUTPUT_DIR/${name}.feedback.txt"
  feedback_json="$OUTPUT_DIR/${name}.feedback.json"

  echo "  [3/3] Collecting feedback..."

  if CLAUDECODE= claude -p "$FOLLOWUP_PROMPT" \
    --resume "$SESSION_ID" \
    --output-format stream-json \
    --max-turns 1 \
    --verbose \
    > "$feedback_stream" 2>&1; then

    extract_text "$feedback_stream" "$feedback_text" "$feedback_json"
    echo "  Feedback collected ($(wc -c < "$feedback_text" | tr -d ' ') bytes)"
  else
    echo "  WARN - Feedback collection failed (task result still valid)"
  fi
done

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "RESULTS: $PASS/$TOTAL passed, $FAIL failed"
echo "Output: $OUTPUT_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Files per test:"
echo "  *.task.txt          — task output"
echo "  *.hallucination.txt — entity/count verification results"
echo "  *.feedback.txt      — MCP/tooling improvement suggestions"
echo ""
ls -lh "$OUTPUT_DIR"/*.task.json 2>/dev/null || echo "(no results)"
