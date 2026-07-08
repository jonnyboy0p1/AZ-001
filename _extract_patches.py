"""Extract rb21-bridge StrReplace patches from Cursor agent transcripts."""

import json
import glob
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
PROJECT_ROOT = Path(CONFIG["projectRoot"])
transcript_dir = PROJECT_ROOT / "_recovery" / "agent-transcripts"
out_dir = PROJECT_ROOT / "_recovery"
os.makedirs(out_dir, exist_ok=True)

patches = []
for path in glob.glob(str(transcript_dir / "**" / "*.jsonl"), recursive=True):
    with open(path, "r", encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = obj.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for item in content:
                if item.get("type") != "tool_use" or item.get("name") != "StrReplace":
                    continue
                inp = item.get("input", {})
                p = inp.get("path", "")
                if "rb21-bridge" not in p and "rb20-bridge" not in p:
                    continue
                patches.append({
                    "source": path,
                    "line": lineno,
                    "old": inp.get("old_string", ""),
                    "new": inp.get("new_string", ""),
                })

print(f"Project root: {PROJECT_ROOT}")
print(f"Found {len(patches)} patches")
for i, p in enumerate(patches):
    fname = out_dir / f"patch_{i + 1:02d}_old.txt"
    fname.write_text(p["old"], encoding="utf-8")
    fname = out_dir / f"patch_{i + 1:02d}_new.txt"
    fname.write_text(p["new"], encoding="utf-8")
    print(f'{i + 1}. line {p["line"]} old={len(p["old"])} new={len(p["new"])} from {os.path.basename(p["source"])}')
