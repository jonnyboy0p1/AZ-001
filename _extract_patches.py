import json, os, glob

transcript_dir = r'C:\Users\jonavroa\.cursor\projects\c-Users-jonavroa-Desktop-Echos-RB20\agent-transcripts'
out_dir = r'C:\Users\jonavroa\Desktop\Echos\RB20\_recovery'
os.makedirs(out_dir, exist_ok=True)

patches = []
for path in glob.glob(os.path.join(transcript_dir, '**', '*.jsonl'), recursive=True):
    with open(path, 'r', encoding='utf-8') as f:
        for lineno, line in enumerate(f, 1):
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = obj.get('message', {}).get('content', [])
            if not isinstance(content, list):
                continue
            for item in content:
                if item.get('type') != 'tool_use' or item.get('name') != 'StrReplace':
                    continue
                inp = item.get('input', {})
                p = inp.get('path', '')
                if 'rb20-bridge' not in p:
                    continue
                patches.append({
                    'source': path,
                    'line': lineno,
                    'old': inp.get('old_string', ''),
                    'new': inp.get('new_string', ''),
                })

print(f'Found {len(patches)} patches')
for i, p in enumerate(patches):
    fname = os.path.join(out_dir, f'patch_{i+1:02d}_old.txt')
    with open(fname, 'w', encoding='utf-8') as f:
        f.write(p['old'])
    fname = os.path.join(out_dir, f'patch_{i+1:02d}_new.txt')
    with open(fname, 'w', encoding='utf-8') as f:
        f.write(p['new'])
    print(f'{i+1}. line {p["line"]} old={len(p["old"])} new={len(p["new"])} from {os.path.basename(p["source"])}')
