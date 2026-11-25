"""Inventory the actual host; backend usability requires a real GPU backward pass."""
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def command(args, timeout=10):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return {"exitCode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr[-2000:]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}


def contents(path):
    try:
        return Path(path).read_text().strip()
    except OSError as error:
        return {"unavailable": str(error)}


def inventory(directory):
    cards = []
    for card in Path("/sys/class/drm").glob("card[0-9]"):
        device = card / "device"
        cards.append({"card": card.name, "pciPath": str(device.resolve()), **{
            key: contents(device / key) for key in ("vendor", "device", "mem_info_vram_total",
                "mem_info_vram_used", "mem_info_gtt_total", "mem_info_gtt_used")}})
    processes = []
    for process in Path("/proc").glob("[0-9]*"):
        name = contents(process / "comm")
        if not isinstance(name, str) or not any(p in name for p in ("llama", "ollama", "python", "vllm")):
            continue
        # Do not record process arguments or environments: they may contain credentials.
        memory = set()
        try:
            for fd in (process / "fdinfo").iterdir():
                data = contents(fd)
                if isinstance(data, str) and "drm-driver:" in data:
                    memory.add("\n".join(line for line in data.splitlines() if line.startswith(("drm-", "amd-"))))
        except OSError:
            pass
        processes.append({"pid": int(process.name), "name": name, "gpu": sorted(memory)})
    return {"os": platform.platform(), "osRelease": contents("/etc/os-release"), "python": sys.version,
            "memory": contents("/proc/meminfo"), "disk": dict(zip(("total", "used", "free"), shutil.disk_usage(directory))),
            "pci": command(["lspci", "-nnk"]), "cards": cards,
            "thunderbolt": [{"device": p.parent.name, "name": contents(p)} for p in Path("/sys/bus/thunderbolt/devices").glob("*/device_name")],
            "kfd": {str(p): contents(p) for p in Path("/sys/class/kfd/kfd/topology/nodes").glob("*/properties")},
            "processes": processes, "nvidia": command(["nvidia-smi"]),
            "packages": {name: importlib.metadata.version(name) for name in ("torch", "transformers", "peft", "accelerate")
                         if importlib.util.find_spec(name) is not None}}


def gpu_probe():
    import torch
    result = {"torch": torch.__version__, "cuda": torch.version.cuda, "hip": torch.version.hip,
              "available": torch.cuda.is_available()}
    if not result["available"]:
        raise RuntimeError(f"No usable GPU backend: {result}")
    result.update(name=torch.cuda.get_device_name(0), arch=torch.cuda.get_device_properties(0).gcnArchName
                  if torch.version.hip else str(torch.cuda.get_device_capability(0)),
                  totalBytes=torch.cuda.get_device_properties(0).total_memory,
                  freeBytes=torch.cuda.mem_get_info()[0])
    for name, dtype in (("fp16", torch.float16), ("bf16", torch.bfloat16)):
        a = torch.randn(64, 64, device="cuda", dtype=dtype, requires_grad=True)
        loss = (a @ a.T).float().square().mean()
        loss.backward()
        torch.cuda.synchronize()
        result[name] = bool(torch.isfinite(loss).item() and torch.isfinite(a.grad).all().item())
    return result


def probe_isolated():
    result = command([sys.executable, str(Path(__file__).with_name("lab.py")), "probe"], timeout=45)
    if result.get("exitCode") != 0:
        return {"ok": False, "result": result}
    try:
        return {"ok": True, **json.loads(result["stdout"])}
    except ValueError:
        return {"ok": False, "result": result}


def require_gpu(settings, directory):
    probe = probe_isolated()
    expected = "rocm" if probe.get("hip") else "cuda"
    if not probe.get("ok") or not probe.get(settings["precision"]) or expected != settings["backend"]:
        raise RuntimeError(f"GPU preflight failed; no CPU fallback: {json.dumps(probe)}")
    if probe["freeBytes"] < settings["min_free_vram_gib"] * 1024**3:
        raise RuntimeError("Insufficient free VRAM; inspect existing inference workloads without stopping them automatically")
    if shutil.disk_usage(directory).free < settings["min_free_disk_gib"] * 1024**3:
        raise RuntimeError("Insufficient disk space for base cache, checkpoints and adapters")
    return {"inventory": inventory(directory), "probe": probe}
