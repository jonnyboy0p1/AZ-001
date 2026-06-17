#!/usr/bin/env python3
"""
Generate weight-heatmap-mock.xlsx — a self-contained mock to test the weight
heat-map logic in Excel. Pure standard library (no openpyxl required).

The sheet carries live formulas (Fill %, 5% bucket, fill rate, ETA-to-full) and
a conditional-formatting heat scale: 0% grey -> 5% green -> ~50% yellow -> 100%
red. 100% is anchored to the target weight in column F (40,000 lb). Change any
Payload in column E and the % and its colour recalculate.

Usage:  python build_mock_xlsx.py
"""

import math
import zipfile

TARGET = 40000  # lb that equals 100%

# destination, trailerId, liveRate(jobs/hr), contentCount, payloadWeight(lb)
DATA = [
    ("SBN1 (RFD2→SBN1)", "YTF21313988237", 772, 1760, 36953.9),
    ("MKE2_CASE",             "YTF44120097713", 772,  410,  8200.0),
    ("DET6",                  "YTF55013377420", 540, 1080, 22500.0),
    ("ORD9",                  "YTF88820041190", 610, 2050, 39200.0),
    ("MDW2",                  "YTF20391100245", 480,    0,     0.0),
]

HEADERS = ["Destination (ARC)", "Trailer", "Live Rate (jobs/hr)", "Content",
           "Payload (lb)", "Target (lb) = 100%", "Fill %", "Bucket 5%",
           "Fill Rate (lb/hr)", "ETA to Full (hr)"]


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def col(n):  # 1->A, 7->G
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


# ── compute cached values (Excel recalculates on open too) ──────────────────────
def compute(rate, count, payload, target):
    g = payload / target if target else 0
    h = math.floor(g / 0.05) * 0.05
    wpu = payload / count if count else 0
    i = rate * wpu
    remaining = target - payload
    # 0 = no live rate or already full; the "—" number format hides the zero
    j = remaining / i if (i > 0 and remaining > 0) else 0.0
    return g, h, i, j


# ── sheet XML ───────────────────────────────────────────────────────────────────
def num_cell(ref, val, s):
    return f'<c r="{ref}" s="{s}"><v>{val}</v></c>'

def str_cell(ref, val, s):
    return f'<c r="{ref}" t="inlineStr" s="{s}"><is><t xml:space="preserve">{esc(val)}</t></is></c>'

def f_cell(ref, formula, val, s, is_str=False):
    t = ' t="str"' if is_str else ""
    v = "" if (is_str and val == "") else val
    return f'<c r="{ref}" s="{s}"{t}><f>{esc(formula)}</f><v>{v}</v></c>'


def build_sheet():
    rows = []

    # header (row 1) — style s1
    cells = "".join(str_cell(f"{col(c+1)}1", HEADERS[c], 1) for c in range(len(HEADERS)))
    rows.append(f'<row r="1">{cells}</row>')

    # data (rows 2..N)
    for idx, (dest, tid, rate, count, payload) in enumerate(DATA):
        r = idx + 2
        g, h, i, j = compute(rate, count, payload, TARGET)
        c = []
        c.append(str_cell(f"A{r}", dest, 0))
        c.append(str_cell(f"B{r}", tid, 0))
        c.append(num_cell(f"C{r}", rate, 3))
        c.append(num_cell(f"D{r}", count, 3))
        c.append(num_cell(f"E{r}", payload, 4))
        c.append(num_cell(f"F{r}", TARGET, 3))
        c.append(f_cell(f"G{r}", f"IF(F{r}=0,0,E{r}/F{r})", repr(g), 2))
        c.append(f_cell(f"H{r}", f"FLOOR(G{r},0.05)", repr(h), 2))
        c.append(f_cell(f"I{r}", f"IF(D{r}=0,0,C{r}*(E{r}/D{r}))", repr(i), 3))
        c.append(f_cell(f"J{r}", f"IF(I{r}=0,0,(F{r}-E{r})/I{r})", repr(j), 5))
        rows.append(f'<row r="{r}">{"".join(c)}</row>')

    last = len(DATA) + 1  # last data row index

    # notes
    note1 = ("Test me: change a Payload in column E — Fill % (col G) and its "
             "colour update live. 100% = 40,000 lb (column F).")
    note2 = ("Heat scale (Conditional Formatting on col G): grey=empty · green=filling · "
             "yellow=28,000 lb dispatch floor (70%) · red=40,000 lb cube-out.")
    rows.append(f'<row r="{last+2}">{str_cell(f"A{last+2}", note1, 0)}</row>')
    rows.append(f'<row r="{last+3}">{str_cell(f"A{last+3}", note2, 0)}</row>')

    cf_range = f"G2:G{last}"
    cond = (
        f'<conditionalFormatting sqref="{cf_range}">'
        f'<cfRule type="cellIs" dxfId="0" priority="1" operator="equal" stopIfTrue="1"><formula>0</formula></cfRule>'
        # midpoint (yellow) anchored at the 28k dispatch floor = 70% of 40k,
        # so colour spreads across the real 28k-40k window instead of all-red
        f'<cfRule type="colorScale" priority="2"><colorScale>'
        f'<cfvo type="num" val="0.05"/><cfvo type="num" val="0.70"/><cfvo type="num" val="1"/>'
        f'<color rgb="FF38A169"/><color rgb="FFF6E05E"/><color rgb="FFE53E3E"/>'
        f'</colorScale></cfRule></conditionalFormatting>'
    )

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<cols>'
        '<col min="1" max="1" width="22" customWidth="1"/>'
        '<col min="2" max="2" width="18" customWidth="1"/>'
        '<col min="3" max="6" width="15" customWidth="1"/>'
        '<col min="7" max="10" width="13" customWidth="1"/>'
        '</cols>'
        f'<sheetData>{"".join(rows)}</sheetData>'
        f'{cond}'
        '</worksheet>'
    )


STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<numFmts count="3">'
    '<numFmt numFmtId="164" formatCode="#,##0"/>'
    '<numFmt numFmtId="165" formatCode="#,##0.0"/>'
    '<numFmt numFmtId="166" formatCode="0.00;-0.00;&quot;—&quot;"/>'
    '</numFmts>'
    '<fonts count="2">'
    '<font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
    '</fonts>'
    '<fills count="3">'
    '<fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill>'
    '<fill><patternFill patternType="solid"><fgColor rgb="FF3D4F64"/><bgColor indexed="64"/></patternFill></fill>'
    '</fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="6">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" wrapText="1"/></xf>'
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFA0AEC0"/></patternFill></fill></dxf></dxfs>'
    '</styleSheet>'
)

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    '</Types>'
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)

WB_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    '</Relationships>'
)

WORKBOOK = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Heatmap" sheetId="1" r:id="rId1"/></sheets>'
    '<calcPr fullCalcOnLoad="1"/>'
    '</workbook>'
)


def main():
    out = "weight-heatmap-mock.xlsx"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", WB_RELS)
        z.writestr("xl/styles.xml", STYLES)
        z.writestr("xl/worksheets/sheet1.xml", build_sheet())
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
