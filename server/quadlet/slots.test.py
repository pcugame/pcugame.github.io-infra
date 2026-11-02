import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from generator_checks import select_generator, generate, settings, words

HERE = Path(__file__).resolve().parent
IMAGE = 'ghcr.io/pcugame/pcu-graduationproject-v2-api@sha256:' + 'a' * 64


class Slots(unittest.TestCase):
    def test_two_loopback_slots_and_no_application_autostart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rendered = root / 'rendered'
            env = os.environ | dict(API_IMAGE=IMAGE, API_SLOTS='true', API_BIND_HOST='127.0.0.1', API_PORT='4000', DEPLOY_DIR=str(root))
            subprocess.run(['bash', str(HERE / 'render.sh'), str(rendered)], env=env, check=True)
            self.assertFalse((rendered / 'gp-api.container').exists())
            pod = (rendered / 'graduationproject.pod').read_text()
            for slot, port in [('a', 4000), ('b', 4001)]:
                self.assertIn(f'PublishPort=127.0.0.1:{port}:{port}', pod)
                text = (rendered / f'gp-api-{slot}.container').read_text()
                self.assertIn(f'Environment=PORT={port}', text)
                self.assertIn(f'Environment=API_SLOT={slot}', text)
                self.assertIn(f'/runtime-env/slot-{slot}.env', text)
                self.assertIn('StartWithPod=false', text)
            for file in rendered.glob('gp-worker-*.container'):
                self.assertIn('StartWithPod=false', file.read_text())
                self.assertIn('After=gp-postgres.service', file.read_text())
            generator = select_generator()
            if generator:
                generated = root / 'generated'
                generated.mkdir()
                result = generate(generator, rendered, generated, os.environ | {'HOME': str(root)})
                self.assertEqual(result.returncode, 0, result.stderr)
                pod = settings(generated / 'graduationproject-pod.service')
                wants = words(pod, 'Unit', 'Wants')
                self.assertFalse(any(name.startswith(('gp-api-', 'gp-worker-')) for name in wants))
                for slot in ('a', 'b'):
                    api = settings(generated / f'gp-api-{slot}.service')
                    self.assertIn('graduationproject-pod.service', words(api, 'Unit', 'BindsTo'))

    def test_non_loopback_and_nonstandard_ports_are_rejected(self):
        for override in [dict(API_BIND_HOST='0.0.0.0'), dict(API_PORT='4001'), dict(API_SLOTS='yes')]:
            with tempfile.TemporaryDirectory() as temporary:
                result = subprocess.run(['bash', str(HERE / 'render.sh'), temporary + '/rendered'],
                    env=os.environ | dict(API_IMAGE=IMAGE, API_SLOTS='true') | override, capture_output=True)
                self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__': unittest.main()
