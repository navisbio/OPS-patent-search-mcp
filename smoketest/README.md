# Bench

A bench of realistic patent-analysis tasks, run by a headless Claude Code
evaluator against the live server, with three independent measures of the
result: deterministic ground-truth assertions, a separate judge model, and a
recurrence index of findings across runs. The evaluator's own critique is kept
as a bug-report generator. It is not the measure of whether a report is good,
because it praises what it used and cannot see the errors that matter most,
such as a ranking built on a 25-result sample or a landscape that missed the
major filers.

## Files

| File | Role |
|---|---|
| `scenarios.json` | The catalog: prompt, turn and cost caps, suite (`dev` or `holdout`), ground-truth assertions. |
| `run.sh` | Runs the scenarios, then `grade.py`; optionally the judge and findings extraction. |
| `grade.py` | Deterministic grader: metrics from the tool stream plus the catalog's assertions. Writes `<case>.grade.json` and `summary.json`. |
| `judge.py` | Separate model scores each report from the task, the compact tool log and the report only. `score` for absolute rubric scores, `compare` for pairwise A/B between two runs. |
| `findings.py` | Turns critiques and judge output into findings with stable keys, keeps `findings-index.json`, reports recurrence and regressions. |
| `results/<timestamp>[_model]/` | One directory per run, gitignored. Contains the catalog snapshot and commit hash the run used. |

## Running

```bash
npm run build
./smoketest/run.sh                                      # all scenarios, grade only
SMOKETEST_MODEL=sonnet ./smoketest/run.sh               # choose the evaluator model
SMOKETEST_SUITE=dev ./smoketest/run.sh                  # dev or holdout only
SMOKETEST_JUDGE=1 SMOKETEST_FINDINGS=1 ./smoketest/run.sh
SMOKETEST_BASELINE=smoketest/results/<previous run> SMOKETEST_JUDGE=1 ./smoketest/run.sh

python3 smoketest/grade.py smoketest/results/<run>                    # re-grade after editing assertions
python3 smoketest/judge.py score smoketest/results/<run> [--scenario id]
python3 smoketest/judge.py compare smoketest/results/<baseline> smoketest/results/<candidate>
python3 smoketest/findings.py extract smoketest/results/<run>
python3 smoketest/findings.py report --min-runs 2
python3 smoketest/findings.py resolve <key> --status fixed --fixed-in <run id>
```

A full run of nine scenarios costs about $7 with Sonnet as the evaluator and
takes about 35 minutes; the judge adds about $4 with Opus; findings extraction
about $1. Run scenarios sequentially: EPO OPS enforces its quota per minute
and parallel runs share it.

## What each layer measures

**Grader.** Facts that must hold regardless of live data drift: a known filer
present in a landscape, the parent PCT found in a citation network, a fake
number reported as unresolved by the tool rather than given a title, a
required tool actually called, no applicant counts from a partial summary
published as a ranking. It also counts tool errors, oversized results,
throttled responses and numbers reported missing. A scenario passes when it
completed, made tool calls, and every assertion holds.

**Judge.** Correctness, coverage, grounding, method and efficiency, each 1 to
5 with written anchors, plus critical issues with quoted evidence and
findings for the tool set. The judge never sees the agent's reasoning or its
critique. In `compare` mode the two reports are shown in random order and the
judge picks a winner with a confidence; a fix has helped when the candidate
wins more scenarios than it loses.

**Findings index.** Every critique and judge output is reduced to findings
with a key such as `get_patent_details.not_found_silent`. The extractor
reuses a known key when the issue is the same, so `findings.py report` shows
how many runs each finding appeared in, in how many scenarios, and whether it
returned after being marked fixed. Praise is kept as a separate category: a
fixed issue that turns into praise is the confirmation the fix landed.

**Hold-out scenarios.** Two scenarios are tagged `holdout`. They run, get
graded and judged, but their critiques are not collected. Improvement on them
therefore cannot come from reading their feedback.

## The fix protocol

This is the part that made the September 2026 rerun work and that a person
must not skip when acting on bench output.

1. Read `summary.json` and the judge tables before any critique. Failed
   assertions and P1 judge issues come first.
2. Run `findings.py report --min-runs 2`. A finding that recurs across runs
   outranks one raised once, whatever its stated severity.
3. For every bug-shaped finding, reproduce it against the live API before
   touching code. Write a small script that calls the tool with the exact
   inputs from the stream. Of the bug-shaped findings in the first September
   run, two did not reproduce as described and one had a different cause than
   the critique proposed.
4. Classify each finding: product bug, description gap, workflow gap,
   feature request, external limitation, harness artifact, agent error. Only
   the first three produce code or text changes in the same cycle. File the
   rest as issues.
5. Fix, rebuild, run `npm test`, and re-run the reproduction script.
6. Re-run the bench with `SMOKETEST_BASELINE` set to the previous run. A
   round is done when the failed assertions pass, the candidate wins or ties
   the pairwise comparison, and the fixed findings appear as praise or not at
   all. Mark them with `findings.py resolve`.
7. File a beads issue per fix with the run id, the scenario, the evidence
   and the reproduction, so the next session does not rediscover it.

## Writing scenarios

A scenario earns its place when it is a task a user would really ask, when it
exercises more than one tool, and when at least one fact about its answer is
stable over months. Put that fact in `ground_truth`. Never assert exact live
counts, applicant order, or anything that a newly published patent could
change. Write prompts that say what "top", "key" or "main" means, or the
evaluator will choose the reading the tool makes easiest, and the finding
will look like a tool defect.
