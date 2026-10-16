import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('proxy', Path(__file__).with_name('pcu-api-proxy.py'))
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class ProxyTest(unittest.TestCase):
    def test_rejects_arbitrary_arguments_before_any_command(self):
        with patch.object(proxy, 'command') as command:
            for args in [[], ['switch', 'c'], ['switch', 'a', '/tmp/input'], ['reload'], ['check', '-c', '/tmp/input']]:
                with self.assertRaises(ValueError): proxy.main(args)
            command.assert_not_called()

    def test_failed_validation_restores_disk_without_reload(self):
        with tempfile.TemporaryDirectory() as root:
            upstream = Path(root) / 'upstream.conf'
            old = 'upstream pcu_api_active { server 127.0.0.1:4000; }\n'
            upstream.write_text(old)
            def command(*args):
                if '-t' in args: raise RuntimeError('invalid nginx config')
                self.fail('unexpected command')
            with patch.object(proxy, 'UPSTREAM', upstream), patch.object(proxy, 'LOCK', Path(root) / 'lock'), patch.object(proxy, 'status', return_value={'slot': 'a'}), patch.object(proxy, 'command', side_effect=command):
                with self.assertRaises(RuntimeError): proxy.main(['switch', 'b'])
            self.assertEqual(upstream.read_text(), old)

    def test_reload_failure_keeps_intended_slot_for_explicit_resume(self):
        with tempfile.TemporaryDirectory() as root:
            upstream = Path(root) / 'upstream.conf'
            upstream.write_text('upstream pcu_api_active { server 127.0.0.1:4000; }')
            def command(*args):
                if '-s' in args: raise RuntimeError('reload failed')
                return ''
            with patch.object(proxy, 'UPSTREAM', upstream), patch.object(proxy, 'LOCK', Path(root) / 'lock'), patch.object(proxy, 'status', return_value={'slot': 'a'}), patch.object(proxy, 'command', side_effect=command):
                with self.assertRaises(RuntimeError): proxy.main(['switch', 'b'])
            self.assertIn('127.0.0.1:4001', upstream.read_text())


if __name__ == '__main__': unittest.main()
