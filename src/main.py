"""Athena pipeline orchestrator.

    L0  fetch   clone/update source repos into .sources/
    L1  \
    L2   > build   run CodeGraph + Graphify per repo, merge into one graph
    L4  /
    L3  store   persist the unified knowledge graph into Kuzu

Usage:
    python src/main.py all                  # fetch + build + store (default)
    python src/main.py fetch                # only clone repos
    python src/main.py build                # extract + merge (+ store)
    python src/main.py build --no-tools     # reuse existing tool outputs
    python src/main.py build --no-store     # skip Kuzu persistence
"""

from __future__ import annotations

import argparse

from graph.merge import build_workspace_graph
from graph.schema import KnowledgeGraph
from utils.repo.fetch import DEFAULT_SOURCES_FOLDER, fetch


def source_repos() -> list:
    """Cloned repos under .sources/ (git working trees only)."""
    if not DEFAULT_SOURCES_FOLDER.exists():
        return []
    return sorted(
        p
        for p in DEFAULT_SOURCES_FOLDER.iterdir()
        if p.is_dir() and (p / ".git").exists()
    )


def _make_store(backend: str):
    """Store factory — imported lazily so `fetch`/`build --no-store` need no store dep."""
    if backend == "networkx":
        from graph.store_networkx import NetworkXStore

        return NetworkXStore()
    if backend == "kuzu":
        from graph.store import KuzuStore

        return KuzuStore()
    raise SystemExit(f"Unknown store backend: {backend!r}")


def build(
    *,
    run_tools: bool = True,
    persist: bool = True,
    store_backend: str = "networkx",
    cluster: bool = True,
    with_docs: bool = True,
    progress=None,
) -> KnowledgeGraph:
    """L1–L4: extract every source repo, merge, cluster, ingest docs (+ store).

    `progress(phase, current, total, detail)` is an optional status callback (the
    API job runner passes one to drive the dashboard's live build progress); on
    the CLI it's None and everything runs exactly as before.
    """
    repos = source_repos()
    if not repos:
        raise SystemExit(
            f"No repos under {DEFAULT_SOURCES_FOLDER} — run `fetch` first."
        )
    print(f"Building knowledge graph from {len(repos)} repo(s):")
    for repo in repos:
        print(f"  - {repo.name}")

    kg = build_workspace_graph(
        repos, run_tools=run_tools, cluster=cluster, progress=progress
    )

    # L2 documents — ingested after clustering so doc nodes don't skew the code
    # communities; bridged to the code they mention.
    if with_docs:
        from graph.merge import build_docs

        if progress:
            progress("documents", 0, 0, "")
        build_docs(kg, run_tools=run_tools)

    print("Unified knowledge graph:", kg.stats())

    if persist:
        if progress:
            progress("store", 0, 0, store_backend)
        store = _make_store(store_backend)
        store.load(kg)
        print(f"Persisted to {store_backend}:", store.db_path)

    if progress:
        progress("done", 0, 0, "")

    return kg


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="athena", description=__doc__)
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("fetch", help="clone/update source repos (L0)")

    b = sub.add_parser("build", help="extract + merge into the knowledge graph")
    b.add_argument(
        "--no-tools",
        action="store_true",
        help="skip running codegraph/graphify; read existing outputs",
    )
    b.add_argument(
        "--no-store",
        action="store_true",
        help="don't persist the graph",
    )
    b.add_argument(
        "--store",
        choices=("networkx", "kuzu"),
        default="networkx",
        help="graph store backend (default: networkx)",
    )
    b.add_argument(
        "--no-cluster",
        action="store_true",
        help="skip the L4 graphify cluster bridge",
    )
    b.add_argument(
        "--no-docs",
        action="store_true",
        help="skip the L2 document ingestion (docx/pdf/csv/xls)",
    )

    sub.add_parser("all", help="fetch then build (default)")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)

    if args.cmd == "fetch":
        fetch()
    elif args.cmd == "build":
        build(
            run_tools=not args.no_tools,
            persist=not args.no_store,
            store_backend=args.store,
            cluster=not args.no_cluster,
            with_docs=not args.no_docs,
        )
    else:  # "all" or no subcommand
        fetch()
        build()


if __name__ == "__main__":
    main()
