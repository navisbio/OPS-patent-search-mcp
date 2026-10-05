#!/usr/bin/env python3
"""Check that Codex transport logs preserve evidence for the existing grader."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from grade import load_stream, tool_calls, metrics

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


if __name__ == '__main__':
    unittest.main()
