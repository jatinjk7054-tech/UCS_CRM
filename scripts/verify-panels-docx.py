# Verifies docs/PANELS.docx actually contains the panel content, rather than
# trusting that the generator ran. Reads the saved file back with python-docx
# and checks the structural facts a reader would notice being wrong.
#
# Run from the repo root:  python scripts/verify-panels-docx.py

import re
import sys
import zipfile
from pathlib import Path

from docx import Document
from docx.shared import RGBColor

ROOT = Path(__file__).resolve().parent.parent
DOCX = ROOT / "docs" / "PANELS.docx"

# Every panel the markdown documents. Checked against the docx's Heading 2
# runs, so a heading that silently lost its style fails here.
EXPECTED_PANELS = [
    "Super Admin", "HR", "NGO Admin", "Accounts", "FRO", "Event Head",
    "Recruiter", "SIM Card", "Beneficiaries", "Library", "Metropad",
    "WhatsApp", "Documentation", "Dev Panel",
]

# The 14 panels, plus the closing sections PANELS.md ends with. Anything else at
# H2 means a heading silently changed level or the parse drifted.
EXPECTED_H2 = EXPECTED_PANELS + [
    "Which panel do I want?",
    "Menu items shared across panels",
    "Things worth knowing",
]

# Spot-checks that the most important screens survived the conversion. One per
# panel, chosen as the screen someone would look for first.
EXPECTED_NAV = [
    "Dashboard", "Volunteers", "Stations & FROs", "Lead and Audit",
    "My Leads", "Calendar", "Candidates", "Expiring SIMs",
    "Collection OTPs", "Coupons", "Inbox", "Global Auth System",
    "All Tickets",
]

EXPECTED_ROWS = 15  # header + 14 panels

fails = []


def check(label, ok, detail=""):
    if not ok:
        fails.append(f"{label}{': ' + detail if detail else ''}")


if not DOCX.exists():
    sys.exit(f"missing {DOCX}")

doc = Document(DOCX)

# Full text across body paragraphs and every table cell. Word splits runs
# mid-token, so matching against whole paragraphs would miss anything broken
# across a run boundary.
chunks = [p.text for p in doc.paragraphs]
for t in doc.tables:
    for row in t.rows:
        for cell in row.cells:
            chunks.append(cell.text)
blob = "\n".join(chunks)

# A valid zip, i.e. Word will actually open it.
try:
    with zipfile.ZipFile(DOCX) as z:
        check("zip integrity", z.testzip() is None)
        names = z.namelist()
    check("has word/document.xml", "word/document.xml" in names)
    check("has styles.xml", "word/styles.xml" in names)
except zipfile.BadZipFile:
    fails.append("file is not a readable zip / not a real .docx")

h2 = [p.text.strip() for p in doc.paragraphs if p.style.name == "Heading 2"]
check("H2 section count", len(h2) == len(EXPECTED_H2), f"found {len(h2)}")
for want in EXPECTED_H2:
    check(f"H2 section '{want}'", any(want in got for got in h2))

h1 = [p.text.strip() for p in doc.paragraphs if p.style.name == "Title"]
check("document has a title", len(h1) == 1, f"found {h1}")

for name in EXPECTED_NAV:
    check(f"nav item '{name}'", name in blob)

# The "which panel do I want" table must survive as a real table.
check("panel table rendered", len(doc.tables) >= 1, f"{len(doc.tables)} tables")
if doc.tables:
    t = doc.tables[0]
    check("panel table row count", len(t.rows) == EXPECTED_ROWS,
          f"{len(t.rows)} rows")
    check("panel table 3 columns", len(t.columns) == 3)

# Bullets: PANELS.md is mostly a menu inventory, so a collapsed list would be
# the most visible possible regression.
bullets = [p for p in doc.paragraphs if p.style.name == "List Bullet"]
check("bullet count", len(bullets) >= 100, f"{len(bullets)} bullets")

# No leftover markdown syntax anywhere.
for bad in ("**", "##", "|---", "`"):
    check(f"no raw '{bad}' in output", bad not in blob)

# Plain-language check: the file is for non-technical readers, so developer
# vocabulary that leaked in from the source reading is a real failure.
JARGON = [
    ".jsx", ".js", "src/", "lazy", "Suspense", "Outlet", "NavLink",
    "iframe", "redirect", "React", "useState", "API", "endpoint",
    "localhost", "role=", "super_admin", "ngo_admin", "event_head",
    "localStorage", "startWith", "tab strip", "nav", "route", "component",
    "predicate", "boolean", "splat", "outlet",
]
for word in JARGON:
    # Word boundaries: a substring test flags "nav" inside "navigate" and
    # "unavailable", which would be a false alarm on perfectly plain English.
    check(f"no developer jargon '{word}'",
          re.search(rf"\b{re.escape(word)}\b", blob, re.IGNORECASE) is None)

print("\n".join(f"FAIL {f}" for f in fails) if fails else "docx verify: all passed")
print(f"  {len(doc.paragraphs)} paragraphs, {len(doc.tables)} tables, "
      f"{len(bullets)} bullets")
sys.exit(1 if fails else 0)