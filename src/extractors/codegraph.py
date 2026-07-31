"""L1 structural extractor — CodeGraph (multi-language, ~30 tree-sitter grammars).

Runs `codegraph init` on a cloned repo (Rust tree-sitter kernel, local SQLite,
no LLM) then reads `.codegraph/codegraph.db` and normalises rows into schema
Nodes/Edges.

Schema below was verified against codegraph 0.x on a real repo (tables
`nodes` / `edges`). `describe()` remains for re-verifying after upgrades.
"""

from __future__ import annotations

import sqlite3
import subprocess
from collections.abc import Iterator
from pathlib import Path

from graph.schema import Edge, EdgeType, Node, NodeType, Provenance, Source

_DB_GLOB = "*.db"

# codegraph `nodes.kind` -> our NodeType
_KIND_TO_NODETYPE = {
    "file": NodeType.FILE,
    "class": NodeType.CLASS,
    "method": NodeType.METHOD,
    "function": NodeType.FUNCTION,
    "constant": NodeType.CONSTANT,
    "enum": NodeType.ENUM,
    "enum_member": NodeType.ENUM_MEMBER,
    "type_alias": NodeType.TYPE_ALIAS,
    "import": NodeType.IMPORT,
}
# codegraph `edges.kind` -> our EdgeType
_REL_TO_EDGETYPE = {
    "contains": EdgeType.CONTAINS,
    "references": EdgeType.REFERENCES,
    "calls": EdgeType.CALLS,
    "imports": EdgeType.IMPORTS,
    "instantiates": EdgeType.INSTANTIATES,
    "extends": EdgeType.EXTENDS,
    "implements": EdgeType.IMPLEMENTS,
}
# Extra node columns worth keeping as properties.
_NODE_EXTRA_COLS = ("signature", "visibility", "start_line", "end_line", "return_type")


class CodeGraphExtractor:
    def __init__(self, repo_path: str | Path, *, cli: str = "codegraph"):
        self.repo_path = Path(repo_path)
        self.repo = self.repo_path.name
        self.cli = cli

    @property
    def db_dir(self) -> Path:
        return self.repo_path / ".codegraph"

    # --- run -------------------------------------------------------------
    def build(self, *, force: bool = False) -> None:
        """Run `codegraph init` to (re)build the local graph for this repo."""
        if self.db_dir.exists() and not force:
            return
        subprocess.run(
            [self.cli, "init"],
            cwd=self.repo_path,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # --- read ------------------------------------------------------------
    def _db_path(self) -> Path:
        dbs = sorted(self.db_dir.glob(_DB_GLOB))
        if not dbs:
            raise FileNotFoundError(
                f"No codegraph db under {self.db_dir}; run build() first"
            )
        return dbs[0]

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self._db_path())
        con.row_factory = sqlite3.Row
        return con

    def describe(self) -> dict[str, list[str]]:
        """Dump {table: [columns]} so the real schema can be confirmed."""
        con = self._connect()
        try:
            schema: dict[str, list[str]] = {}
            for (name,) in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ):
                schema[name] = [
                    r[1] for r in con.execute(f"PRAGMA table_info({name})")
                ]
            return schema
        finally:
            con.close()

    def nodes(self) -> Iterator[Node]:
        con = self._connect()
        try:
            cols = "id, kind, name, qualified_name, file_path, language, " + ", ".join(
                _NODE_EXTRA_COLS
            )
            for row in con.execute(f"SELECT {cols} FROM nodes"):
                ntype = _KIND_TO_NODETYPE.get(
                    (row["kind"] or "").lower(), NodeType.FILE
                )
                props = {
                    c: row[c] for c in _NODE_EXTRA_COLS if row[c] is not None
                }
                yield Node(
                    id=self._nid(row["id"]),
                    type=ntype,
                    name=row["name"],
                    source=Source.CODEGRAPH,
                    repo=self.repo,
                    path=row["file_path"],
                    qualified_name=row["qualified_name"],
                    language=row["language"],
                    properties=props,
                )
        finally:
            con.close()

    def edges(self) -> Iterator[Edge]:
        con = self._connect()
        try:
            rows = con.execute("SELECT source, target, kind, provenance FROM edges")
            for row in rows:
                etype = _REL_TO_EDGETYPE.get(
                    (row["kind"] or "").lower(), EdgeType.USES
                )
                # codegraph tags heuristic/resolved edges in `provenance`;
                # NULL means the relation is explicit in the source.
                yield Edge(
                    src=self._nid(row["source"]),
                    dst=self._nid(row["target"]),
                    type=etype,
                    source=Source.CODEGRAPH,
                    provenance=(
                        Provenance.EXTRACTED
                        if row["provenance"] is None
                        else Provenance.INFERRED
                    ),
                )
        finally:
            con.close()

    def _nid(self, raw: object) -> str:
        """Namespaced node id so ids never collide across repos/engines."""
        return f"cg:{self.repo}:{raw}"
