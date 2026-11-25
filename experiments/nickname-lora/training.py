"""Assistant-only SFT with frozen base weights and resumable PEFT checkpoints."""
import importlib.metadata
import math
import os
import subprocess
from pathlib import Path

from common import config, encode_example, load_dataset, read, sha, tree_hash, write, base_weight_identity
from hardware import require_gpu


def train(args):
    settings = config(args.config)
    rows, data = load_dataset(args.data, smoke=args.smoke)
    if args.smoke:
        settings.update(max_steps=2, save_steps=1, gradient_accumulation=1, micro_batch=1)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    hardware = require_gpu(settings, output.parent)
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback, TrainingArguments, set_seed

    source_files = {p.name: sha(p) for p in sorted(Path(__file__).parent.glob("*.py"))}
    packages = {p: importlib.metadata.version(p) for p in
                ("torch", "transformers", "peft", "accelerate", "safetensors", "tokenizers")}
    identity = {"config": settings, "sourceFiles": source_files, "packages": packages,
                "datasetManifestHash": sha(Path(args.data) / "manifest.json"),
                "datasetHash": data["trainSha256"], "smokeOnly": args.smoke}
    resume = Path(args.resume).resolve() if args.resume else None
    if resume:
        if resume.parent != output or read(output / "run.json")["identity"] != identity:
            raise ValueError("Resume must use the same run, model revision, configuration and dataset")
        for required in ("trainer_state.json", "optimizer.pt", "scheduler.pt", "rng_state.pth", "adapter_model.safetensors"):
            if not (resume / required).is_file():
                raise ValueError(f"Incomplete training checkpoint: {required}")
        prior_step = read(resume / "trainer_state.json")["global_step"]
        audit_path = output / f"result-step-{prior_step}.json"
        if audit_path.exists() and read(audit_path)["checkpointHashes"].get(resume.name) != tree_hash(resume):
            raise ValueError("Checkpoint hash changed after its recorded save")
    else:
        output.mkdir(mode=0o700, exist_ok=False)
        write(output / "run.json", {"identity": identity, "data": data, "hardware": hardware,
              "status": "started", "sourceRevision": os.environ.get("NICKNAME_SOURCE_SHA"),
              "containerImage": os.environ.get("NICKNAME_IMAGE_ID"),
              "pythonLock": subprocess.run([os.sys.executable, "-m", "pip", "freeze"], capture_output=True, text=True, check=True).stdout,
              "packages": packages}, exclusive=True)
    set_seed(settings["seed"])
    tokenizer = AutoTokenizer.from_pretrained(settings["model_id"], revision=settings["revision"], trust_remote_code=False)
    tokenizer.pad_token = tokenizer.eos_token
    encoded = [encode_example(tokenizer, row, settings["max_length"]) for row in rows]
    dtype = torch.bfloat16 if settings["precision"] == "bf16" else torch.float16
    model = AutoModelForCausalLM.from_pretrained(settings["model_id"], revision=settings["revision"],
        torch_dtype=dtype, device_map={"": 0}, low_cpu_mem_usage=True, attn_implementation="sdpa", trust_remote_code=False)
    base_identity = base_weight_identity(settings)
    run = read(output / "run.json")
    if run.get("baseWeights") and run["baseWeights"] != base_identity:
        raise ValueError("Original cached model weights changed")
    write(output / "run.json", {**run, "baseWeights": base_identity,
          "chatTemplateHash": __import__('hashlib').sha256(tokenizer.chat_template.encode()).hexdigest()})
    model.config.use_cache = False
    model = get_peft_model(model, LoraConfig(r=settings["rank"], lora_alpha=settings["alpha"],
        lora_dropout=settings["dropout"], target_modules=settings["target_modules"], revision=settings["revision"],
        bias="none", task_type="CAUSAL_LM"))
    if settings["gradient_checkpointing"]:
        model.enable_input_require_grads()
    trainable = {name: value for name, value in model.named_parameters() if value.requires_grad}
    if not trainable or any("lora_" not in name for name in trainable):
        raise RuntimeError("Only LoRA adapter parameters may be updated")
    # A small frozen tensor proves the optimizer did not update the base.
    frozen = next(value for name, value in model.named_parameters() if not value.requires_grad and value.numel() < 1_000_000)
    frozen_before = frozen.detach().cpu().clone()

    def collate(batch):
        length = max(len(row["input_ids"]) for row in batch)
        return {key: torch.tensor([row[key] + [pad] * (length - len(row[key])) for row in batch])
                for key, pad in (("input_ids", tokenizer.pad_token_id), ("attention_mask", 0), ("labels", -100))}

    class Audit(TrainerCallback):
        resumed_before = None

        def on_train_begin(self, args_, state, control, **kwargs):
            # Trainer has loaded the checkpoint by this point.
            self.resumed_before = {name: value.detach().cpu().clone() for name, value in trainable.items()}

        def on_step_end(self, args_, state, control, **kwargs):
            if args.stop_after and state.global_step >= args.stop_after:
                control.should_save = True
                control.should_training_stop = True

        def on_log(self, args_, state, control, logs=None, **kwargs):
            if logs and any(not math.isfinite(float(logs[k])) for k in ("loss", "grad_norm") if k in logs):
                raise RuntimeError("Non-finite training loss or gradient; do not register this run")

    audit = Audit()
    epoch_steps = math.ceil(math.ceil(len(rows) / settings["micro_batch"]) / settings["gradient_accumulation"]) * settings["epochs"]
    effective_steps = min(settings["max_steps"], math.ceil(epoch_steps))
    training_args = TrainingArguments(output_dir=str(output), per_device_train_batch_size=settings["micro_batch"],
        gradient_accumulation_steps=settings["gradient_accumulation"], learning_rate=settings["learning_rate"],
        num_train_epochs=settings["epochs"], max_steps=effective_steps,
        gradient_checkpointing=settings["gradient_checkpointing"], gradient_checkpointing_kwargs={"use_reentrant": False},
        bf16=settings["precision"] == "bf16", fp16=settings["precision"] == "fp16", optim="adamw_torch",
        lr_scheduler_type="constant", max_grad_norm=1.0, logging_steps=1, logging_nan_inf_filter=False,
        save_steps=settings["save_steps"], save_total_limit=2, save_safetensors=True,
        report_to=[], seed=settings["seed"], data_seed=settings["seed"], dataloader_num_workers=0,
        dataloader_pin_memory=False, remove_unused_columns=False)
    trainer = Trainer(model=model, args=training_args, train_dataset=encoded, data_collator=collate, callbacks=[audit])
    torch.cuda.reset_peak_memory_stats()
    previous_step = read(resume / "trainer_state.json")["global_step"] if resume else 0
    trainer.train(resume_from_checkpoint=str(resume) if resume else None)
    if trainer.state.global_step <= previous_step:
        raise RuntimeError("Training did not advance")
    changed = [name for name, value in trainable.items() if not torch.equal(value.detach().cpu(), audit.resumed_before[name])]
    if not changed or not torch.equal(frozen.detach().cpu(), frozen_before):
        raise RuntimeError("Missing adapter update or unexpected frozen-weight update")
    if any(not torch.isfinite(value).all().item() for value in trainable.values()):
        raise RuntimeError("Non-finite adapter weights")
    adapter = output / f"adapter-step-{trainer.state.global_step}"
    adapter.mkdir(exist_ok=False)
    model.save_pretrained(adapter, safe_serialization=True)
    tokenizer.save_pretrained(adapter)
    # Hash the complete adapter files; save no duplicate base weights.
    result = {"identity": identity, "baseWeights": base_identity, "globalStep": trainer.state.global_step, "resumedFromStep": previous_step,
              "hardware": hardware, "containerImage": os.environ.get("NICKNAME_IMAGE_ID"),
              "adapter": str(adapter), "adapterHash": tree_hash(adapter), "updatedTensorCount": len(changed),
              "trainableParameters": sum(v.numel() for v in trainable.values()),
              "frozenTensorUnchanged": True, "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
              "checkpointHashes": {p.name: tree_hash(p) for p in output.glob("checkpoint-*") if p.is_dir()},
              "logs": trainer.state.log_history, "plannedSteps": effective_steps,
              "smokeOnly": args.smoke, "status": "completed"}
    write(output / f"result-step-{trainer.state.global_step}.json", result, exclusive=True)
    print(f"Saved {adapter}; {len(changed)} adapter tensors updated; resumed from step {previous_step}")
    return result
