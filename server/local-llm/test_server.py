import http.client
import json
import os
import threading
import unittest
from unittest.mock import Mock, patch

import server


class GenerateTest(unittest.TestCase):
    def test_empty_instruction_omits_system_role_without_using_server_default(self):
        with patch.object(server, "engine_request", side_effect=[{"prompt": "template"}, {"tokens": [1, 2]}]) as request:
            messages, tokens = server.render_input("nickname data", "")
        self.assertEqual(messages, [{"role": "user", "content": "nickname data"}])
        self.assertEqual(tokens, [1, 2])
        self.assertEqual(request.call_args_list[0].args[1]["messages"], messages)

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
            self.assertEqual(self.call("POST", "/generate", {"prompt": "word", "system_prompt": ""})[0], 200)
            generate.assert_called_with("word", 192, "")
        self.assertTrue(self.call("GET", "/health")[1]["supports_system_prompt"])
        self.assertFalse(self.call("GET", "/health")[1]["busy"])
        self.process.poll.return_value = 1
        self.assertEqual(self.call("GET", "/health")[0], 503)

    def test_invalid_requests_do_not_reach_model(self):
        with patch.object(server, "generate") as generate:
            for body in [[], {}, {"prompt": "x", "system_prompt": None}, {"prompt": " "}, {"prompt": "x", "max_new_tokens": True},
                         {"prompt": "x", "max_new_tokens": 257}, {"prompt": "x" * 33000}]:
                with self.subTest(body_type=type(body)):
                    self.assertEqual(self.call("POST", "/generate", body)[0], 400)
            self.assertEqual(self.call("GET", "/v1/models")[0], 404)
            generate.assert_not_called()

    def test_generation_deadline_discards_the_stuck_engine(self):
        with patch.object(server, "generate", side_effect=TimeoutError):
            self.assertEqual(self.call("POST", "/generate", {"prompt": "go"})[0], 503)
        self.process.kill.assert_called_once_with()

    def test_legacy_profile_preserves_coding_default_and_system_override(self):
        self.assertIn("coding assistant for a graduation exhibition", server.SYSTEM_PROMPT)
        with patch.object(server, "generate", return_value={"text": "OK"}) as generate:
            self.assertEqual(self.call("POST", "/generate", {"prompt": "go", "system_prompt": "custom"})[0], 200)
            generate.assert_called_once_with("go", 192, "custom")
            self.assertEqual(self.call("POST", "/generate", {"prompt": "go", "json_schema": {}})[0], 400)

    def test_research_requires_profile_schema_identity_and_exact_request_budget(self):
        identity = {"weights_sha256": "a" * 64, "chat_template_sha256": "b" * 64}
        with patch.multiple(server, RESEARCH=True, PROFILE="nickname-research-v1", MAX_INPUT=2048,
                            MAX_OUTPUT=768, MAX_BODY=65536, CONTEXT=3072, IDENTITY=identity):
            body = {"profile": "nickname-research-v1", "prompt": "case", "system_prompt": "research policy",
                    "max_new_tokens": 768, "json_schema": {"type": "object"}, **identity}
            with patch.object(server, "generate", return_value={"text": "{}"}) as generate:
                self.assertEqual(self.call("POST", "/generate", body)[0], 200)
                generate.assert_called_once_with("case", 768, "research policy", {"type": "object"}, 2048, 90000)
                for change in [{"profile": "legacy"}, {"json_schema": None}, {"max_new_tokens": 769},
                               {"max_input_tokens": 2049}, {"timeout_ms": 90001}, {"weights_sha256": "wrong"}]:
                    self.assertEqual(self.call("POST", "/generate", {**body, **change})[0], 400)
            with patch.object(server, "count_input", return_value=([], 2050)):
                self.assertEqual(self.call("POST", "/tokenize", body), (200, {"input_tokens": 2050}))
            self.assertTrue(self.call("GET", "/health")[1]["supports_json_schema"])


class ResearchGenerationTest(unittest.TestCase):
    def test_actual_template_count_schema_and_output_reservation(self):
        calls = []
        def request(path, body, timeout=3):
            calls.append((path, body))
            if path == "/apply-template": return {"prompt": "rendered"}
            if path == "/tokenize": return {"tokens": [0] * 1800}
            return {"model": server.MODEL, "tokens_evaluated": 1800,
                    "timings": {"prompt_ms": 200, "predicted_ms": 1000, "predicted_n": 200},
                    "stop_type": "eos", "content": '{"ok":true}', "truncated": False}
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
        with patch.multiple(server, RESEARCH=True, MAX_INPUT=2048, CONTEXT=3072), patch.object(server, "engine_request", request):
            result = server.generate("case", 768, "research policy", schema, 2048, 1000)
            self.assertEqual(result["input_tokens"], 1800)
            self.assertEqual(calls[2][0], "/completion")
            self.assertEqual(calls[2][1]["prompt"], [0] * 1800)
            self.assertEqual(calls[2][1]["json_schema"], schema)
            self.assertEqual(calls[2][1]["t_max_predict_ms"], 1000)
            with self.assertRaises(server.InputError):
                server.generate("case", 768, "research policy", schema, 1799)


if __name__ == "__main__":
    unittest.main()
