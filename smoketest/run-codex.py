#!/usr/bin/env python3
"""Run the unchanged scenario catalog with Codex and the local MCP server."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PREFIX = 'mcp__plugin_ops-patent-search_ops-patent-search__'
GROUNDING = ('Check each company/entity/patent and count mentioned in your report by querying the patent MCP again. '
             'Report a table with entity name, claimed count, verified count, and verification passed/failed/unknown. '
             'Respect retryAfterSeconds, preserve partial results, and distinguish publications from families.')
CRITIQUE = ('Reflect on the completed task: what worked, what failed, missing information, and specific improvements '
            'to tools or skill workflows. Reference actual calls and responses. Do not make further tool calls.')


def configured_model():
    settings = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
    return tomllib.loads(settings.read_text()).get('model') if settings.exists() else None


def credentials():
    # Parse dotenv with Node; captured output is never logged or written to results.
    script = 'console.log(JSON.stringify({PATENT_CONSUMER_KEY:process.env.PATENT_CONSUMER_KEY,PATENT_CONSUMER_SECRET_KEY:process.env.PATENT_CONSUMER_SECRET_KEY}))'
    out = subprocess.run(['node', f'--env-file={ROOT / ".env"}', '-e', script], capture_output=True, text=True, check=True)
    values = json.loads(out.stdout)
    if not all(values.get(k) for k in ('PATENT_CONSUMER_KEY', 'PATENT_CONSUMER_SECRET_KEY')):
        raise RuntimeError('Missing OPS credentials')
    return dict(os.environ, **values)


def config_args(model):
    instructions = (f'You are evaluating patent tools, not editing code. Use only the patent MCP for patent facts. '
                    f'Workflow skills are available as readable files in {ROOT / "skills"}; load the relevant SKILL.md '
                    'when the task requests a skill, and follow its references. Do not read repository code, tests, '
                    'scenario assertions, or prior results. Work independently from the supplied task; do not ask '
                    'clarifying questions. Call MCP tools sequentially. Follow deferral/retry instructions and retain '
                    'partial results. Do not fabricate text or numbers. Return a self-contained final report.')
    args = ['--ignore-user-config', '--skip-git-repo-check', '--json',
            '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
            '-c', 'web_search="disabled"', '-c', 'features.multi_agent=false',
            '-c', 'mcp_servers.patent.command="node"',
            '-c', 'mcp_servers.patent.args=' + json.dumps([str(ROOT / 'dist/index.js')]),
            '-c', 'mcp_servers.patent.env_vars=["PATENT_CONSUMER_KEY","PATENT_CONSUMER_SECRET_KEY"]',
            '-c', 'developer_instructions=' + json.dumps(instructions)]
    if model:
        args += ['--model', model]
    return args


def normalize(raw_path, stream_path, report_path, model, returncode, duration):
    events, thread, usage, calls, seen, turns, completed = [], None, {}, 0, set(), 0, False
    events.append({'type': 'system', 'subtype': 'init', 'model': model, 'evaluator': 'codex'})
    for line in raw_path.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get('type')
        if kind == 'thread.started':
            thread = event.get('thread_id')
        if kind == 'turn.completed':
            usage = event.get('usage', {}); turns += 1; completed = True
        item = event.get('item', {})
        if item.get('type') == 'mcp_tool_call' and item.get('server') == 'patent':
            ident = item['id']
            if ident not in seen:
                seen.add(ident); calls += 1
                arguments = item.get('arguments') or {}
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                events.append({'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': ident,
                               'name': PREFIX + item['tool'], 'input': arguments}]}})
            if kind == 'item.completed':
                result = item.get('result') or {}
                if isinstance(result, dict):
                    text = '\n'.join(c.get('text', '') for c in result.get('content', []) if isinstance(c, dict))
                    failed = result.get('isError', result.get('is_error', False)) or item.get('status') == 'failed' or bool(item.get('error'))
                    try:
                        payload = json.JSONDecoder().raw_decode(text.lstrip())[0]
                        failed = failed or (isinstance(payload, dict) and payload.get('error') in ('rate_limited', 'ops_deferred'))
                    except ValueError:
                        pass
                else:
                    text, failed = str(result), bool(item.get('error'))
                if item.get('error'):
                    text += '\nError: ' + str(item['error'])
                events.append({'type': 'user', 'message': {'content': [{'type': 'tool_result',
                               'tool_use_id': ident, 'content': text, 'is_error': failed}]}})
    report = report_path.read_text() if report_path.exists() else ''
    result = {'type': 'result', 'subtype': 'success' if returncode == 0 and completed and report else 'error',
              'result': report, 'num_turns': turns, 'duration_ms': round(duration * 1000),
              'total_cost_usd': None, 'usage': usage, 'evaluator': 'codex', 'exit_code': returncode}
    events.append(result)
    stream_path.write_text(''.join(json.dumps(e) + '\n' for e in events))
    return thread, calls, result


def run_stage(output, sid, stage, prompt, model, env, cwd, timeout, thread=None):
    raw = output / f'{sid}.{stage}.codex.jsonl'
    report = output / f'{sid}.{stage}.txt'
    cmd = ['codex', 'exec'] + (['resume', thread] if thread else []) + config_args(model)
    cmd += ['--output-last-message', str(report), '-']
    started = time.monotonic()
    with raw.open('w') as stdout, (output / f'{sid}.{stage}.stderr.log').open('w') as stderr:
        proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr)
        proc.stdin.write(prompt.encode()); proc.stdin.close()
        next_progress = started + 30
        while proc.poll() is None:
            elapsed = time.monotonic() - started
            if elapsed > timeout:
                proc.terminate()
                try: proc.wait(timeout=10)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
                break
            if time.monotonic() >= next_progress:
                print(f'  {sid}: {stage} running ({int(elapsed)}s)', flush=True)
                next_progress += 30
            time.sleep(1)
    thread, calls, result = normalize(raw, output / f'{sid}.{stage}.stream.jsonl', report, model,
                                      proc.returncode, time.monotonic() - started)
    (output / f'{sid}.{stage}.json').write_text(json.dumps(result, indent=2))
    print(f'  {stage}: {result["subtype"]}, {calls} MCP calls, {int(time.monotonic()-started)}s', flush=True)
    return thread, result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scenario')
    ap.add_argument('--results-dir', type=Path)
    ap.add_argument('--model', default=os.environ.get('SMOKETEST_MODEL') or configured_model())
    ap.add_argument('--stage-timeout', type=int, default=900)
    args = ap.parse_args()
    if not (ROOT / 'dist/index.js').exists():
        raise SystemExit('Run npm run build before the bench')
    catalog = json.loads((HERE / 'scenarios.json').read_text())
    selected = [s for s in catalog['scenarios'] if not args.scenario or s['id'] == args.scenario]
    if not selected: raise SystemExit('Unknown scenario')
    output = (args.results_dir or HERE / 'results' / (datetime.datetime.now().strftime('%Y%m%d_%H%M%S') + '_codex')).resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot = output / 'scenarios.json'
    if not snapshot.exists(): shutil.copyfile(HERE / 'scenarios.json', snapshot)
    else:
        catalog = json.loads(snapshot.read_text())
        selected = [s for s in catalog['scenarios'] if not args.scenario or s['id'] == args.scenario]
    (output / 'git-commit.txt').write_text(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True))
    (output / 'harness.json').write_text(json.dumps({'evaluator': 'codex', 'model': args.model,
        'stage_timeout_seconds': args.stage_timeout, 'catalog_turn_and_dollar_caps': 'not supported by Codex CLI; wall-time cap applies',
        'cost_reporting': 'Codex CLI exposes token usage but no dollar cost'}, indent=2))
    print(f'Output directory: {output}', flush=True)
    env = credentials()
    with tempfile.TemporaryDirectory(prefix='ops-codex-bench-') as cwd:
        for sc in selected:
            sid = sc['id']
            if (output / f'{sid}.task.json').exists():
                print(f'SKIP existing scenario: {sid}', flush=True); continue
            print(f'TEST: {sid} [{sc["suite"]}]', flush=True)
            thread, result = run_stage(output, sid, 'task', sc['prompt'], args.model, env, cwd, args.stage_timeout)
            if result['subtype'] != 'success' or not thread: continue
            run_stage(output, sid, 'hallucination', GROUNDING, args.model, env, cwd, args.stage_timeout, thread)
            if sc['suite'] != 'holdout':
                run_stage(output, sid, 'feedback', CRITIQUE, args.model, env, cwd, args.stage_timeout, thread)
            subprocess.run(['python3', str(HERE / 'grade.py'), str(output), '--quiet'], check=True)
    subprocess.run(['python3', str(HERE / 'grade.py'), str(output)], check=True)


if __name__ == '__main__':
    main()
