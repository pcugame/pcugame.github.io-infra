import runpy
from types import SimpleNamespace
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
renderer = SimpleNamespace(**runpy.run_path(str(HERE / 'render-images.py')))


class ReviewDirectory:
    """Exercise Linux topology rendering using a native temporary filesystem."""
    def __init__(self, native):
        self.native = native

    def __str__(self):
        return '/private/review'

    def mkdir(self, **kwargs):
        self.native.mkdir(**kwargs)

    def __truediv__(self, name):
        return self.native / name


class ImageTopology(unittest.TestCase):
    def test_internal_pinned_services_and_separate_secret_scope(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            'DEPLOY_DIR': '/srv/project', 'IMGPROXY_KEY': 'NEVER_RENDER_SECRET',
        }, clear=True):
            output = Path(root) / 'review'
            renderer.render(ReviewDirectory(output))
            files = {p.name: p.read_text() for p in output.iterdir()}
            self.assertEqual(len(files), 4)
            self.assertTrue(all('NEVER_RENDER_SECRET' not in value for value in files.values()))
            proxy = files['gp-imgproxy.container']
            cache = files['gp-image-cache.container']
            self.assertIn('@sha256:', proxy)
            self.assertIn('@sha256:', cache)
            self.assertIn('127.0.0.1:8090', proxy)
            self.assertNotIn('PublishPort=', proxy + cache)
            self.assertIn('listen 127.0.0.1:8091;', files['image-cache.conf'])
            self.assertIn('proxy_pass http://127.0.0.1:8090;', files['image-cache.conf'])
            self.assertIn('proxy_no_cache $image_no_cache;', files['image-cache.conf'])
            self.assertIn('/runtime-env/imgproxy.env', proxy)
            self.assertNotIn('common.env', proxy)

    def test_invalid_paths_fail_before_writing(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            'DEPLOY_DIR': '/srv/project\nEnvironment=unsafe',
        }, clear=True):
            output = Path(root) / 'review'
            with self.assertRaises(ValueError):
                renderer.render(ReviewDirectory(output))
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
