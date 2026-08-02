"""L2 document extractor — ingest docx / pdf / csv / xls(x) / md / txt.

Unlike the code extractors (CodeGraph, Graphify) which parse source trees, this
turns human documents into the SAME schema: one DOCUMENT node per file, one
DOC_SECTION node per retrievable chunk, CONTAINS edges between them. The chunk
TEXT is emitted separately as `Passage` records for the sidecar store
(graph/doc_store.py) so it never bloats graph.json.

All parsers are pure Python (pypdf / python-docx / openpyxl / xlrd / stdlib) so
they install on the Python 3.14 venv where native-wheel libs don't. A file that
fails to parse is skipped with a warning — one bad file never breaks a build.

Chunking: sections are split to ~ATHENA_DOC_CHUNK_CHARS with a small overlap so
a passage stays self-contained for BM25/embedding retrieval while keeping a
meaningful locator (page N / heading / sheet + row range).
"""

from __future__ import annotations

import csv as csvmod
import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import config
from graph.doc_store import Passage
from graph.schema import Edge, EdgeType, Node, NodeType, Provenance, Source

# extension -> logical format
_FORMATS = {
    ".pdf": "pdf",
    ".docx": "docx",
    ".csv": "csv",
    ".tsv": "csv",
    ".xlsx": "xlsx",
    ".xlsm": "xlsx",
    ".xls": "xls",
    ".md": "text",
    ".markdown": "text",
    ".txt": "text",
    ".rst": "text",
}

SUPPORTED_EXTENSIONS = tuple(sorted(_FORMATS))


@dataclass(slots=True)
class _Section:
    title: str       # short heading for the chunk
    locator: str     # human "where": page 3 / Sheet 'Fees' rows 1-40
    text: str        # body text (retrievable)


def _chunk(text: str, title: str, locator: str) -> list[_Section]:
    """Split a long block on paragraph boundaries into ~budget-sized chunks."""
    text = text.strip()
    if not text:
        return []
    budget = config.int_env("ATHENA_DOC_CHUNK_CHARS", 1500)
    overlap = config.int_env("ATHENA_DOC_CHUNK_OVERLAP", 150)
    if len(text) <= budget:
        return [_Section(title, locator, text)]

    paras = [p for p in text.split("\n") if p.strip()]
    out, buf = [], ""
    for para in paras:
        if buf and len(buf) + len(para) + 1 > budget:
            out.append(buf.strip())
            buf = (buf[-overlap:] + "\n" + para) if overlap else para
        else:
            buf = f"{buf}\n{para}" if buf else para
    if buf.strip():
        out.append(buf.strip())

    if len(out) == 1:
        return [_Section(title, locator, out[0])]
    return [
        _Section(f"{title} ({i + 1}/{len(out)})", f"{locator} · part {i + 1}", body)
        for i, body in enumerate(out)
    ]


# --- per-format parsers: each yields raw (title, locator, text) sections ------
def _parse_pdf(path: Path) -> Iterator[_Section]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            yield from _chunk(text, f"Page {i}", f"page {i}")


def _parse_docx(path: Path) -> Iterator[_Section]:
    import docx

    doc = docx.Document(str(path))
    title, buf = "Introduction", []

    def flush(t, lines):
        body = "\n".join(lines).strip()
        return _chunk(body, t, t) if body else []

    for para in doc.paragraphs:
        style = (para.style.name if para.style else "") or ""
        line = para.text.strip()
        if style.startswith("Heading") and line:
            yield from flush(title, buf)
            title, buf = line, []
        elif line:
            buf.append(line)
    yield from flush(title, buf)

    for ti, table in enumerate(doc.tables, start=1):
        rows = [
            " | ".join(c.text.strip() for c in row.cells)
            for row in table.rows
            if any(c.text.strip() for c in row.cells)
        ]
        if rows:
            yield from _chunk("\n".join(rows), f"Table {ti}", f"table {ti}")


def _rows_to_sections(
    rows: Iterator[list[str]], sheet: str
) -> Iterator[_Section]:
    """Render tabular rows as 'header: value' lines, grouped to the char budget."""
    rows = [[("" if c is None else str(c)).strip() for c in r] for r in rows]
    rows = [r for r in rows if any(r)]
    if not rows:
        return
    header = rows[0]
    budget = config.int_env("ATHENA_DOC_CHUNK_CHARS", 1500)
    buf, start = [], 2  # data rows start at spreadsheet row 2 (1 = header)
    line_no = 2

    def render(cells: list[str]) -> str:
        pairs = [
            f"{header[i]}: {v}" if i < len(header) and header[i] else v
            for i, v in enumerate(cells)
            if v
        ]
        return " | ".join(pairs)

    def emit(first, last):
        body = "\n".join(buf)
        loc = f"sheet '{sheet}' rows {first}-{last}"
        yield from _chunk(body, f"{sheet} rows {first}-{last}", loc)

    for r in rows[1:]:
        rendered = render(r)
        if buf and sum(len(x) for x in buf) + len(rendered) > budget:
            yield from emit(start, line_no - 1)
            buf, start = [], line_no
        buf.append(rendered)
        line_no += 1
    if buf:
        yield from emit(start, line_no - 1)


def _parse_csv(path: Path) -> Iterator[_Section]:
    delim = "\t" if path.suffix.lower() == ".tsv" else ","
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        yield from _rows_to_sections(csvmod.reader(f, delimiter=delim), path.stem)


def _parse_xlsx(path: Path) -> Iterator[_Section]:
    from openpyxl import load_workbook

    wb = load_workbook(str(path), read_only=True, data_only=True)
    try:
        for ws in wb.worksheets:
            yield from _rows_to_sections(ws.iter_rows(values_only=True), ws.title)
    finally:
        wb.close()


def _parse_xls(path: Path) -> Iterator[_Section]:
    import xlrd

    book = xlrd.open_workbook(str(path))
    for sheet in book.sheets():
        rows = (sheet.row_values(r) for r in range(sheet.nrows))
        yield from _rows_to_sections(rows, sheet.name)


def _parse_text(path: Path) -> Iterator[_Section]:
    text = path.read_text(encoding="utf-8", errors="replace")
    # Split markdown-ish on headings so sections keep their titles.
    title, buf = path.stem, []
    for raw in text.splitlines():
        if raw.startswith("#"):
            body = "\n".join(buf).strip()
            if body:
                yield from _chunk(body, title, title)
            title, buf = raw.lstrip("# ").strip() or path.stem, []
        else:
            buf.append(raw)
    body = "\n".join(buf).strip()
    if body:
        yield from _chunk(body, title, title)


_PARSERS = {
    "pdf": _parse_pdf,
    "docx": _parse_docx,
    "csv": _parse_csv,
    "xlsx": _parse_xlsx,
    "xls": _parse_xls,
    "text": _parse_text,
}


class DocumentExtractor:
    """Walk one or more roots for supported documents and normalise them."""

    def __init__(self, roots: list[str | Path]):
        self.roots = [Path(r) for r in roots]
        self._nodes: list[Node] = []
        self._edges: list[Edge] = []
        self._passages: list[Passage] = []
        self.errors: list[str] = []
        self._built = False

    # --- discovery -------------------------------------------------------
    def _files(self) -> list[Path]:
        seen: set[Path] = set()
        out: list[Path] = []
        for root in self.roots:
            if not root.exists():
                continue
            if root.is_file():
                candidates = [root]
            else:
                candidates = sorted(root.rglob("*"))
            for p in candidates:
                rp = p.resolve()
                if (
                    p.is_file()
                    and p.suffix.lower() in _FORMATS
                    and not p.name.startswith("~$")  # office lock files
                    and rp not in seen
                ):
                    seen.add(rp)
                    out.append(p)
        return out

    # --- build -----------------------------------------------------------
    def build(self) -> "DocumentExtractor":
        for path in self._files():
            try:
                self._ingest(path)
            except Exception as e:  # noqa: BLE001 — one bad file must not break the build
                self.errors.append(f"{path.name}: {type(e).__name__}: {e}")
        self._built = True
        return self

    def _ingest(self, path: Path) -> None:
        fmt = _FORMATS[path.suffix.lower()]
        sections = [s for s in _PARSERS[fmt](path) if s.text.strip()]
        if not sections:
            return
        doc_id = f"doc:{hashlib.sha1(str(path.resolve()).encode()).hexdigest()[:10]}"
        display = self._display_path(path)
        self._nodes.append(
            Node(
                id=doc_id,
                type=NodeType.DOCUMENT,
                name=path.name,
                source=Source.DOCS,
                path=display,
                properties={
                    "file_type": fmt,
                    "abspath": str(path.resolve()),
                    "size_bytes": path.stat().st_size,
                    "sections": len(sections),
                },
            )
        )
        for i, sec in enumerate(sections):
            sid = f"{doc_id}#{i}"
            self._nodes.append(
                Node(
                    id=sid,
                    type=NodeType.DOC_SECTION,
                    name=sec.title,
                    source=Source.DOCS,
                    path=display,
                    properties={"locator": sec.locator, "index": i, "document": path.name},
                )
            )
            self._edges.append(
                Edge(
                    src=doc_id,
                    dst=sid,
                    type=EdgeType.CONTAINS,
                    source=Source.DOCS,
                    provenance=Provenance.EXTRACTED,
                )
            )
            self._passages.append(
                Passage(
                    id=sid,
                    doc_id=doc_id,
                    doc_name=path.name,
                    path=display,
                    title=sec.title,
                    locator=sec.locator,
                    text=sec.text,
                )
            )

    def _display_path(self, path: Path) -> str:
        try:
            return str(path.resolve().relative_to(config.PROJECT_ROOT))
        except ValueError:
            return str(path.resolve())

    # --- outputs ---------------------------------------------------------
    def nodes(self) -> list[Node]:
        return self._nodes

    def edges(self) -> list[Edge]:
        return self._edges

    def passages(self) -> list[Passage]:
        return self._passages
