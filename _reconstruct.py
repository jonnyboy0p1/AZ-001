"""Reconstruct rb21-bridge.user.js from a base file and transcript patches."""

import json
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
PROJECT_ROOT = Path(CONFIG["projectRoot"])

BASE = PROJECT_ROOT / "_recovery" / "rb21-bridge-base.user.js"
OUT = PROJECT_ROOT / "_recovery" / "rb21-bridge-reconstructed.user.js"
transcript_dir = PROJECT_ROOT / "_recovery" / "agent-transcripts"

ordered = [
    "d3ab4406-1292-4a26-9aca-bf563708a7b2",
    "ae9e2ebb-d3bc-4953-9dfd-5c83cca6c270",
    "d75608c0-6ba1-4d9c-89ab-578f2126e9bf",
]

seen = set()
patches = []
for tid in ordered:
    path = transcript_dir / tid / f"{tid}.jsonl"
    if not path.exists():
        continue
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            for item in obj.get("message", {}).get("content", []):
                if item.get("type") != "tool_use" or item.get("name") != "StrReplace":
                    continue
                inp = item.get("input", {})
                bridge_path = inp.get("path", "")
                if "rb21-bridge" not in bridge_path and "rb20-bridge" not in bridge_path:
                    continue
                key = (inp.get("old_string", ""), inp.get("new_string", ""))
                if key in seen:
                    continue
                seen.add(key)
                patches.append((inp.get("old_string", ""), inp.get("new_string", "")))

if not BASE.exists():
    raise SystemExit(f"Base file not found: {BASE}")

shutil.copy2(BASE, OUT)
content = OUT.read_text(encoding="utf-8")

applied = 0
failed = []
for i, (old, new) in enumerate(patches):
    if not old:
        failed.append((i + 1, "empty old_string"))
        continue
    if old in content:
        content = content.replace(old, new, 1)
        applied += 1
    else:
        failed.append((i + 1, f"old_string not found ({len(old)} chars)"))

OUT.write_text(content, encoding="utf-8", newline="\n")

lines = content.count("\n") + 1
print(f"Project root: {PROJECT_ROOT}")
print(f"Base: {BASE}")
print(f"Output: {OUT}")
print(f"Patches total: {len(patches)}, applied: {applied}, failed: {len(failed)}")
print(f"Reconstructed lines: {lines}, bytes: {len(content.encode('utf-8'))}")
if failed:
    print("Failed patches:")
    for num, reason in failed:
        print(f"  #{num}: {reason}")

m = re.search(r"@version\s+(\S+)", content)
print(f"Version: {m.group(1) if m else 'unknown'}")
for feat in [
    "OB_GOAL_ROWS",
    "pullNeoInBackground",
    "findTransferOutDockSection",
    "PRC_V2_LIVE_FETCH",
    "ob/obd",
    "RB021 Bridge",
]:
    print(f"  {feat}: {'YES' if feat in content else 'NO'}")
