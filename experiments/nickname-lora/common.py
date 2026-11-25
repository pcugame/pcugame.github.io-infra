"""Small, dependency-free artifact and configuration primitives."""
import hashlib
import json
import os
import re
from pathlib import Path

MODEL_ID = "Qwen/Qwen3-4B-Instruct-2507"


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value, exclusive=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if exclusive:
        with path.open("x") as stream:
            os.chmod(path, 0o600)
            stream.write(text)
    else:
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("w") as stream:
            os.chmod(temporary, 0o600)
            stream.write(text)
        temporary.replace(path)


def tree_hash(path):
    return digest({str(p.relative_to(path)): sha(p) for p in sorted(Path(path).rglob("*"))
                   if p.is_file()})


def base_weight_identity(settings):
    from huggingface_hub import try_to_load_from_cache
    index = try_to_load_from_cache(settings["model_id"], "model.safetensors.index.json", revision=settings["revision"])
    if not isinstance(index, str):
        raise ValueError("Original model shard index is missing from the pinned cache")
    files = {}
    for name in sorted(set(read(index)["weight_map"].values())):
        path = try_to_load_from_cache(settings["model_id"], name, revision=settings["revision"])
        if not isinstance(path, str):
            raise ValueError(f"Original model shard missing: {name}")
        files[name] = sha(path)
    return {"files": files, "sha256": digest(files)}


def config(path):
    return validate_config(read(path))


def validate_config(value):
    if value["model_id"] != MODEL_ID or not re.fullmatch(r"[a-f0-9]{40}", value["revision"]):
        raise ValueError("Use the original Qwen3-4B-Instruct-2507 with an immutable 40-character revision")
    if value["backend"] not in ("rocm", "cuda") or value["precision"] not in ("bf16", "fp16"):
        raise ValueError("Only explicitly selected GPU backends and mixed precision are supported")
    if value["quantization"] != "none":
        raise ValueError("This profile uses LoRA; quantized training has not been validated")
    if not 1 <= value["rank"] <= 64 or not 0 < value["learning_rate"] < 0.01:
        raise ValueError("Invalid rank or learning rate")
    for key in ("micro_batch", "gradient_accumulation", "max_length", "max_steps", "save_steps"):
        if not isinstance(value[key], int) or value[key] < 1:
            raise ValueError(f"Invalid {key}")
    if value["max_length"] > 3072 or not 0 < value["epochs"] <= 10:
        raise ValueError("Initial experiment must remain within the research context and epoch limit")
    if not value["target_modules"] or not set(value["target_modules"]) <= {
        "q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"
    }:
        raise ValueError("Only Qwen projection adapters are supported")
    return value


def load_dataset(directory, smoke=False):
    directory = Path(directory)
    metadata = read(directory / "manifest.json")
    if metadata["version"] != "nickname-sft-v1" or metadata["split"] != "train":
        raise ValueError("Only prepared train data is accepted")
    if metadata["smokeOnly"] != smoke:
        raise ValueError("Synthetic smoke data and reviewed training data cannot be interchanged")
    if sha(directory / "train.jsonl") != metadata["trainSha256"]:
        raise ValueError("Dataset hash changed")
    if not smoke and sha(directory / "provenance.json") != metadata["provenanceSha256"]:
        raise ValueError("Human review provenance changed after preparation")
    rows = [json.loads(line) for line in (directory / "train.jsonl").read_text().splitlines() if line]
    if len(rows) != len(metadata["rows"]) or not rows:
        raise ValueError("Dataset inventory mismatch")
    for row in rows:
        if set(row) != {"messages"} or [m["role"] for m in row["messages"]] != ["system", "user", "assistant"]:
            raise ValueError("Only exact system/user/assistant research examples are accepted")
        json.loads(row["messages"][-1]["content"])
    return rows, metadata


def encode_example(tokenizer, row, max_length):
    messages = row["messages"]
    prefix = tokenizer.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
    if full[:len(prefix)] != prefix or len(full) <= len(prefix):
        raise ValueError("Chat template does not preserve the inference prefix")
    if len(full) > max_length:
        raise ValueError(f"Example has {len(full)} tokens > {max_length}; never truncate evidence or target JSON")
    return {"input_ids": full, "attention_mask": [1] * len(full),
            "labels": [-100] * len(prefix) + full[len(prefix):]}
