# Read sources.yaml and clone into .sources

from pathlib import Path
import subprocess

import yaml
from tqdm import tqdm

# Project root (Athena/), resolved from this file's location so the config
# is found regardless of the current working directory.
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SOURCES_PATH = PROJECT_ROOT / "config" / "sources.yaml"
DEFAULT_SOURCES_FOLDER = PROJECT_ROOT / ".sources"


def read_sources(path=DEFAULT_SOURCES_PATH) -> dict:
    with open(path, "r") as f:
        return yaml.safe_load(f)


def fetch(progress=None):
    """Clone/update every configured repo into .sources/.

    `progress(phase, current, total, detail)` is an optional callback the API job
    runner uses to surface live status in the dashboard; it's a no-op on the CLI.
    """
    repositories = read_sources()["repositories"]
    DEFAULT_SOURCES_FOLDER.mkdir(parents=True, exist_ok=True)
    total = len(repositories)
    for i, repo in enumerate(tqdm(repositories)):
        url = repo["url"]
        branch = repo.get("branch")
        # Derive the target folder name from the repo URL (strip .git).
        name = url.rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
        if progress:
            progress("fetch", i, total, name)
        target = DEFAULT_SOURCES_FOLDER / name
        if target.exists():
            continue
        cmd = ["git", "clone"]
        if branch:
            cmd += ["--branch", branch]
        cmd += [url, str(target)]
        subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    if progress:
        progress("fetch", total, total, "")
