import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from common import encode_example, load_dataset, sha, write


class Template:
    """Byte-level fixture distinguishes tokens in sources from supervised tokens."""
    def apply_chat_template(self, messages, tokenize, add_generation_prompt):
        text = ''.join(f'<{m["role"]}>{m["content"]}</end>' for m in messages)
        if add_generation_prompt:
            text += '<assistant>'
        return list(text.encode())


class MaskingTests(unittest.TestCase):
    def test_unavailable_or_wrong_backend_never_falls_back_to_cpu(self):
        from hardware import require_gpu
        for probe in ({'ok': False}, {'ok': True, 'hip': None, 'bf16': True}):
            with patch('hardware.probe_isolated', return_value=probe):
                with self.assertRaisesRegex(RuntimeError, 'no CPU fallback'):
                    require_gpu({'backend': 'rocm', 'precision': 'bf16'}, '.')

    def test_only_assistant_json_and_ending_receive_loss(self):
        row = {'messages': [{'role': 'system', 'content': 'policy'},
                            {'role': 'user', 'content': '{"sources":["TOOL_TEXT"]}'},
                            {'role': 'assistant', 'content': '{"action":"finish"}'}]}
        tokens = encode_example(Template(), row, 1000)
        supervised = bytes(t for t in tokens['labels'] if t != -100).decode()
        self.assertEqual(supervised, '{"action":"finish"}</end>')
        self.assertNotIn('TOOL_TEXT', supervised)
        self.assertEqual(len(tokens['labels']), len(tokens['input_ids']))

    def test_long_evidence_is_rejected_not_truncated(self):
        row = {'messages': [{'role': 'system', 'content': 'policy'}, {'role': 'user', 'content': 'x' * 100},
                            {'role': 'assistant', 'content': '{}'}]}
        with self.assertRaisesRegex(ValueError, 'never truncate'):
            encode_example(Template(), row, 50)

    def test_eval_and_smoke_cannot_enter_normal_training(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'train.jsonl').write_text(json.dumps({'messages': [
                {'role': 'system', 'content': 's'}, {'role': 'user', 'content': 'u'},
                {'role': 'assistant', 'content': '{}'}]}) + '\n')
            metadata = {'version': 'nickname-sft-v1', 'split': 'train', 'smokeOnly': True,
                        'trainSha256': sha(p / 'train.jsonl'), 'rows': [{}]}
            write(p / 'manifest.json', metadata)
            with self.assertRaisesRegex(ValueError, 'cannot be interchanged'):
                load_dataset(p)
            self.assertEqual(len(load_dataset(p, smoke=True)[0]), 1)
            metadata['split'] = 'test'
            write(p / 'manifest.json', metadata)
            with self.assertRaisesRegex(ValueError, 'Only prepared train'):
                load_dataset(p, smoke=True)

    def test_changed_dataset_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory)
            (p / 'train.jsonl').write_text('{}\n')
            write(p / 'manifest.json', {'version': 'nickname-sft-v1', 'split': 'train', 'smokeOnly': False,
                                       'trainSha256': '0' * 64, 'rows': [{}]})
            with self.assertRaisesRegex(ValueError, 'hash changed'):
                load_dataset(p)

    def test_exclusive_artifacts_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'registry.json'
            write(p, {'kind': 'base'}, exclusive=True)
            with self.assertRaises(FileExistsError):
                write(p, {'kind': 'adapter'}, exclusive=True)


if __name__ == '__main__':
    unittest.main()
