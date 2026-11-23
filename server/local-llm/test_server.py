import http.client
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch

import server


class GenerateTest(unittest.TestCase):
    def test_template_token_budget_precedes_inference(self):
        cases = [(1024, 200), (1025, 400)]
        for token_count, expected in cases:
            with self.subTest(token_count=token_count):
                calls = []
                def request(path, body, timeout=3):
                    calls.append((path, body))
                    if path == "/apply-template":
                        return {"prompt": "rendered input including system and role markers"}
                    if path == "/tokenize":
                        return {"tokens": [0] * token_count}
                    return {
                        "model": server.MODEL,
                        "usage": {"prompt_tokens": token_count, "completion_tokens": 2},
                        "timings": {"prompt_ms": 100, "predicted_ms": 150},
                        "choices": [{"message": {"content": "OK"}}],
                    }

                with patch.object(server, "engine_request", request):
                    if expected == 400:
                        with self.assertRaises(server.InputError) as rejected:
                            server.generate(" experiment text ", 12)
                        self.assertEqual(rejected.exception.body["input_tokens"], token_count)
                        self.assertEqual([c[0] for c in calls], ["/apply-template", "/tokenize"])
                    else:
                        reply = server.generate(" experiment text ", 12, " edited instruction ")
                        self.assertEqual((reply["text"], reply["seconds"], reply["input_tokens"]), ("OK", .25, 1024))
                        self.assertEqual(calls[0][1]["messages"], calls[2][1]["messages"])
                        self.assertEqual(calls[2][1]["messages"][0], {"role": "system", "content": " edited instruction "})
                        self.assertEqual(calls[2][1]["messages"][1]["content"], " experiment text ")
                        self.assertEqual(calls[2][1]["max_tokens"], 12)
                        self.assertEqual(calls[2][1]["temperature"], 0)


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.process = Mock(pid=os.getpid())
        self.process.poll.return_value = None
        self.http = server.ModelHTTPServer(("127.0.0.1", 0), self.process)
        self.addCleanup(self.http.server_close)
        thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.http.shutdown)

    def call(self, method, path, body=None):
        client = http.client.HTTPConnection(*self.http.server_address, timeout=3)
        try:
            client.request(method, path, json.dumps(body) if body is not None else None)
            reply = client.getresponse()
            return reply.status, json.loads(reply.read())
        finally:
            client.close()

    def test_busy_generation_and_health_share_a_single_slot(self):
        with self.http.gate:
            self.assertTrue(self.call("GET", "/health")[1]["busy"])
            self.assertEqual(self.call("POST", "/generate", {"prompt": "go"})[0], 503)
        with patch.object(server, "generate", return_value={"text": "OK"}) as generate:
            status, reply = self.call("POST", "/generate", {"prompt": " next "})
            self.assertEqual((status, reply["text"]), (200, "OK"))
            generate.assert_called_once_with(" next ", 192, server.SYSTEM_PROMPT)
            self.call("POST", "/generate", {"prompt": "word", "system_prompt": " custom "})
            generate.assert_called_with("word", 192, " custom ")
        self.assertTrue(self.call("GET", "/health")[1]["supports_system_prompt"])
        self.assertFalse(self.call("GET", "/health")[1]["busy"])
        self.process.poll.return_value = 1
        self.assertEqual(self.call("GET", "/health")[0], 503)

    def test_invalid_requests_do_not_reach_model(self):
        with patch.object(server, "generate") as generate:
            for body in [[], {}, {"prompt": "x", "system_prompt": " "}, {"prompt": "x", "system_prompt": None}, {"prompt": " "}, {"prompt": "x", "max_new_tokens": True},
                         {"prompt": "x", "max_new_tokens": 257}, {"prompt": "x" * 33000}]:
                with self.subTest(body_type=type(body)):
                    self.assertEqual(self.call("POST", "/generate", body)[0], 400)
            self.assertEqual(self.call("GET", "/v1/models")[0], 404)
            generate.assert_not_called()

    def test_generation_deadline_discards_the_stuck_engine(self):
        with patch.object(server, "generate", side_effect=TimeoutError):
            self.assertEqual(self.call("POST", "/generate", {"prompt": "go"})[0], 503)
        self.process.kill.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
