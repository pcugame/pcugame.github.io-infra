#!/usr/bin/env python3
"""Local-only GPU lifecycle CLI. No training HTTP route or arbitrary command API."""
import argparse
import json
from pathlib import Path
from common import write


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor", help="Capture hardware and real GPU backward-pass availability")
    doctor.add_argument("--output", required=True)
    sub.add_parser("probe", help="Run the isolated GPU matrix multiplication/backward probe")
    train = sub.add_parser("train", help="Explicit training command; requires prepared data")
    train.add_argument("--config", default="config.json")
    train.add_argument("--data", required=True)
    train.add_argument("--output", required=True)
    train.add_argument("--resume")
    train.add_argument("--stop-after", type=int)
    train.add_argument("--smoke", action="store_true", help="Two-step synthetic plumbing test; never promotion eligible")
    register = sub.add_parser("register", help="Create a new immutable local model entry")
    register.add_argument("--config", default="config.json")
    register.add_argument("--name", required=True)
    register.add_argument("--result", help="Training result JSON; omit for the original base model")
    register.add_argument("--output", required=True)
    serve = sub.add_parser("serve", help="Loopback-only inference for the selected model; no training functions")
    selection = serve.add_mutually_exclusive_group(required=True)
    selection.add_argument("--registration")
    selection.add_argument("--selection", help="Local pointer written by cli.mts select")
    serve.add_argument("--port", type=int, default=18089)
    serve.add_argument("--unconstrained", action="store_true")
    merge = sub.add_parser("merge", help="Create separate merged HF weights for optional GGUF conversion")
    merge.add_argument("--registration", required=True)
    merge.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "probe":
        from hardware import gpu_probe
        print(json.dumps(gpu_probe()))
    elif args.command == "doctor":
        from hardware import inventory, probe_isolated
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        value = {"hardware": inventory(destination.parent), "probe": probe_isolated()}
        write(destination, value, exclusive=True)
        print(json.dumps(value["probe"]))
        return 0 if value["probe"]["ok"] else 2
    elif args.command == "train":
        from training import train
        train(args)
    else:
        from inference import register, serve, merge
        {"register": register, "serve": serve, "merge": merge}[args.command](args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
