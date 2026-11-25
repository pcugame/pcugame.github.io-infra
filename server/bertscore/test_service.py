import json
import os
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from service import Scorer, create_server, parse_pairs


class ServiceTests(unittest.TestCase):
    def test_input_validation(self):
        self.assertEqual(parse_pairs({"pairs": [{"candidate": "한글\n", "reference": ""}]})[0]["candidate"], "한글\n")
        for value in [[], {}, {"pairs": []}, {"pairs": [{}]}, {"pairs": [{"candidate": None, "reference": "x"}]},
                      {"pairs": [{"candidate": "x" * 4001, "reference": "x"}]}]:
            with self.assertRaises(ValueError):
                parse_pairs(value)

    def test_http_boundaries(self):
        class Fixture:
            identity = {"fixture": True}
            def score(self, pairs):
                return [{"status": "SKIPPED", "reason": "EMPTY_REASON"} for _ in pairs]
        server = create_server(Fixture(), port=0)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/health") as response:
                self.assertTrue(json.load(response)["ready"])
            body = json.dumps({"pairs": [{"candidate": "", "reference": "기대"}]}).encode()
            with urlopen(Request(base + "/score", body)) as response:
                self.assertEqual(json.load(response)["results"][0]["reason"], "EMPTY_REASON")
            for body, code in [(b"[]", 400), (b"\xff", 400), (b"x" * (256 * 1024 + 1), 413)]:
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/score", body))
                self.assertEqual(error.exception.code, code)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    @unittest.skipUnless(os.environ.get("RUN_BERTSCORE_INTEGRATION") == "true", "requires pinned model download")
    def test_real_korean_scores_no_truncation_and_identity(self):
        scorer = Scorer()
        result = scorer.score([
            {"candidate": "평범한 한국어 닉네임이다.", "reference": "평범한 한국어 닉네임이다."},
            {"candidate": "", "reference": "평범한 표현"},
            {"candidate": "아무 근거가 없다.", "reference": "긴 문장 " * 600},
            {"candidate": "증거가 부족하여 판단을 유보한다.", "reference": "자료가 부족해 판단하기 어렵다."},
        ])
        self.assertGreater(result[0]["f1"], 0.99)
        self.assertEqual(result[1]["reason"], "EMPTY_REASON")
        self.assertEqual(result[2]["reason"], "TOKEN_LIMIT")
        self.assertEqual(result[3]["status"], "SUCCEEDED")
        self.assertEqual(len(result[3]["identity"]["configHash"]), 64)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
