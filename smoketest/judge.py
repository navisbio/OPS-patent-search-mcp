#!/usr/bin/env python3
"""Separate judge for smoketest runs.

The evaluator's own critique is a bug-report generator, not a measure of
whether the report is any good: it praises what it used and cannot see the
errors that matter most (a ranking built on a 25-result sample, a landscape
that missed the major filers). This judge is a different model call that sees
only the task, the compact tool-call log and the final report, never the
agent's reasoning or its self-critique, and scores against a rubric.

  judge.py score   <results_dir> [--model opus] [--scenario id] [--force]
  judge.py compare <baseline_dir> <candidate_dir> [--model opus] [--scenario id]

score writes <case>.judge.json; compare writes <case>.pairwise.json into the
candidate directory. Both print a table. Order in compare is randomised per
scenario so position bias cannot decide a tie.
"""
import argparse, json, os, random, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FALLBACK_MODEL = os.environ.get("SMOKETEST_FALLBACK_MODEL", "sonnet")
sys.path.insert(0, HERE)
from grade import load_stream, tool_calls, result_json  # noqa: E402

LOG_BUDGET = 45000

RUBRIC = """You are grading a patent-analysis report produced by an AI agent that used a set of patent-database tools. You see the task, a compact log of every tool call the agent made (name, input, and a compact view of what came back), and the final report. You do not see the agent's reasoning. Judge only from this evidence.

Score each dimension 1-5 with these anchors:
- correctness: 5 = every number, ranking and status in the report is traceable to a tool result that covered the whole relevant set; 3 = numbers are real but at least one table or ranking was built from a partial sample, a wrong-scope query, or an inferred status without saying so; 1 = a central conclusion rests on a query that did not measure what it claims.
- coverage: 5 = the obvious major players, patents or facts for this task are present and cross-checked with at least one independent query (classification, applicant, family); 3 = plausible but built on a single keyword query with no cross-check; 1 = a major, well-known player or the key patent for the task is missing.
- grounding: 5 = every patent number, name and count in the report appears in a tool result; 3 = one or two facts have no source in the log (corporate parentage, drug names, dates); 1 = several unsourced facts or a fabricated number.
- method: 5 = the workflow fits the task (sized queries first, family and legal status where they matter, claims read where scope matters), and limitations are stated specifically; 3 = a required step was skipped or a limitation glossed; 1 = the approach could not have answered the question.
- efficiency: 5 = few wasted calls, batch tools used where available, no duplicate queries; 3 = some redundant or failed calls; 1 = large parts of the budget spent on calls that produced nothing used in the report.
- overall: your single-number judgement of whether a patent professional could rely on this report, 1-5.

critical_issues: the specific defects that lower the scores, each with the evidence from the log or report (quote the query, the numbers, the sentence). Empty if none.

findings: what the tool set or the workflow guidance should change so that this class of defect cannot recur. Each finding has tool (one of: search_patents, get_patent_details, get_patent_claims, get_patent_description, search_in_patent_text, search_and_filter_fulltext, get_patent_family, get_patent_legal_status, get_patent_citations, skill, harness, none), category (product_bug, description_gap, feature_request, workflow_gap, external_limitation), a short title, evidence, and severity (P1 blocks correct answers, P2 degrades them, P3 friction). Do not report the absence of tools you can see the agent never needed. Do not report speculative improvements; report only what the evidence shows went wrong or would have gone wrong.

How to read the log: it is compacted. For arrays only the first item is shown in full; the other items were returned too. Every field name a tool returned is listed, so a fact is unsourced only if no returned field could carry it (for example a corporate parent, a drug name, or a citation category when the citation records have no category field). Do not call a name or date unsourced merely because it is not the one visible in the first item.

Be exact and terse. Quote evidence. Do not praise."""

SCORE_SCHEMA = {
    "type": "object",
    "properties": {
        "correctness": {"type": "integer", "minimum": 1, "maximum": 5},
        "coverage": {"type": "integer", "minimum": 1, "maximum": 5},
        "grounding": {"type": "integer", "minimum": 1, "maximum": 5},
        "method": {"type": "integer", "minimum": 1, "maximum": 5},
        "efficiency": {"type": "integer", "minimum": 1, "maximum": 5},
        "overall": {"type": "integer", "minimum": 1, "maximum": 5},
        "summary": {"type": "string"},
        "critical_issues": {"type": "array", "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "evidence": {"type": "string"}, "severity": {"type": "string", "enum": ["P1", "P2", "P3"]}},
            "required": ["title", "evidence", "severity"]}},
        "findings": {"type": "array", "items": {"type": "object", "properties": {
            "tool": {"type": "string"}, "category": {"type": "string"}, "title": {"type": "string"},
            "evidence": {"type": "string"}, "severity": {"type": "string", "enum": ["P1", "P2", "P3"]}},
            "required": ["tool", "category", "title", "evidence", "severity"]}},
    },
    "required": ["correctness", "coverage", "grounding", "method", "efficiency", "overall", "summary", "critical_issues", "findings"],
}

COMPARE_PROMPT = """You are comparing two patent-analysis reports, A and B, written by AI agents for the same task with the same tools. You see the task, each agent's compact tool-call log, and each report. Decide which report a patent professional should prefer. Weigh correctness of numbers and rankings (were they measured on the full relevant set?), coverage of the players and patents that matter, grounding of every fact in a tool result, and honesty about limitations. Length and polish do not count. If the reports are equally good or equally flawed, say tie. Give confidence from 0.5 (coin flip) to 1.0 (certain) and the decisive reasons with quoted evidence."""

COMPARE_SCHEMA = {
    "type": "object",
    "properties": {
        "winner": {"type": "string", "enum": ["A", "B", "tie"]},
        "confidence": {"type": "number", "minimum": 0.5, "maximum": 1.0},
        "reasons": {"type": "array", "items": {"type": "string"}},
        "a_strengths": {"type": "array", "items": {"type": "string"}},
        "b_strengths": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["winner", "confidence", "reasons"],
}


def _record_view(rec, value_len=90):
    """One record rendered with every field name kept and each value truncated,
    so the judge can see which fields the tool returned even when the values
    are long. Fields must never be dropped: a judge that cannot see a field
    concludes the tool did not return it."""
    out = {}
    for k, v in rec.items():
        if isinstance(v, list):
            out[k] = f"[{len(v)} items] " + json.dumps(v[:3])[:value_len]
        elif isinstance(v, dict):
            out[k] = json.dumps(v)[:value_len]
        else:
            sv = str(v)
            out[k] = sv if len(sv) <= value_len else sv[:value_len] + "…"
    return out


def _list_view(v):
    if not v:
        return "[0 items]"
    if isinstance(v[0], dict):
        return f"[{len(v)} items, every item has fields {sorted(v[0].keys())}; item 1: {json.dumps(_record_view(v[0]))}]"
    return f"[{len(v)} items] " + json.dumps(v[:8])[:300]


def compact_result(text, limit):
    j = result_json(text)
    if isinstance(j, dict):
        keep = {}
        for k, v in j.items():
            if k == "_throttle":
                continue
            if isinstance(v, (int, float, bool, str)) or v is None:
                sv = str(v)
                keep[k] = v if len(sv) <= 300 else sv[:300] + "…"
            elif isinstance(v, list):
                if k in ("notFound", "topApplicants", "topJurisdictions", "spcStates", "activeStates", "lapsedStates", "keyEvents", "spcOrPteDetails"):
                    keep[k] = v[:12]
                else:
                    keep[k] = _list_view(v)
            elif isinstance(v, dict):
                keep[k] = json.dumps(v)[:400]
        s = json.dumps(keep)
    elif isinstance(j, list):
        s = _list_view(j)
    else:
        s = text.strip()
    return s[:limit]


def compact_log(calls, budget=LOG_BUDGET):
    per = max(300, min(900, budget // max(1, len(calls))))
    lines = []
    for i, c in enumerate(calls, 1):
        inp = json.dumps(c["input"])[:400]
        res = ("ERROR " if c["is_error"] else "") + compact_result(c["result"], per)
        lines.append(f"#{i} {c['name']} {inp}\n   -> {res}")
    return "\n".join(lines)


def run_claude(prompt, system, schema, model):
    with tempfile.TemporaryDirectory() as cwd:
        cmd = ["claude", "-p", prompt, "--system-prompt", system, "--model", model, "--output-format", "json",
               "--json-schema", json.dumps(schema), "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "2"]
        env = dict(os.environ, CLAUDECODE="")
        out = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=env)
    try:
        o = json.loads(out.stdout)
    except json.JSONDecodeError:
        return None, f"non-JSON output: {out.stdout[:300]} {out.stderr[:300]}", 0.0, model
    so = o.get("structured_output")
    if so is None:
        try:
            so = json.loads(o.get("result") or "")
        except Exception:
            msg = str(o.get("result"))
            # The model's safety layer occasionally refuses an ordinary patent
            # report (a CRISPR biblio triggered it once). Retry once on a
            # different model rather than losing the scenario.
            if "safeguards" in msg and model != FALLBACK_MODEL:
                return run_claude(prompt, system, schema, FALLBACK_MODEL)
            return None, f"no structured output: {msg[:300]}", o.get("total_cost_usd", 0.0), model
    return so, None, o.get("total_cost_usd", 0.0), model


def load_case(d, sid, catalog):
    stream = f"{d}/{sid}.task.stream.jsonl"
    if not os.path.exists(stream):
        return None
    calls, meta = tool_calls(load_stream(stream))
    report_path = f"{d}/{sid}.task.txt"
    report = open(report_path).read() if os.path.exists(report_path) else ""
    task = next((s["prompt"] for s in catalog if s["id"] == sid), "")
    return {"calls": calls, "report": report, "task": task, "model": meta["model"]}


def score(args, catalog):
    d = args.results_dir.rstrip("/")
    ids = [s["id"] for s in catalog if os.path.exists(f"{d}/{s['id']}.task.stream.jsonl") and (not args.scenario or s["id"] == args.scenario)]
    total_cost = 0.0
    rows = []
    for sid in ids:
        out_path = f"{d}/{sid}.judge.json"
        if os.path.exists(out_path) and not args.force:
            j = json.load(open(out_path))
            rows.append((sid, j, "cached"))
            continue
        case = load_case(d, sid, catalog)
        prompt = (f"TASK GIVEN TO THE AGENT:\n{case['task']}\n\nTOOL-CALL LOG ({len(case['calls'])} calls):\n{compact_log(case['calls'])}\n\n"
                  f"FINAL REPORT:\n{case['report'][:60000]}")
        j, err, cost, used = run_claude(prompt, RUBRIC, SCORE_SCHEMA, args.model)
        total_cost += cost
        if err:
            print(f"  {sid}: judge failed: {err}", file=sys.stderr)
            continue
        j.update({"scenario": sid, "judge_model": used, "judged_model": case["model"], "judge_cost_usd": cost})
        json.dump(j, open(out_path, "w"), indent=1)
        rows.append((sid, j, "new"))
    print(f"\nJUDGE ({args.model}) for {os.path.basename(d)}   judge cost ${total_cost:.2f}")
    print(f"{'scenario':22} {'corr':4} {'cov':4} {'grnd':4} {'meth':4} {'eff':4} {'all':4} {'P1':2} {'P2':2}  summary")
    for sid, j, _ in rows:
        p1 = sum(1 for c in j["critical_issues"] if c["severity"] == "P1")
        p2 = sum(1 for c in j["critical_issues"] if c["severity"] == "P2")
        print(f"{sid:22} {j['correctness']:4} {j['coverage']:4} {j['grounding']:4} {j['method']:4} {j['efficiency']:4} {j['overall']:4} {p1:2} {p2:2}  {j['summary'][:90]}")
    if rows:
        avg = lambda k: sum(j[k] for _, j, _ in rows) / len(rows)
        print(f"{'MEAN':22} {avg('correctness'):4.1f} {avg('coverage'):4.1f} {avg('grounding'):4.1f} {avg('method'):4.1f} {avg('efficiency'):4.1f} {avg('overall'):4.1f}")


def compare(args, catalog):
    a_dir, b_dir = args.baseline_dir.rstrip("/"), args.candidate_dir.rstrip("/")
    ids = [s["id"] for s in catalog if os.path.exists(f"{a_dir}/{s['id']}.task.stream.jsonl") and os.path.exists(f"{b_dir}/{s['id']}.task.stream.jsonl")
           and (not args.scenario or s["id"] == args.scenario)]
    total_cost = 0.0
    tally = {"baseline": 0, "candidate": 0, "tie": 0}
    print(f"\nPAIRWISE ({args.model}) baseline={os.path.basename(a_dir)} candidate={os.path.basename(b_dir)}")
    for sid in ids:
        ca, cb = load_case(a_dir, sid, catalog), load_case(b_dir, sid, catalog)
        swap = random.random() < 0.5  # A shown first is the candidate when swap is True
        first, second = (cb, ca) if swap else (ca, cb)
        half = LOG_BUDGET // 2
        prompt = (f"TASK:\n{ca['task']}\n\n=== REPORT A ===\nTOOL LOG A ({len(first['calls'])} calls):\n{compact_log(first['calls'], half)}\n\nREPORT A:\n{first['report'][:35000]}\n\n"
                  f"=== REPORT B ===\nTOOL LOG B ({len(second['calls'])} calls):\n{compact_log(second['calls'], half)}\n\nREPORT B:\n{second['report'][:35000]}")
        j, err, cost, used = run_claude(prompt, COMPARE_PROMPT, COMPARE_SCHEMA, args.model)
        total_cost += cost
        if err:
            print(f"  {sid}: compare failed: {err}", file=sys.stderr)
            continue
        label = {"A": "candidate" if swap else "baseline", "B": "baseline" if swap else "candidate", "tie": "tie"}[j["winner"]]
        tally[label] += 1
        rec = {"scenario": sid, "baseline": os.path.basename(a_dir), "candidate": os.path.basename(b_dir), "winner": label,
               "confidence": j["confidence"], "reasons": j["reasons"], "shown_first": "candidate" if swap else "baseline",
               "judge_model": used, "judge_cost_usd": cost}
        json.dump(rec, open(f"{b_dir}/{sid}.pairwise.json", "w"), indent=1)
        print(f"  {sid:22} winner={label:9} conf={j['confidence']:.2f}  {j['reasons'][0][:110] if j['reasons'] else ''}")
    print(f"TALLY: candidate {tally['candidate']}, baseline {tally['baseline']}, tie {tally['tie']}   judge cost ${total_cost:.2f}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score"); s.add_argument("results_dir"); s.add_argument("--model", default=os.environ.get("SMOKETEST_JUDGE_MODEL", "opus"))
    s.add_argument("--scenario"); s.add_argument("--force", action="store_true")
    c = sub.add_parser("compare"); c.add_argument("baseline_dir"); c.add_argument("candidate_dir")
    c.add_argument("--model", default=os.environ.get("SMOKETEST_JUDGE_MODEL", "opus")); c.add_argument("--scenario")
    ap.add_argument("--catalog", default=os.path.join(HERE, "scenarios.json"))
    args = ap.parse_args()
    catalog = json.load(open(args.catalog))["scenarios"]
    (score if args.cmd == "score" else compare)(args, catalog)


if __name__ == "__main__":
    main()
