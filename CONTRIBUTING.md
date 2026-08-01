# Contributing to Athena

Thanks for your interest in improving Athena! This guide covers local setup and
the basics for sending a change.

## Local setup

```bash
# Clone and enter the repo
git clone <your-fork-url> Athena && cd Athena

# Python deps (use a virtualenv)
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

# L1 extractor (needs Node 22.5+)
npm i -g @colbymchenry/codegraph

# Config
cp example.env .env                 # then set OPENAI_API_KEY (optional)
cp example.sources.yaml sources.yaml
```

Build a graph and run the app:

```bash
python src/main.py all                              # fetch + extract + merge
python -m uvicorn api.app:app --app-dir src         # → http://127.0.0.1:8000
```

## Prerequisites

- **Python** 3.10+
- **Node** 22.5+ (only for the `codegraph` extractor)
- An **OpenAI API key** — optional, required only for natural-language Q&A.

## Project layout

See the **Project layout** section in the [README](README.md#project-layout).
Everything downstream of the query layer depends only on `GraphQuery`
(`src/query/engine.py`); prefer extending it rather than reaching into the
graph store directly.

## Sending a change

1. Fork the repo and create a branch: `git checkout -b my-change`.
2. Keep changes focused; match the style of the surrounding code.
3. Do **not** commit secrets or local data — `.env`, `sources.yaml`,
   `.sources/`, and `.knowledge/` are gitignored for that reason. Never hardcode
   absolute machine paths (use relative paths or config).
4. Open a pull request against `dev` with a clear description of the change and
   how you tested it.

## Reporting bugs & ideas

Open a GitHub issue with steps to reproduce (for bugs) or the motivation and
proposed behavior (for features). For security issues, follow
[`SECURITY.md`](SECURITY.md) instead of filing a public issue.
