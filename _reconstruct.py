import json, os, glob, shutil

RB = r'C:\$Recycle.Bin\S-1-5-21-1407069837-2091007605-538272213-58887348\$R2OOPM2.js'
OUT = r'C:\Users\jonavroa\Desktop\Echos\RB20\_recovery\rb20-bridge-reconstructed.user.js'
transcript_dir = r'C:\Users\jonavroa\.cursor\projects\c-Users-jonavroa-Desktop-Echos-RB20\agent-transcripts'

# Process transcripts in chronological order (by folder name is unreliable; use explicit order)
ordered = [
    'd3ab4406-1292-4a26-9aca-bf563708a7b2',
    'ae9e2ebb-d3bc-4953-9dfd-5c83cca6c270',
    'd75608c0-6ba1-4d9c-89ab-578f2126e9bf',
]

seen = set()
patches = []
for tid in ordered:
    path = os.path.join(transcript_dir, tid, tid + '.jsonl')
    if not os.path.exists(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            for item in obj.get('message', {}).get('content', []):
                if item.get('type') != 'tool_use' or item.get('name') != 'StrReplace':
                    continue
                inp = item.get('input', {})
                if 'rb20-bridge' not in inp.get('path', ''):
                    continue
                key = (inp.get('old_string', ''), inp.get('new_string', ''))
                if key in seen:
                    continue
                seen.add(key)
                patches.append((inp.get('old_string', ''), inp.get('new_string', '')))

shutil.copy2(RB, OUT)
with open(OUT, 'r', encoding='utf-8') as f:
    content = f.read()

applied = 0
failed = []
for i, (old, new) in enumerate(patches):
    if not old:
        failed.append((i+1, 'empty old_string'))
        continue
    if old in content:
        content = content.replace(old, new, 1)
        applied += 1
    else:
        failed.append((i+1, f'old_string not found ({len(old)} chars)'))

with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    f.write(content)

lines = content.count('\n') + 1
print(f'Base: {RB}')
print(f'Output: {OUT}')
print(f'Patches total: {len(patches)}, applied: {applied}, failed: {len(failed)}')
print(f'Reconstructed lines: {lines}, bytes: {len(content.encode("utf-8"))}')
if failed:
    print('Failed patches:')
    for num, reason in failed:
        print(f'  #{num}: {reason}')
# version check
import re
m = re.search(r'@version\s+(\S+)', content)
print(f'Version: {m.group(1) if m else "unknown"}')
for feat in ['OB_GOAL_ROWS', 'pullNeoInBackground', 'findTransferOutDockSection', 'PRC_V2_LIVE_FETCH', 'ob/obd', 'RB20 Bridge']:
    print(f'  {feat}: {"YES" if feat in content else "NO"}')
