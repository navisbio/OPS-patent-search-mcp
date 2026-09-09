#!/usr/bin/env python3
"""Structured findings with stable keys, and recurrence across runs.

Free-text critiques cannot be counted. This turns each scenario's critique and
judge output into findings with a stable key (reused across runs when the
underlying issue is the same), records every occurrence in an index, and
reports which keys keep coming back, which were marked fixed, and which
returned after a fix.

  findings.py extract <results_dir> [--model sonnet] [--scenario id] [--force]
  findings.py report  [--min-runs 1] [--status open|fixed|all]
  findings.py resolve <key> --status fixed|wontfix|external [--note text]

Index: smoketest/findings-index.json (committed). Per-run output:
<case>.findings.json.
"""
import argparse, json, os, subprocess, sys, tempfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
FALLBACK_MODEL = os.environ.get("SMOKETEST_FALLBACK_MODEL", "sonnet")
INDEX_DEFAULT = os.path.join(HERE, "findings-index.json")

EXTRACT_PROMPT = """You turn an AI agent's critique of a patent-search tool set, plus a judge's findings on the same session, into a deduplicated list of findings with stable keys.

Rules:
- One finding per distinct underlying issue. Merge repeats within the text.
- key: if a KNOWN KEY names the same underlying issue, reuse it exactly. Otherwise mint a new key of the form <tool>.<snake_case_concept>, tool being one of search_patents, get_patent_details, get_patent_claims, get_patent_description, search_in_patent_text, search_and_filter_fulltext, get_patent_family, get_patent_legal_status, get_patent_citations, skill, harness, ops (the upstream EPO service), none. Keys describe the issue, not the session: "get_patent_details.not_found_silent" not "get_patent_details.us8354509_missing".
- category: product_bug (the server returned wrong or unusable data), description_gap (the tool worked but its description misled), feature_request, workflow_gap (the skill guidance or the agent's method), external_limitation (EPO OPS data or quota), harness_artifact (the test harness, not the product), agent_error (the agent's own mistake, no product change implied), praise (something that worked; keep these, they show a fix landed).
- severity: P1 blocks a correct answer, P2 degrades it, P3 friction, none for praise.
- evidence: a short quote from the source text with the concrete call, number or error.
- source: critique, judge, or both.
Skip vague statements with no concrete evidence. Skip requests for tools outside a patent database (registries, literature search) unless the text shows they caused an error in the report."""

SCHEMA = {
    "type": "object",
    "properties": {"findings": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "tool": {"type": "string"}, "category": {"type": "string"},
        "title": {"type": "string"}, "evidence": {"type": "string"},
        "severity": {"type": "string", "enum": ["P1", "P2", "P3", "none"]},
        "source": {"type": "string", "enum": ["critique", "judge", "both"]}},
        "required": ["key", "tool", "category", "title", "evidence", "severity", "source"]}}},
    "required": ["findings"],
}


def load_index(path):
    return json.load(open(path)) if os.path.exists(path) else {"_doc": "Finding keys across bench runs. Edit status with findings.py resolve.", "keys": {}}


def save_index(path, idx):
    json.dump(idx, open(path, "w"), indent=1, sort_keys=True)


def run_claude(prompt, system, schema, model):
    with tempfile.TemporaryDirectory() as cwd:
        cmd = ["claude", "-p", prompt, "--system-prompt", system, "--model", model, "--output-format", "json",
               "--json-schema", json.dumps(schema), "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--max-turns", "2"]
        out = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=dict(os.environ, CLAUDECODE=""))
    try:
        o = json.loads(out.stdout)
    except json.JSONDecodeError:
        return None, f"non-JSON: {out.stdout[:200]} {out.stderr[:200]}", 0.0, model
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


def extract(args):
    d = args.results_dir.rstrip("/")
    run_id = os.path.basename(d)
    idx = load_index(args.index)
    ids = sorted({f.split(".")[0] for f in os.listdir(d) if f.endswith(".task.stream.jsonl")})
    total = 0.0
    for sid in ids:
        if args.scenario and sid != args.scenario:
            continue
        out_path = f"{d}/{sid}.findings.json"
        if os.path.exists(out_path) and not args.force:
            continue
        critique_path, judge_path = f"{d}/{sid}.feedback.txt", f"{d}/{sid}.judge.json"
        critique = open(critique_path).read() if os.path.exists(critique_path) else ""
        judge = json.load(open(judge_path)) if os.path.exists(judge_path) else None
        if not critique and not judge:
            continue
        known = "\n".join(f"- {k}: {v['title']}" for k, v in sorted(idx["keys"].items()))
        judge_txt = json.dumps({"critical_issues": judge["critical_issues"], "findings": judge["findings"]}, indent=1) if judge else "(no judge output)"
        prompt = (f"KNOWN KEYS (reuse when the issue is the same):\n{known or '(none yet)'}\n\n"
                  f"SCENARIO: {sid}\n\nAGENT CRITIQUE:\n{critique[:40000] or '(not collected; hold-out scenario)'}\n\nJUDGE OUTPUT:\n{judge_txt[:20000]}")
        so, err, cost, used = run_claude(prompt, EXTRACT_PROMPT, SCHEMA, args.model)
        total += cost
        if err:
            print(f"  {sid}: extraction failed: {err}", file=sys.stderr)
            continue
        findings = so["findings"]
        json.dump({"run": run_id, "scenario": sid, "model": used, "cost_usd": cost, "findings": findings}, open(out_path, "w"), indent=1)
        for f in findings:
            e = idx["keys"].setdefault(f["key"], {"title": f["title"], "tool": f["tool"], "category": f["category"],
                                                  "status": "open", "first_seen": run_id, "occurrences": []})
            if not any(o["run"] == run_id and o["scenario"] == sid for o in e["occurrences"]):
                e["occurrences"].append({"run": run_id, "scenario": sid, "severity": f["severity"], "source": f["source"], "category": f["category"]})
            e["last_seen"] = run_id
            if f["category"] != "praise" and e.get("category") == "praise":
                e["category"] = f["category"]
        print(f"  {sid}: {len(findings)} findings  (${cost:.2f})")
    save_index(args.index, idx)
    print(f"index: {len(idx['keys'])} keys   extraction cost ${total:.2f}")


def report(args):
    idx = load_index(args.index)
    rows = []
    for k, e in idx["keys"].items():
        occ = [o for o in e["occurrences"] if o.get("category") != "praise"]
        praise = [o for o in e["occurrences"] if o.get("category") == "praise"]
        runs = sorted({o["run"] for o in occ})
        if len(runs) < args.min_runs:
            continue
        if args.status != "all" and e.get("status", "open") != args.status:
            continue
        sev = min((o["severity"] for o in occ if o["severity"] != "none"), default="none")
        regression = e.get("status") == "fixed" and e.get("fixed_in") and any(r > e["fixed_in"] for r in runs)
        rows.append((len(runs), sev, k, e, runs, len({o["scenario"] for o in occ}), len({o["run"] for o in praise}), regression))
    rows.sort(key=lambda r: (-r[0], r[1], r[2]))
    print(f"{'runs':4} {'sev':4} {'scen':4} {'praise':6} {'status':8} key")
    for n, sev, k, e, runs, nscen, npraise, regression in rows:
        flag = "  REGRESSION" if regression else ""
        print(f"{n:4} {sev:4} {nscen:4} {npraise:6} {e.get('status', 'open'):8} {k}{flag}")
        print(f"{'':30} {e['title'][:110]}   [{', '.join(r[:15] for r in runs[-3:])}]")


def resolve(args):
    idx = load_index(args.index)
    e = idx["keys"].get(args.key)
    if not e:
        sys.exit(f"unknown key {args.key}")
    e["status"] = args.status
    if args.status == "fixed":
        e["fixed_in"] = args.fixed_in or date.today().strftime("%Y%m%d_000000")
    if args.note:
        e["note"] = args.note
    save_index(args.index, idx)
    print(f"{args.key}: {args.status}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=INDEX_DEFAULT)
    sub = ap.add_subparsers(dest="cmd", required=True)
    x = sub.add_parser("extract"); x.add_argument("results_dir"); x.add_argument("--model", default=os.environ.get("SMOKETEST_FINDINGS_MODEL", "sonnet"))
    x.add_argument("--scenario"); x.add_argument("--force", action="store_true")
    r = sub.add_parser("report"); r.add_argument("--min-runs", type=int, default=1); r.add_argument("--status", default="all")
    v = sub.add_parser("resolve"); v.add_argument("key"); v.add_argument("--status", required=True, choices=["open", "fixed", "wontfix", "external"])
    v.add_argument("--fixed-in", help="run id (results dir name) of the first run after the fix; defaults to today"); v.add_argument("--note")
    args = ap.parse_args()
    {"extract": extract, "report": report, "resolve": resolve}[args.cmd](args)


if __name__ == "__main__":
    main()
