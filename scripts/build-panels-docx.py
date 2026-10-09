# Builds docs/PANELS.docx from docs/PANELS.md.
# Run from the repo root:  python scripts/build-panels-docx.py
#
# Reads the markdown rather than re-declaring the content, so the two stay in
# sync by construction. Only the subset of markdown PANELS.md actually uses is
# handled: ATX headings, bullet lists, and pipe tables.

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "PANELS.md"
OUT = ROOT / "docs" / "PANELS.docx"

ACCENT = RGBColor(0x1F, 0x4E, 0x79)
MUTED = RGBColor(0x5A, 0x5A, 0x5A)
CODE_BG = "F2F4F7"
HEAD_BG = "1F4E79"
ZEBRA_BG = "F7F9FC"

HEADING_SIZES = {1: 20, 2: 16, 3: 13, 4: 11.5, 5: 11, 6: 11}


def shade(cell_or_para, hex_fill):
    """Applies a solid background. python-docx exposes no API for this, so the
    w:shd element is written onto the tcPr / pPr directly."""
    el = OxmlElement("w:shd")
    el.set(qn("w:val"), "clear")
    el.set(qn("w:color"), "auto")
    el.set(qn("w:fill"), hex_fill)
    if hasattr(cell_or_para, "_tc"):
        cell_or_para._tc.get_or_add_tcPr().append(el)
    else:
        cell_or_para._p.get_or_add_pPr().append(el)


def code_run(paragraph, text, size=Pt(9), bold=False):
    run = paragraph.add_run(text)
    run.bold = bold
    run.font.name = "Consolas"
    run.font.size = size
    run.font.color.rgb = RGBColor(0xB0, 0x1C, 0x2E)
    # East-Asian font hint, otherwise Word substitutes a proportional face for
    # anything outside ASCII.
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), "Consolas")
    rfonts.set(qn("w:hAnsi"), "Consolas")
    return run


# One tokenizer, not two independent regexes. A bold span may contain a code
# span (e.g. **`<CONST>` is hardcoded**); splitting on code first would leave
# the orphaned ** on either side of it, which then never matches as bold.
TOKEN = re.compile(r"`([^`]+)`|\*\*([^*]+)\*\*")


def add_inline(paragraph, text, base_bold=False, size=None, color=None):
    """Renders inline markdown. A bold match recurses so nested code spans
    inside it are still emitted as code."""
    pos = 0
    for m in TOKEN.finditer(text):
        if m.start() > pos:
            _emit(paragraph, text[pos:m.start()], base_bold, size, color)
        if m.group(1) is not None:
            code_run(paragraph, m.group(1), size=size or Pt(9.5), bold=base_bold)
        else:
            add_inline(paragraph, m.group(2), base_bold=True, size=size, color=color)
        pos = m.end()
    if pos < len(text):
        _emit(paragraph, text[pos:], base_bold, size, color)


def _emit(paragraph, text, bold, size, color):
    if not text:
        return
    run = paragraph.add_run(text)
    run.bold = bold
    if size:
        run.font.size = size
    if color:
        run.font.color.rgb = color
    return run


def strip_marks(cell_text):
    return TOKEN.sub(lambda m: m.group(1) or m.group(2), cell_text).strip()


def flush_table(doc, rows, header_bold=True):
    """rows[0] is the header. Column widths are proportional to the longest
    cell in each column, clamped so a wide middle column cannot squeeze the
    label column into wrapping one word per line."""
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]

    longest = [max(len(strip_marks(r[c])) for r in rows) for c in range(ncols)]
    total = sum(longest) or 1
    usable = Inches(6.9)
    widths = [Inches(max(0.55, usable * (l / total))) for l in longest]
    scale = usable / sum(widths)
    widths = [int(w * scale) for w in widths]

    table = doc.add_table(rows=0, cols=ncols)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False

    for i, row in enumerate(rows):
        cells = table.add_row().cells
        for c in range(ncols):
            cell = cells[c]
            cell.width = widths[c]
            para = cell.paragraphs[0]
            para.paragraph_format.space_before = Pt(2)
            para.paragraph_format.space_after = Pt(2)
            add_inline(para, row[c], base_bold=(i == 0 and header_bold))
            if i == 0:
                for run in para.runs:
                    run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                    run.font.size = Pt(9.5)
                shade(cell, HEAD_BG)
            elif i % 2 == 0:
                shade(cell, ZEBRA_BG)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


def build():
    if not SRC.exists():
        sys.exit(f"missing source: {SRC}")

    lines = SRC.read_text(encoding="utf-8").splitlines()

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(4)

    for section in doc.sections:
        section.left_margin = Inches(0.8)
        section.right_margin = Inches(0.8)
        section.top_margin = Inches(0.8)
        section.bottom_margin = Inches(0.8)

    first_h1 = True
    i = 0
    bullets = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code block: verbatim, shaded, monospace.
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            for b in buf:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Inches(0.25)
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.space_before = Pt(0)
                code_run(p, b if b.strip() else " ", Pt(9))
                shade(p, CODE_BG)
            doc.add_paragraph().paragraph_format.space_after = Pt(4)
            continue

        # Horizontal rule -> thin separator paragraph.
        if stripped in ("---", "***", "___"):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(6)
            pbdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:color"), "D0D7E2")
            pbdr.append(bottom)
            p._p.get_or_add_pPr().append(pbdr)
            i += 1
            continue

        # Pipe table: a header row followed by a |---|---| separator row.
        if stripped.startswith("|") and i + 1 < len(lines) and re.match(
            r"^\|[\s:|-]+\|?$", lines[i + 1].strip()
        ):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                raw = lines[i].strip()
                if not re.match(r"^\|[\s:|-]+\|?$", raw):
                    rows.append([strip_marks(c) for c in raw.strip("|").split("|")])
                i += 1
            flush_table(doc, rows)
            continue

        # ATX heading.
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            text = m.group(2).strip()
            if level == 1 and first_h1:
                # The markdown H1 duplicates the doc title; make it the title.
                title = doc.add_heading(level=0)
                add_inline(title, text)
                for run in title.runs:
                    run.font.color.rgb = ACCENT
                first_h1 = False
            else:
                h = doc.add_heading(level=level)
                add_inline(h, text)
                for run in h.runs:
                    run.font.color.rgb = ACCENT
            i += 1
            continue

        # Bullet list item. "  - " is nesting, rendered as an indent bump only:
        # PANELS.md never goes deeper than one level, so there is no marker to
        # choose between and a flat bullet with an indent reads correctly.
        m = re.match(r"^(\s*)-\s+(.*)$", line)
        if m:
            depth = len(m.group(1)) // 2
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.left_indent = Inches(0.25 + 0.25 * depth)
            p.paragraph_format.space_after = Pt(2)
            add_inline(p, m.group(2))
            bullets += 1
            i += 1
            continue

        if stripped:
            p = doc.add_paragraph()
            add_inline(p, stripped)
        i += 1

    doc.save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}  ({len(doc.paragraphs)} paragraphs, "
          f"{len(doc.tables)} tables, {bullets} bullets)")


if __name__ == "__main__":
    build()