#!/usr/bin/env python3
"""Score smoke reports in fresh Codex contexts using the existing judge rubric."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import time
from judge import RUBRIC, SCORE_SCHEMA, compact_log, load_case
import importlib.util
spec = importlib.util.spec_from_file_location('codex_bench', Path(__file__).with_name('run-codex.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def strict_schema(value):
    if isinstance(value, dict):
        value = {k: strict_schema(v) for k, v in value.items()}
        if value.get('type') == 'object':
            value['additionalProperties'] = False
            value['required'] = list(value.get('properties', {}))
    elif isinstance(value, list):
        value = [strict_schema(v) for v in value]
    return value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('results_dir', type=Path)
    ap.add_argument('--scenario')
    ap.add_argument('--model', default=bench.configured_model())
    args = ap.parse_args()
    output = args.results_dir.resolve()
    catalog = json.loads((output / 'scenarios.json').read_text())['scenarios']
    for sc in catalog:
        sid = sc['id']
        if args.scenario and sid != args.scenario: continue
        target = output / f'{sid}.judge.json'
        if target.exists() or not (output / f'{sid}.task.stream.jsonl').exists(): continue
        case = load_case(str(output), sid, catalog)
        prompt = f"TASK: {case['task']}\n\nTOOL LOG:\n{compact_log(case['calls'])}\n\nREPORT:\n{case['report'][:60000]}"
        with tempfile.TemporaryDirectory(prefix='ops-codex-judge-') as cwd:
            schema = Path(cwd) / 'schema.json'
            schema.write_text(json.dumps(strict_schema(SCORE_SCHEMA)))
            report = output / f'{sid}.judge.response.json'
            cmd = ['codex', 'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral', '--json',
                   '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
                   '-c', 'web_search="disabled"', '-c', 'features.multi_agent=false',
                   '-c', 'developer_instructions=' + json.dumps(RUBRIC + '\nDo not use tools; judge only the supplied evidence.'),
                   '--output-schema', str(schema), '--output-last-message', str(report), '-']
            if args.model: cmd[2:2] = ['--model', args.model]
            print(f'JUDGE: {sid}', flush=True)
            with (output / f'{sid}.judge.codex.jsonl').open('w') as stdout, (output / f'{sid}.judge.stderr.log').open('w') as stderr:
                result = subprocess.run(cmd, input=prompt, text=True, cwd=cwd, stdout=stdout, stderr=stderr, timeout=600)
            if result.returncode or not report.exists(): raise RuntimeError(f'{sid}: Codex judge failed; inspect local logs')
            data = json.loads(report.read_text())
            data.update({'scenario': sid, 'judge_model': args.model, 'judged_model': case['model'],
                         'judge_cost_usd': None, 'judge_evaluator': 'codex'})
            target.write_text(json.dumps(data, indent=2))
            print(f"  overall={data['overall']} correctness={data['correctness']} grounding={data['grounding']} issues={len(data['critical_issues'])}", flush=True)


if __name__ == '__main__':
    main()
