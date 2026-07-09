#!/usr/bin/env python3
"""Merge FUSE-IXD HTML dashboards into a single SPA (fuse.html)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SOURCES = [
    ("fuse-ixd.html", "ixd", "IXD"),
    ("fuse-ibd.html", "ibd", "IBD"),
    ("fuse-anti.html", "anti", "ANTI"),
    ("fuse-obd.html", "obd", "OBD"),
    ("fuse-cdt.html", "cdt", "CDT·WM"),
    ("obd-east-west.html", "obd-east-west", "OBD E/W"),
]

PILL_CLASS = {
    "ixd": "p-ixd",
    "ibd": "p-ib",
    "anti": "p-anti",
    "obd": "p-ob",
    "cdt": "p-cdt",
    "obd-east-west": "p-ob",
}


def read_html(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def extract_styles(html: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"<style[^>]*>(.*?)</style>", html, re.I | re.S)]


def extract_shell(html: str) -> str:
    html_no_nav = re.sub(r"<nav[^>]*class=\"fuse-nav\"[^>]*>.*?</nav>", "", html, flags=re.I | re.S)
    m = re.search(
        r'<div class="shell">(.*?)(?=<!--\s*(?:Endpoints|Paste)|<div class="modal")',
        html_no_nav,
        re.I | re.S,
    )
    if m:
        return m.group(1).strip()
    m2 = re.search(r'<div class="shell">(.*?</div>)\s*(?=<!--|<div class="modal")', html_no_nav, re.I | re.S)
    if m2:
        return m2.group(1).strip()
    body = re.search(r"<body[^>]*>(.*)</body>", html_no_nav, re.I | re.S)
    if not body:
        return ""
    chunk = body.group(1)
    chunk = re.sub(r"<script[^>]*>.*?</script>", "", chunk, flags=re.I | re.S)
    chunk = re.sub(r'<div class="modal".*', "", chunk, flags=re.I | re.S)
    return chunk.strip()


def extract_modals(html: str) -> str:
    return "\n".join(re.findall(r'(<div class="modal"[^>]*>.*?</div>\s*</div>)', html, re.I | re.S))


def extract_script(html: str) -> str:
    scripts = [m.group(1).strip() for m in re.finditer(r"<script[^>]*>(.*?)</script>", html, re.I | re.S)]
    return "\n\n".join(scripts)


def dedupe_styles(styles: list[str]) -> str:
    seen: set[str] = set()
    out: list[str] = []
    for block in styles:
        key = re.sub(r"\s+", " ", block.strip())
        if key and key not in seen:
            seen.add(key)
            out.append(block)
    extra = """
.view-panel{display:none}
.view-panel.active{display:block}
.pills button{display:inline-flex;align-items:center;height:28px;padding:0 11px;border-radius:6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-decoration:none;color:rgba(255,255,255,.45);transition:all .15s;border:none;background:transparent;cursor:pointer;font-family:inherit}
.pills button:hover{background:rgba(255,255,255,.1);color:#fff}
.pills button.p-ixd.active{background:var(--teal);color:#fff}
.pills button.p-ib.active,.pills button.p-anti.active{background:#1d4ed8;color:#fff}
.pills button.p-ob.active,.pills button.p-cdt.active{background:#b45309;color:#fff}
.brand{cursor:pointer}
""".strip()
    if extra not in seen:
        out.append(extra)
    return "\n".join(out)


def build_nav(present: list[tuple[str, str, str]], default_view: str) -> str:
    pills = []
    for _fname, vid, label in present:
        active = " active" if vid == default_view else ""
        pills.append(
            f'<button type="button" class="{PILL_CLASS[vid]}{active}" data-view="{vid}" '
            f'onclick="fuseShowView(\'{vid}\')">{label}</button>'
        )
    default_label = next(l for v, l in ((x[1], x[2]) for x in present) if v == default_view)
    return f"""<nav class="fuse-nav">
  <a class="brand" href="#" onclick="fuseShowView('{default_view}');return false">FUSE <em id="nav-sub">v001 · {default_label}</em></a>
  <div class="pills">
    {' '.join(pills)}
  </div>
  <span class="nclock" id="clock">--:--:--</span>
</nav>"""


def build_views(present: list[tuple[str, str, str]], shells: dict[str, str], default_view: str) -> str:
    parts = []
    for _fname, vid, _label in present:
        active = " active" if vid == default_view else ""
        parts.append(
            f'<section class="view-panel shell{active}" id="view-{vid}" data-view="{vid}">\n'
            f"{shells[vid]}\n</section>"
        )
    return "\n".join(parts)


def inject_view_router(script: str, default_view: str, present_ids: list[str]) -> str:
    labels = {x[1]: x[2] for x in SOURCES}
    router = f"""
// ── FUSE merged SPA view router ──
const FUSE_VIEWS = {present_ids!r};
const FUSE_DEFAULT_VIEW = {default_view!r};
const FUSE_VIEW_LABELS = { {k: labels[k] for k in present_ids} !r};

function fuseShowView(id) {{
  if (!FUSE_VIEWS.includes(id)) return;
  document.querySelectorAll('.view-panel').forEach(el => el.classList.toggle('active', el.dataset.view === id));
  document.querySelectorAll('.pills button[data-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.view === id));
  const sub = document.getElementById('nav-sub');
  if (sub) sub.textContent = 'v001 · ' + (FUSE_VIEW_LABELS[id] || id.toUpperCase());
  try {{ localStorage.setItem('fuse.activeView', id); }} catch (e) {{}}
  if (id === 'obd-east-west' || id === 'obd') {{ try {{ renderAll(); }} catch (e) {{}} }}
  if (id === 'cdt' || id === 'obd-east-west') {{ try {{ renderCWM(); }} catch (e) {{}} }}
}}

(function fuseInitView() {{
  let v = FUSE_DEFAULT_VIEW;
  try {{ v = localStorage.getItem('fuse.activeView') || v; }} catch (e) {{}}
  if (!document.getElementById('view-' + v)) v = FUSE_DEFAULT_VIEW;
  fuseShowView(v);
}})();
"""
    return script + "\n" + router


def merge(source_dir: Path, output: Path) -> None:
    present: list[tuple[str, str, str]] = []
    all_styles: list[str] = []
    shells: dict[str, str] = {}
    modal_html = ""
    primary_script = ""

    for fname, vid, label in SOURCES:
        path = source_dir / fname
        if not path.is_file():
            print(f"skip missing: {path}", file=sys.stderr)
            continue
        html = read_html(path)
        present.append((fname, vid, label))
        all_styles.extend(extract_styles(html))
        shells[vid] = extract_shell(html)
        if not modal_html:
            modal_html = extract_modals(html)
        if fname == "obd-east-west.html" or not primary_script:
            primary_script = extract_script(html)

    if not present:
        print("No source HTML files found.", file=sys.stderr)
        sys.exit(1)

    default_view = present[0][1]
    if any(v == "obd-east-west" for _, v, _ in present):
        default_view = "ixd" if any(v == "ixd" for _, v, _ in present) else "obd-east-west"

    nav = build_nav(present, default_view)
    views = build_views(present, shells, default_view)
    styles = dedupe_styles(all_styles)
    script = inject_view_router(primary_script, default_view, [x[1] for x in present])

    out = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>FUSE · IXD Operations Hub</title>
<style>
{styles}
</style>
</head>
<body>

{nav}

{views}

{modal_html}

<script>
{script}
</script>
</body>
</html>
"""
    output.write_text(out, encoding="utf-8")
    print(f"Wrote {output} ({len(present)} views: {', '.join(v for _, v, _ in present)})")


def main() -> None:
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "FUSE-IXD")
    output = Path(sys.argv[2] if len(sys.argv) > 2 else "fuse.html")
    merge(source, output)


if __name__ == "__main__":
    main()
