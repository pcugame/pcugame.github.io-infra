"""Private, CPU-only BERTScore service. No expected answers reach the generator."""
import hashlib
import importlib.metadata
import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "google-bert/bert-base-multilingual-cased"
REVISION = "3f076fdb1ab68d5b2880cb87a0886f315b8146f8"
MAX_BODY = 256 * 1024
MAX_TOKENS = 512


def parse_pairs(body):
    if not isinstance(body, dict) or set(body) != {"pairs"}:
        raise ValueError("Expected pairs")
    pairs = body["pairs"]
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= 4:
        raise ValueError("Provide 1–4 pairs")
    for pair in pairs:
        if not isinstance(pair, dict) or set(pair) != {"candidate", "reference"}:
            raise ValueError("Expected candidate and reference")
        for value in pair.values():
            if not isinstance(value, str) or len(value) > 4000:
                raise ValueError("Reasons must be strings of at most 4000 characters")
            value.encode("utf-8", errors="strict")
            if "\x00" in value:
                raise ValueError("Invalid text")
    return pairs


class Scorer:
    def __init__(self):
        import torch
        from bert_score import BERTScorer
        from huggingface_hub import snapshot_download

        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        path = snapshot_download(MODEL, revision=REVISION, allow_patterns=[
            "config.json", "model.safetensors", "tokenizer_config.json", "tokenizer.json",
            "vocab.txt", "special_tokens_map.json",
        ])
        self.scorer = BERTScorer(model_type=path, num_layers=9, device="cpu", batch_size=4,
                                nthreads=4, idf=False, rescale_with_baseline=False, use_fast_tokenizer=False)
        identity = {"model": MODEL, "revision": REVISION, "layers": 9, "device": "cpu", "threads": 4,
                    "batchSize": 4, "idf": False, "rescaleWithBaseline": False, "useFastTokenizer": False,
                    "maxTokens": MAX_TOKENS,
                    "versions": {p: importlib.metadata.version(p) for p in
                                 ["bert-score", "torch", "transformers", "tokenizers", "huggingface-hub", "numpy", "safetensors"]}}
        canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.identity = {**identity, "configHash": hashlib.sha256(canonical.encode()).hexdigest()}

    def score(self, pairs):
        results = [None] * len(pairs)
        selected = []
        for i, pair in enumerate(pairs):
            reason = None
            if not pair["candidate"].strip() or not pair["reference"].strip():
                reason = "EMPTY_REASON"
            elif any(len(self.scorer._tokenizer.encode(v.strip(), add_special_tokens=True, truncation=False)) > MAX_TOKENS
                     for v in pair.values()):
                reason = "TOKEN_LIMIT"
            if reason:
                results[i] = {"status": "SKIPPED", "reason": reason, "identity": self.identity}
            else:
                selected.append(i)
        if selected:
            precision, recall, f1 = self.scorer.score([pairs[i]["candidate"] for i in selected],
                                                     [pairs[i]["reference"] for i in selected], batch_size=4)
            for j, i in enumerate(selected):
                values = {"precision": float(precision[j]), "recall": float(recall[j]), "f1": float(f1[j])}
                if not all(math.isfinite(v) for v in values.values()):
                    raise ValueError("Nonfinite BERTScore")
                results[i] = {"status": "SUCCEEDED", **values, "identity": self.identity}
        return results


def create_server(scorer, host="127.0.0.1", port=8090):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass  # Request bodies contain private evaluation material.

        def send_json(self, code, body):
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path != "/health":
                return self.send_json(404, {"error": "NOT_FOUND"})
            self.send_json(200, {"ready": True, "identity": scorer.identity})

        def do_POST(self):
            if self.path != "/score":
                return self.send_json(404, {"error": "NOT_FOUND"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY or self.headers.get("Transfer-Encoding"):
                    return self.send_json(413, {"error": "BODY_LIMIT"})
                pairs = parse_pairs(json.loads(self.rfile.read(length).decode("utf-8", errors="strict")))
            except (ValueError, UnicodeError):
                return self.send_json(400, {"error": "INVALID_INPUT"})
            if not lock.acquire(blocking=False):
                return self.send_json(503, {"error": "BUSY"})
            try:
                self.send_json(200, {"results": scorer.score(pairs)})
            except Exception:
                self.send_json(503, {"error": "SCORING_FAILED"})
            finally:
                lock.release()

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    create_server(Scorer(), os.environ.get("BERTSCORE_HOST", "127.0.0.1"),
                  int(os.environ.get("BERTSCORE_PORT", "8090"))).serve_forever()
