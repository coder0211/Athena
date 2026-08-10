"""DELETE /api/graph wipes built graph data (graph + cluster + passages) but not
the inputs. Exercises the handler directly against a throwaway .knowledge dir."""

import pytest

from api import app as A
from graph import doc_store


@pytest.fixture
def knowledge(tmp_path, monkeypatch):
    """A disposable .knowledge/ with a graph, cluster artifacts, and passages,
    wired into the app + doc_store so clear_graph() only touches the temp copy."""
    graph = tmp_path / "graph.json"
    graph.write_text("{}")
    cluster = tmp_path / "cluster"
    cluster.mkdir()
    (cluster / "leiden.json").write_text("{}")
    passages = tmp_path / "docs" / "passages.jsonl"
    passages.parent.mkdir()
    passages.write_text("{}\n")

    monkeypatch.setattr(A, "_GRAPH_PATH", graph)
    monkeypatch.setattr(doc_store, "passages_path", lambda: passages)
    monkeypatch.setattr(A, "_engine", object(), raising=False)
    return {"graph": graph, "cluster": cluster, "passages": passages}


def test_clear_removes_all_graph_data(knowledge):
    r = A.clear_graph()
    assert r["ok"] and set(r["cleared"]) == {"graph", "cluster", "passages"}
    assert not knowledge["graph"].exists()
    assert not knowledge["cluster"].exists()
    assert not knowledge["passages"].exists()
    # The cached engine is dropped so status/queries see the wipe immediately.
    assert A._engine is None


def test_clear_with_nothing_built_is_404(knowledge):
    for p in (knowledge["graph"], knowledge["passages"]):
        p.unlink()
    knowledge["cluster"].joinpath("leiden.json").unlink()
    knowledge["cluster"].rmdir()

    with pytest.raises(Exception) as exc:
        A.clear_graph()
    assert getattr(exc.value, "status_code", None) == 404


def test_clear_is_partial_when_only_graph_exists(knowledge):
    # Only the graph file remains — clearing reports just that, still succeeds.
    knowledge["passages"].unlink()
    knowledge["cluster"].joinpath("leiden.json").unlink()
    knowledge["cluster"].rmdir()

    r = A.clear_graph()
    assert r["cleared"] == ["graph"]
