"""Local /generate HTTP service backed by a private llama.cpp CUDA process."""

import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "Qwen3-4B-Instruct-2507-Q4_K_M"
MAX_INPUT = 1024
MAX_OUTPUT = 256
MAX_BODY = 32768
ROOT = Path("/opt/term-origin-llm")
ENGINE_SOCKET = Path("/run/qwen-coder/llama.sock")
SYSTEM_PROMPT = (
    "You are a coding assistant for a graduation exhibition archive. "
    "Follow the supplied schema and configuration. Give concise, accurate answers. "
    "Generate proposals only; do not claim to have executed changes."
)


class EngineConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(ENGINE_SOCKET))


def engine_request(path, body=None, timeout=3):
    connection = EngineConnection("localhost", timeout=timeout)
    try:
        data = None if body is None else json.dumps(body).encode()
        connection.request("GET" if data is None else "POST", path, data, {"Content-Type": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"engine returned HTTP {response.status}")
        return json.loads(response.read())
    finally:
        connection.close()


class InputError(ValueError):
    def __init__(self, message, **fields):
        super().__init__(message)
        self.body = {"error": message, **fields}


def generate(prompt, limit):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}]
    # Count the rendered chat so special tokens and the fixed system prompt use the same budget as inference.
    rendered = engine_request("/apply-template", {"messages": messages})["prompt"]
    tokens = engine_request("/tokenize", {"content": rendered, "add_special": True, "parse_special": True})["tokens"]
    if len(tokens) > MAX_INPUT:
        raise InputError("input exceeds 1024 tokens", input_tokens=len(tokens))
    response = engine_request("/v1/chat/completions", {
        "model": MODEL, "messages": messages, "max_tokens": limit, "temperature": 0,
        "seed": 42, "stream": False, "cache_prompt": False, "t_max_predict_ms": 90000,
    }, timeout=90)
    input_count = response["usage"]["prompt_tokens"]
    output_count = response["usage"]["completion_tokens"]
    if response["model"] != MODEL or input_count != len(tokens) or not 0 <= output_count <= limit:
        raise RuntimeError("engine response did not match the requested model or token budget")
    times = response["timings"]
    seconds = (times["prompt_ms"] + times["predicted_ms"]) / 1000
    return {
        "text": response["choices"][0]["message"]["content"],
        "input_tokens": input_count, "output_tokens": output_count, "seconds": round(seconds, 3),
        "tokens_per_second": round(output_count / seconds, 3) if seconds else 0,
        # The previous provider exposed a PyTorch allocator peak. llama.cpp does not measure that metric.
        "gpu_peak_allocated_mib": None,
    }


class ModelHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, engine):
        self.engine = engine
        self.gate = threading.Lock()
        super().__init__(address, Handler)

    def get_request(self):
        client, address = super().get_request()
        client.settimeout(10)
        return client, address


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        alive = self.server.engine.poll() is None
        self.reply(200 if alive else 503, {
            "ok": alive, "model": MODEL, "quantization": "Q4_K_M", "busy": self.server.gate.locked(),
            "max_input_tokens": MAX_INPUT, "max_output_tokens": MAX_OUTPUT,
        })

    def do_POST(self):
        if self.path != "/generate":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            prompt = body.get("prompt") if isinstance(body, dict) else None
            limit = body.get("max_new_tokens", 192) if isinstance(body, dict) else None
            if not isinstance(prompt, str) or not prompt.strip() or type(limit) is not int or not 1 <= limit <= MAX_OUTPUT:
                raise ValueError()
        except (ValueError, RecursionError, TimeoutError):
            return self.reply(400, {"error": "a prompt and max_new_tokens in 1..256 are required (32 KiB body limit)"})

        if not self.server.gate.acquire(blocking=False):
            return self.reply(503, {"error": "one generation at a time"})
        try:
            result = generate(prompt, limit)
            status = Path(f"/proc/{self.server.engine.pid}/status").read_text()
            line = next(line for line in status.splitlines() if line.startswith("VmRSS:"))
            result["rss_mib"] = round(int(line.split()[1]) / 1024, 1)
        except InputError as error:
            return self.reply(400, error.body)
        except TimeoutError:
            # Interrupt GPU work that would otherwise continue after the HTTP deadline. systemd reloads the model.
            self.server.engine.kill()
            return self.reply(503, {"error": "inference deadline exceeded"})
        except (OSError, RuntimeError, ValueError, KeyError, TypeError, IndexError, http.client.HTTPException):
            return self.reply(503, {"error": "inference engine unavailable"})
        finally:
            self.server.gate.release()
        self.reply(200, result)

    def log_request(self, code="-", size="-"):
        pass  # Keep prompt data and client-supplied paths out of the journal.


def notify_ready():
    address = os.environ["NOTIFY_SOCKET"]
    if address.startswith("@"):
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as channel:
        channel.sendto(b"READY=1\nSTATUS=4B CUDA model warmed and serving on loopback", address)


def main():
    ENGINE_SOCKET.unlink(missing_ok=True)
    env = dict(os.environ, LD_LIBRARY_PATH=f"{ROOT}/bin:{ROOT}/runtime")
    env.pop("NOTIFY_SOCKET", None)
    command = [
        str(ROOT / "bin/llama-server"), "-m", str(ROOT / "weights.gguf"), "--alias", MODEL,
        "--host", str(ENGINE_SOCKET), "-c", "1536", "-np", "1", "--device", "CUDA0",
        "--fit", "off", "-ngl", "99", "-t", "3", "-tb", "3", "--no-ui",
    ]
    engine = subprocess.Popen(command, env=env)
    try:
        while engine.poll() is None:
            try:
                if engine_request("/health")["status"] == "ok":
                    break
            except (OSError, RuntimeError, http.client.HTTPException):
                pass
            time.sleep(0.25)
        if engine.poll() is not None:
            raise RuntimeError("inference process exited during startup")
        # Warm a normal prompt before systemd advertises readiness or users get the first request.
        generate("Read the following example and reply with OK. " + "This is an example sentence. " * 32, 2)
        with ModelHTTPServer(("127.0.0.1", 8088), engine) as server:
            server.timeout = 0.5
            notify_ready()
            while engine.poll() is None:
                server.handle_request()
        raise RuntimeError("inference process exited")
    finally:
        if engine.poll() is None:
            engine.terminate()
        try:
            engine.wait(timeout=8)
        except subprocess.TimeoutExpired:
            engine.kill()
            engine.wait()


if __name__ == "__main__":
    main()
