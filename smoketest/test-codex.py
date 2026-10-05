#!/usr/bin/env python3
"""Check that Codex transport logs preserve evidence for the existing grader."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from grade import load_stream, tool_calls, metrics, check, grade_scenario
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('codex_bench', Path(__file__).with_name('run-codex.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class CodexEvidenceTests(unittest.TestCase):
    def normalize(self, events, exit_code=0):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            raw, stream, report = [folder / name for name in ('raw.jsonl', 'stream.jsonl', 'report.txt')]
            raw.write_text('\n'.join(json.dumps(e) for e in events))
            report.write_text('A report grounded in tool responses.')
            thread, count, result = bench.normalize(raw, stream, report, 'configured-model', exit_code, 1.5)
            calls, meta = tool_calls(load_stream(stream))
            return thread, count, result, calls, meta

    def test_started_and_completed_call_is_counted_once(self):
        item = {'id': 'call_1', 'type': 'mcp_tool_call', 'server': 'patent', 'tool': 'search_patents',
                'arguments': {'query': 'ta="example"', 'count_only': True}, 'status': 'in_progress'}
        completed = dict(item, status='completed', result={'content': [{'type': 'text',
            'text': '{"totalCount":42,"_throttle":{"isOverloaded":true,"isThrottled":false}}'}]})
        thread, count, result, calls, _ = self.normalize([
            {'type': 'thread.started', 'thread_id': 'thread_1'},
            {'type': 'item.started', 'item': item}, {'type': 'item.completed', 'item': completed},
            {'type': 'turn.completed', 'usage': {'input_tokens': 100, 'output_tokens': 20}},
        ])
        self.assertEqual(thread, 'thread_1'); self.assertEqual(count, 1)
        self.assertEqual(calls[0]['input']['query'], 'ta="example"')
        self.assertFalse(calls[0]['is_error']); self.assertEqual(result['subtype'], 'success')
        measured, _ = metrics(calls)
        self.assertEqual(measured['overloaded_responses'], 1)
        self.assertEqual(measured['throttled_responses'], 0)
        self.assertIsNone(result['total_cost_usd'])

    def test_deferral_is_preserved_when_native_log_omits_is_error(self):
        _, _, _, calls, _ = self.normalize([
            {'type': 'item.completed', 'item': {'id': 'call_2', 'type': 'mcp_tool_call', 'server': 'patent',
                'tool': 'search_patents', 'arguments': {}, 'status': 'completed', 'result': {'content': [
                    {'type': 'text', 'text': '{"error":"ops_deferred","requestSent":false,"retryAfterSeconds":30}'}]}}},
            {'type': 'turn.completed'},
        ])
        self.assertTrue(calls[0]['is_error'])
        measured, _ = metrics(calls)
        self.assertEqual(measured['deferred_responses'], 1)
        self.assertEqual(measured['rate_limit_errors'], 0)

    def test_array_metadata_is_counted_without_changing_array_payload(self):
        measured, _ = metrics([{'name': 'get_patent_details', 'input': {}, 'is_error': False,
            'result': '[{"publicationNumber":"EP1000001"}]\n{"_throttle":{"isOverloaded":true}}\nGROUNDING: cite only returned data.'}])
        self.assertEqual(measured['overloaded_responses'], 1)

    def test_failed_cli_does_not_grade_as_success_and_other_servers_are_excluded(self):
        _, count, result, calls, _ = self.normalize([
            {'type': 'item.completed', 'item': {'id': 'other', 'type': 'mcp_tool_call', 'server': 'unrelated', 'tool': 'search'}},
            {'type': 'turn.completed'},
        ], exit_code=1)
        self.assertEqual(count, 0); self.assertEqual(calls, [])
        self.assertEqual(result['subtype'], 'error')

    def test_credit_exhaustion_is_preserved(self):
        _, _, result, _, _ = self.normalize([
            {'type': 'turn.failed', 'error': {'message': 'Your workspace is out of credits. Ask your workspace owner to refill.'}},
        ], exit_code=1)
        self.assertEqual(result['failure_reason'], 'workspace_credits_exhausted')

    def test_publication_assertion_accepts_greek_office(self):
        catalog = json.loads((Path(__file__).parent / 'scenarios.json').read_text())
        assertion = next(a for a in catalog['scenarios'][0]['ground_truth'] if a['type'] == 'report_regex_count_min')
        self.assertTrue(check(assertion, 'EP1000001 US1000002 WO1000003 CN1000004 GR1011236', [], [])[0])
        self.assertFalse(check(assertion, 'EP1000001 US1000002 WO1000003 CN1000004', [], [])[0])

    def test_retry_archives_failed_stage_and_preserves_success(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            success = {'subtype': 'success', 'thread_id': 'original-thread'}
            (output / 'case.task.json').write_text(json.dumps(success))
            self.assertEqual(bench.cached_stage(output, 'case', 'task', True), ('original-thread', success))
            (output / 'case.hallucination.json').write_text('{"subtype":"error"}')
            (output / 'case.hallucination.codex.jsonl').write_text('old evidence')
            self.assertIsNotNone(bench.cached_stage(output, 'case', 'hallucination', False))
            self.assertIsNone(bench.cached_stage(output, 'case', 'hallucination', True))
            self.assertEqual(next((output / 'attempts').glob('*/*.codex.jsonl')).read_text(), 'old evidence')
            self.assertEqual(json.loads((output / 'case.task.json').read_text()), success)

    def test_runner_stops_before_next_scenario_on_credit_exhaustion(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch('sys.argv', ['run-codex.py', '--results-dir', folder]), \
                 patch.object(bench, 'credentials', return_value={}), \
                 patch.object(bench.subprocess, 'check_output', return_value='test-commit'), \
                 patch.object(bench.subprocess, 'run'), \
                 patch.object(bench, 'run_stage', return_value=('thread', {'subtype': 'error', 'failure_reason': 'workspace_credits_exhausted'})) as stage:
                with self.assertRaises(SystemExit) as stopped: bench.main()
                self.assertEqual(stopped.exception.code, 2)
                self.assertEqual(stage.call_count, 1)

    def test_credit_blocked_task_does_not_fail_product_assertions(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / 'case.task.stream.jsonl').write_text(json.dumps({'type': 'result', 'subtype': 'error',
                'failure_reason': 'workspace_credits_exhausted'}) + '\n')
            result = grade_scenario(folder, {'id': 'case', 'ground_truth': [{'type': 'report_regex_all', 'patterns': ['required']}]})
            self.assertEqual(result['verdict'], 'blocked')
            self.assertEqual(result['assertions_total'], 0)

    def test_resume_runs_missing_grounding_without_repeating_successful_task(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / 'case.task.json').write_text('{"subtype":"success","thread_id":"original"}')
            (output / 'scenarios.json').write_text(json.dumps({'scenarios': [{'id': 'case', 'suite': 'holdout', 'prompt': 'task'}]}))
            with patch('sys.argv', ['run-codex.py', '--results-dir', folder]), \
                 patch.object(bench, 'credentials', return_value={}), \
                 patch.object(bench.subprocess, 'check_output', return_value='test-commit'), \
                 patch.object(bench.subprocess, 'run'), \
                 patch.object(bench, 'run_stage', return_value=('original', {'subtype': 'success'})) as stage:
                bench.main()
                self.assertEqual(stage.call_count, 1)
                self.assertEqual(stage.call_args.args[2], 'hallucination')
                self.assertEqual(stage.call_args.args[-1], 'original')


if __name__ == '__main__':
    unittest.main()
