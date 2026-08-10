"""fetch() reports live progress to the API job runner (no real git/network)."""

from utils.repo import fetch as fetch_mod


def _fake_sources():
    return {
        "repositories": [
            {"url": "https://github.com/example/web-app.git", "branch": "main"},
            {"url": "git@github.com:example/billing-service.git"},
        ]
    }


def test_fetch_reports_progress_per_repo(monkeypatch, tmp_path):
    calls = []
    clones = []
    monkeypatch.setattr(fetch_mod, "read_sources", _fake_sources)
    monkeypatch.setattr(fetch_mod, "DEFAULT_SOURCES_FOLDER", tmp_path / ".sources")
    monkeypatch.setattr(fetch_mod.subprocess, "run", lambda *a, **k: clones.append(a))

    fetch_mod.fetch(progress=lambda *a: calls.append(a))

    phases = [c[0] for c in calls]
    # one "fetch" tick per repo, then a final completion tick
    assert phases == ["fetch", "fetch", "fetch"]
    assert calls[0] == ("fetch", 0, 2, "web-app")
    assert calls[1] == ("fetch", 1, 2, "billing-service")
    assert calls[-1] == ("fetch", 2, 2, "")  # 100% at the end
    assert len(clones) == 2  # both repos cloned (neither existed yet)


def test_fetch_without_progress_is_a_noop_callback(monkeypatch, tmp_path):
    monkeypatch.setattr(fetch_mod, "read_sources", _fake_sources)
    monkeypatch.setattr(fetch_mod, "DEFAULT_SOURCES_FOLDER", tmp_path / ".sources")
    monkeypatch.setattr(fetch_mod.subprocess, "run", lambda *a, **k: None)
    # Must still run cleanly on the CLI path where no callback is passed.
    fetch_mod.fetch()


def test_fetch_skips_already_cloned_repos(monkeypatch, tmp_path):
    src = tmp_path / ".sources"
    (src / "web-app").mkdir(parents=True)  # pretend this one is already cloned
    clones = []
    monkeypatch.setattr(fetch_mod, "read_sources", _fake_sources)
    monkeypatch.setattr(fetch_mod, "DEFAULT_SOURCES_FOLDER", src)
    monkeypatch.setattr(fetch_mod.subprocess, "run", lambda *a, **k: clones.append(a))

    fetch_mod.fetch()

    assert len(clones) == 1  # only the missing repo is cloned
