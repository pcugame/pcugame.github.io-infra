#!/usr/bin/env python3
"""Exact CD candidate layout must never replace the live startup helper."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent


class InstalledHelper(unittest.TestCase):
    def test_candidate_copy_is_separate_from_installed_runtime_helper(self):
        for failure in ('', 'missing', 'changed', 'nonexecutable', 'symlink', 'futurecandidate', 'samefile'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='quadlet layout %$ ') as temporary:
                root = Path(temporary)
                candidate = root / 'quadlet'
                candidate.mkdir()
                # This models Deploy Release copying its selected source before guard.
                for name in ('check-installed.py','wait-network-ready.py'):
                    shutil.copy2(HERE / name, candidate / name)
                runtime = root / 'runtime-helpers'
                runtime.mkdir()
                helper = runtime / 'wait-network-ready.py'
                shutil.copy2(HERE / helper.name, helper)
                original = helper.read_bytes()
                expected, installed = root / 'expected', root / 'units'
                environment = {'PATH':os.environ['PATH'], 'HOME':str(root), 'XDG_CONFIG_HOME':str(root/'config'),
                    'XDG_RUNTIME_DIR':str(root/'run'), 'PYTHONDONTWRITEBYTECODE':'1', 'DEPLOY_DIR':str(root),
                    'API_IMAGE':'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:'+'a'*64}
                result = subprocess.run(['bash',str(HERE/'render.sh'),str(expected)],env=environment,capture_output=True,text=True)
                self.assertEqual(result.returncode,0)
                shutil.copytree(expected,installed)
                if failure == 'missing': helper.unlink()
                elif failure == 'changed': helper.write_text('private-modified-fixture')
                elif failure == 'nonexecutable': helper.chmod(0o600)
                elif failure == 'symlink':
                    helper.unlink()
                    helper.symlink_to(candidate/helper.name)
                elif failure == 'futurecandidate':
                    (candidate/helper.name).write_bytes(original+b'\n# future candidate change\n')
                elif failure == 'samefile':
                    helper.unlink()
                    os.link(candidate/helper.name,helper)
                result = subprocess.run([sys.executable,str(candidate/'check-installed.py'),str(expected),str(installed)],env=environment,capture_output=True,text=True)
                self.assertEqual(result.returncode == 0,not bool(failure))
                self.assertNotIn('private-modified-fixture',result.stdout+result.stderr)
                if failure == 'futurecandidate':
                    # Guard failed without copying candidate bytes over live runtime.
                    self.assertEqual(helper.read_bytes(),original)
                for path in expected.iterdir():
                    self.assertEqual(path.read_bytes(),(installed/path.name).read_bytes())


if __name__ == '__main__': unittest.main()
