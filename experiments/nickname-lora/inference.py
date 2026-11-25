"""Explicit local model registration and a loopback inference-only experiment process."""
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from common import config, digest, read, sha, tree_hash, write, validate_config, base_weight_identity
from hardware import require_gpu


def register(args):
    settings = config(args.config)
    value = {"version": "nickname-model-v1", "name": args.name, "kind": "base", "config": settings,
             "smokeOnly": False, "adapter": None, "adapterHash": None, "trainingResultHash": None}
    if args.result:
        result = read(args.result)
        if result["status"] != "completed" or result["identity"]["config"] != settings:
            # The smoke profile overrides steps only; preserve that actual configuration in registration.
            if not result.get("smokeOnly") or result["status"] != "completed":
                raise ValueError("Training result/config mismatch")
            settings = result["identity"]["config"]
        adapter = Path(result["adapter"]).resolve()
        if tree_hash(adapter) != result["adapterHash"]:
            raise ValueError("Adapter changed after training")
        value.update(kind="adapter", config=settings, adapter=str(adapter), adapterHash=result["adapterHash"],
                     smokeOnly=result["smokeOnly"], trainingResultHash=sha(args.result),
                     datasetManifestHash=result["identity"]["datasetManifestHash"], datasetHash=result["identity"]["datasetHash"],
                     baseWeights=result["baseWeights"])
    write(args.output, value, exclusive=True)


def load_registration(path):
    registration = read(path)
    if registration["version"] != "nickname-model-v1" or registration["kind"] not in ("base", "adapter"):
        raise ValueError("Invalid model registration")
    validate_config(registration["config"])
    if registration["adapter"] and tree_hash(registration["adapter"]) != registration["adapterHash"]:
        raise ValueError("Registered adapter hash mismatch")
    return registration


def serve(args):
    registration_path = args.registration
    if args.selection:
        pointer = read(args.selection)
        registration_path = str((Path(args.selection).resolve().parent / pointer["registration"]).resolve())
        if pointer.get("scope") != "local_only" or sha(registration_path) != pointer["registrationHash"]:
            raise ValueError("Selected registration changed")
    registration = load_registration(registration_path)
    settings = registration["config"]
    hardware = require_gpu(settings, Path(registration_path).resolve().parent)
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, StoppingCriteria, StoppingCriteriaList
    from lmformatenforcer import JsonSchemaParser
    from lmformatenforcer.integrations.transformers import build_transformers_prefix_allowed_tokens_fn

    tokenizer = AutoTokenizer.from_pretrained(settings["model_id"], revision=settings["revision"], trust_remote_code=False)
    tokenizer.pad_token = tokenizer.eos_token
    dtype = torch.bfloat16 if settings["precision"] == "bf16" else torch.float16
    model = AutoModelForCausalLM.from_pretrained(settings["model_id"], revision=settings["revision"], torch_dtype=dtype,
        device_map={"": 0}, low_cpu_mem_usage=True, attn_implementation="sdpa", trust_remote_code=False)
    if registration["adapter"]:
        model = PeftModel.from_pretrained(model, registration["adapter"], is_trainable=False)
    model.eval()
    lock = threading.Lock()
    base_identity = base_weight_identity(settings)
    if registration.get("baseWeights") and registration["baseWeights"] != base_identity:
        raise ValueError("Original model weights differ from the training run")
    identity = {"weights_sha256": digest({"base": base_identity, "adapter": registration["adapterHash"]}),
                "chat_template_sha256": hashlib.sha256(tokenizer.chat_template.encode()).hexdigest(),
                "chat_template": tokenizer.chat_template, "engine_version": f"transformers-{__import__('transformers').__version__}",
                "structured_output_transport": "transformers-lm-format-enforcer" if not args.unconstrained else "transformers-unconstrained",
                "context_tokens": 3072, "seed": 42, "precision": settings["precision"],
                "backend": settings["backend"], "gpu_name": hardware["probe"]["name"],
                "gpu_arch": hardware["probe"]["arch"], "torch_version": hardware["probe"]["torch"],
                "modelRevision": settings["revision"], "registrationHash": sha(registration_path)}

    def encode(body):
        if body.get("profile") != "nickname-research-v1":
            raise ValueError("Unknown profile")
        for key in ("weights_sha256", "chat_template_sha256"):
            if body.get(key) != identity[key]:
                raise ValueError("Model identity changed")
        for key in ("system_prompt", "prompt"):
            if not isinstance(body.get(key), str) or len(body[key]) > 32000:
                raise ValueError("Invalid prompt")
        return tokenizer.apply_chat_template([
            {"role": "system", "content": body["system_prompt"]}, {"role": "user", "content": body["prompt"]}
        ], tokenize=True, add_generation_prompt=True, return_tensors="pt")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *values):
            pass  # No nicknames or evidence in HTTP access logs.

        def reply(self, status, value):
            payload = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": "not_found"})
            self.reply(200, {"ok": True, "busy": lock.locked(), "model": registration["name"],
                "identity": identity, "profile": "nickname-research-v1", "max_input_tokens": 2048, "max_output_tokens": 768})

        def do_POST(self):
            if self.path not in ("/tokenize", "/generate"):
                return self.reply(404, {"error": "not_found"})
            if not lock.acquire(blocking=False):
                return self.reply(503, {"error": "busy"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 128000:
                    raise ValueError("Invalid request size")
                body = json.loads(self.rfile.read(size))
                ids = encode(body)
                length = ids.shape[-1]
                if self.path == "/tokenize":
                    return self.reply(200, {"input_tokens": length})
                maximum = body["max_new_tokens"]
                timeout = body["timeout_ms"]
                if not isinstance(maximum, int) or not 1 <= maximum <= 768 or not 1 <= timeout <= 90000:
                    raise ValueError("Invalid output/time limit")
                if length > min(2048, body["max_input_tokens"]) or length + maximum > 3072:
                    raise ValueError("Token limit exceeded")
                began = time.monotonic()

                class Deadline(StoppingCriteria):
                    def __call__(self, input_ids, scores, **kwargs):
                        return time.monotonic() - began > timeout / 1000

                kwargs = {}
                if not args.unconstrained:
                    kwargs["prefix_allowed_tokens_fn"] = build_transformers_prefix_allowed_tokens_fn(tokenizer, JsonSchemaParser(body["json_schema"]))
                with torch.inference_mode():
                    result = model.generate(input_ids=ids.to("cuda"), attention_mask=torch.ones_like(ids).to("cuda"),
                        max_new_tokens=maximum, do_sample=False, temperature=None, top_p=None, top_k=None,
                        pad_token_id=tokenizer.pad_token_id, stopping_criteria=StoppingCriteriaList([Deadline()]), **kwargs)
                torch.cuda.synchronize()
                generated = result[0, length:]
                elapsed = time.monotonic() - began
                eos = model.generation_config.eos_token_id
                stopped = int(generated[-1]) in (eos if isinstance(eos, list) else [eos])
                self.reply(200, {"text": tokenizer.decode(generated, skip_special_tokens=True), "input_tokens": length,
                    "output_tokens": len(generated), "seconds": elapsed,
                    "finish_reason": "stop" if stopped else "timeout" if elapsed > timeout / 1000 else "length"})
            except (ValueError, KeyError, TypeError) as error:
                self.reply(400, {"error": str(error)})
            except Exception as error:
                self.reply(500, {"error": type(error).__name__})
            finally:
                lock.release()

    print(json.dumps({"listening": f"http://127.0.0.1:{args.port}", "registrationHash": sha(registration_path), "identity": identity}))
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


def merge(args):
    registration = load_registration(args.registration)
    if not registration["adapter"]:
        raise ValueError("Select an adapter registration")
    output = Path(args.output)
    if output.exists():
        raise ValueError("Merge output must be a new directory; never overwrite the base or serving model")
    output.parent.mkdir(parents=True, exist_ok=True)
    require_gpu(registration["config"], output.parent)
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    settings = registration["config"]
    base = AutoModelForCausalLM.from_pretrained(settings["model_id"], revision=settings["revision"],
        torch_dtype=torch.bfloat16, device_map={"": 0}, trust_remote_code=False)
    model = PeftModel.from_pretrained(base, registration["adapter"]).merge_and_unload(safe_merge=True)
    model.save_pretrained(output, safe_serialization=True, max_shard_size="2GB")
    AutoTokenizer.from_pretrained(settings["model_id"], revision=settings["revision"]).save_pretrained(output)
    write(output / "merge-manifest.json", {"registrationHash": sha(args.registration), "modelHash": tree_hash(output),
          "purpose": "conversion_only_not_deployed", "smokeOnly": registration["smokeOnly"]})
