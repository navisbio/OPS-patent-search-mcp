#!/usr/bin/env python3
"""Deterministic grader for one smoketest results directory.

Reads each scenario's tool-call stream and final report, computes metrics that
need no judgement (tool calls, errors, oversized results, throttling, missing
numbers, partial summaries) and checks the ground-truth assertions from
scenarios.json. Writes <case>.grade.json per scenario and summary.json for
the run, and prints a table.

Usage: grade.py <results_dir> [--catalog smoketest/scenarios.json] [--quiet]
"""
import argparse, json, os, re, sys, glob, collections

PREFIX = "mcp__plugin_ops-patent-search_ops-patent-search__"
HERE = os.path.dirname(os.path.abspath(__file__))


def load_stream(path):
    events = []
    with open(path) as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return events


def tool_calls(events):
    """Return [{name, input, result, is_error}] for plugin tool calls, plus meta."""
    pending, calls, meta = {}, [], {"model": None, "result": None}
    for o in events:
        t = o.get("type")
        if t == "system" and o.get("subtype") == "init":
            meta["model"] = o.get("model")
        elif t == "assistant":
            for b in o.get("message", {}).get("content", []) or []:
                if b.get("type") == "tool_use" and str(b.get("name", "")).startswith(PREFIX):
                    c = {"name": b["name"][len(PREFIX):], "input": b.get("input") or {}, "result": "", "is_error": False}
                    pending[b["id"]] = c
                    calls.append(c)
        elif t == "user":
            content = o.get("message", {}).get("content")
            if isinstance(content, list):
                for b in content:
                    if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                        c = pending[b["tool_use_id"]]
                        raw = b.get("content")
                        text = raw if isinstance(raw, str) else " ".join(x.get("text", "") for x in (raw or []) if isinstance(x, dict))
                        c["result"] = text
                        c["is_error"] = bool(b.get("is_error")) or text.startswith("Error:")
        elif t == "result":
            meta["result"] = o
    return calls, meta


def result_json(text):
    """First JSON object in a tool result (results carry a note and grounding footer after it)."""
    try:
        return json.JSONDecoder().raw_decode(text.lstrip())[0]
    except Exception:
        return None


def metrics(calls):
    m = collections.Counter()
    by_tool = collections.Counter()
    overflow = throttled = 0
    not_found, partial_summaries = [], []
    for c in calls:
        by_tool[c["name"]] += 1
        if c["is_error"]:
            m["errors"] += 1
        if "exceeds maximum allowed tokens" in c["result"][:400]:
            overflow += 1
        j = result_json(c["result"])
        if isinstance(j, dict):
            th = j.get("_throttle") or {}
            if th.get("isThrottled") or (th.get("quota", {}).get("search", {}).get("status") == "red"):
                throttled += 1
            if isinstance(j.get("notFound"), list) and j["notFound"]:
                not_found.extend(j["notFound"])
            if c["name"] == "search_patents" and c["input"].get("detail_level") == "summary":
                total, analyzed = j.get("totalCount"), j.get("analyzedCount")
                if isinstance(total, int) and isinstance(analyzed, int) and analyzed < total and not c["input"].get("auto_paginate"):
                    partial_summaries.append({"query": c["input"].get("query"), "totalCount": total, "analyzedCount": analyzed,
                                              "topApplicants": j.get("topApplicants") or []})
    return {
        "tool_calls": len(calls), "calls_by_tool": dict(by_tool), "tool_errors": m["errors"],
        "oversized_results": overflow, "throttled_responses": throttled,
        "not_found_numbers": not_found, "partial_summary_calls": len(partial_summaries),
    }, partial_summaries


def grounding_counts(path):
    if not os.path.exists(path):
        return None
    t = open(path).read()
    return {"pass": len(re.findall(r"\b(PASS|Pass)\b|✅", t)), "fail": len(re.findall(r"\b(FAIL|Fail)\b|❌", t))}


# ── assertions ────────────────────────────────────────────────────────────

def check(a, report, calls, partial_summaries):
    t = a["type"]
    rx = lambda p: re.compile(p, re.I | re.M)
    if t == "stream_tool_called":
        for c in calls:
            if c["name"] == a["tool"] and (not a.get("input_contains") or a["input_contains"] in json.dumps(c["input"])):
                return True, f"{a['tool']} called"
        return False, f"{a['tool']} not called" + (f" with {a['input_contains']}" if a.get("input_contains") else "")
    if t == "report_regex_all":
        missing = [p for p in a["patterns"] if not rx(p).search(report)]
        return (not missing), ("all present" if not missing else f"missing: {missing}")
    if t == "report_regex_any":
        hit = [p for p in a["patterns"] if rx(p).search(report)]
        return bool(hit), (f"matched {hit[0]}" if hit else "none of the patterns matched")
    if t == "report_regex_none":
        hit = [p for p in a["patterns"] if rx(p).search(report)]
        return (not hit), ("none present" if not hit else f"forbidden pattern present: {hit[0]}")
    if t == "report_regex_count_min":
        n = len(set(m.group(0) for m in rx(a["pattern"]).finditer(report)))
        return n >= a["min"], f"{n} distinct matches (min {a['min']})"
    if t == "report_regex_min_matches":
        hit = [p for p in a["patterns"] if rx(p).search(report)]
        return len(hit) >= a["min"], f"{len(hit)} of {len(a['patterns'])} present (min {a['min']}): {[h.split('|')[0] for h in hit]}"
    if t == "stream_notfound_includes":
        for c in calls:
            j = result_json(c["result"])
            if isinstance(j, dict) and a["number"] in (j.get("notFound") or []):
                return True, f"{a['number']} in a notFound list"
            if isinstance(j, dict) and j.get("found") is False and j.get("documentNumber") == a["number"]:
                return True, f"{a['number']} returned found=false"
        return False, f"no tool response reported {a['number']} as not found"
    if t == "stream_no_partial_summary_published":
        published = []
        for ps in partial_summaries:
            for ap in ps["topApplicants"][:15]:
                name, count = str(ap.get("name", "")), ap.get("count")
                if not name or not isinstance(count, int) or count < 2:
                    continue
                stem = re.escape(name.split()[0])
                if re.search(stem + r"[^\n]{0,60}\b" + str(count) + r"\b", report, re.I):
                    published.append(f"{name}={count}")
        if len(published) >= 3:
            return False, f"applicant counts from a {partial_summaries[0]['analyzedCount']}/{partial_summaries[0]['totalCount']} sample appear in the report: {published[:4]}"
        return True, ("no partial summary calls" if not partial_summaries else "partial summary fetched but its counts were not published")
    return False, f"unknown assertion type {t}"


def grade_scenario(d, sc):
    sid = sc["id"]
    stream = f"{d}/{sid}.task.stream.jsonl"
    if not os.path.exists(stream):
        return None
    calls, meta = tool_calls(load_stream(stream))
    report_path = f"{d}/{sid}.task.txt"
    report = open(report_path).read() if os.path.exists(report_path) else ""
    mets, partial = metrics(calls)
    r = meta["result"] or {}
    assertions = []
    for a in sc.get("ground_truth", []):
        ok, detail = check(a, report, calls, partial)
        assertions.append({"type": a["type"], "why": a.get("why"), "pass": ok, "detail": detail})
    g = {
        "scenario": sid, "suite": sc.get("suite", "dev"), "model": meta["model"],
        "status": r.get("subtype"), "turns": r.get("num_turns"), "cost_usd": r.get("total_cost_usd"),
        "duration_s": round((r.get("duration_ms") or 0) / 1000),
        "metrics": mets, "grounding": grounding_counts(f"{d}/{sid}.hallucination.txt"),
        "assertions": assertions,
        "assertions_passed": sum(1 for a in assertions if a["pass"]), "assertions_total": len(assertions),
        "report_chars": len(report),
    }
    g["verdict"] = ("pass" if g["assertions_passed"] == g["assertions_total"] and mets["tool_calls"] > 0 and r.get("subtype") == "success"
                    else "fail")
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results_dir")
    ap.add_argument("--catalog", default=os.path.join(HERE, "scenarios.json"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    d = args.results_dir.rstrip("/")
    catalog = json.load(open(args.catalog))["scenarios"]
    grades = []
    for sc in catalog:
        g = grade_scenario(d, sc)
        if g is None:
            continue
        grades.append(g)
        json.dump(g, open(f"{d}/{sc['id']}.grade.json", "w"), indent=1)
    summary = {
        "results_dir": os.path.basename(d), "scenarios": len(grades),
        "passed": sum(1 for g in grades if g["verdict"] == "pass"),
        "cost_usd": round(sum(g["cost_usd"] or 0 for g in grades), 2),
        "tool_calls": sum(g["metrics"]["tool_calls"] for g in grades),
        "tool_errors": sum(g["metrics"]["tool_errors"] for g in grades),
        "oversized_results": sum(g["metrics"]["oversized_results"] for g in grades),
        "throttled_responses": sum(g["metrics"]["throttled_responses"] for g in grades),
        "assertions_passed": sum(g["assertions_passed"] for g in grades),
        "assertions_total": sum(g["assertions_total"] for g in grades),
        "grounding_pass": sum((g["grounding"] or {}).get("pass", 0) for g in grades),
        "grounding_fail": sum((g["grounding"] or {}).get("fail", 0) for g in grades),
        "per_scenario": {g["scenario"]: {"verdict": g["verdict"], "assertions": f"{g['assertions_passed']}/{g['assertions_total']}",
                                         "errors": g["metrics"]["tool_errors"], "cost": g["cost_usd"]} for g in grades},
    }
    json.dump(summary, open(f"{d}/summary.json", "w"), indent=1)
    if args.quiet:
        return
    print(f"\nGRADES for {summary['results_dir']}")
    print(f"{'scenario':22} {'suite':8} {'verdict':7} {'assert':7} {'calls':5} {'errs':4} {'big':3} {'thr':3} {'ground':9} {'cost':6}")
    for g in grades:
        gr = g["grounding"] or {}
        print(f"{g['scenario']:22} {g['suite']:8} {g['verdict']:7} {g['assertions_passed']}/{g['assertions_total']:<5} "
              f"{g['metrics']['tool_calls']:5} {g['metrics']['tool_errors']:4} {g['metrics']['oversized_results']:3} "
              f"{g['metrics']['throttled_responses']:3} {gr.get('pass', 0):4}/{gr.get('fail', 0):<4} {g['cost_usd'] or 0:6.2f}")
        for a in g["assertions"]:
            if not a["pass"]:
                print(f"    FAIL {a['type']}: {a['detail']}  ({a['why']})")
    print(f"TOTAL: {summary['passed']}/{summary['scenarios']} scenarios pass, assertions {summary['assertions_passed']}/{summary['assertions_total']}, "
          f"errors {summary['tool_errors']}, oversized {summary['oversized_results']}, throttled {summary['throttled_responses']}, "
          f"grounding {summary['grounding_pass']}/{summary['grounding_fail']}, cost ${summary['cost_usd']}")


if __name__ == "__main__":
    main()
