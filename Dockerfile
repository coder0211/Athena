# Athena — code knowledge graph API + web UI.
#
# Bundles everything the pipeline needs: Python deps, the CodeGraph CLI (Node),
# Graphify (pip), git/ssh for cloning private repos, and npx/uvx so third-party
# MCP servers (Node- or Python-based) can be launched. Serves the FastAPI app
# (web UI + /api) on port 8000.

FROM python:3.13-slim

# System deps: git + ssh (clone), curl/gnupg (NodeSource), Node 22 (codegraph).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    git openssh-client ca-certificates curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm i -g @colbymchenry/codegraph \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# uv / uvx — runtime for Python-based MCP servers (parallels npx for Node ones).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Python deps first for layer caching (graphify ships as `graphifyy` in requirements).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY src ./src
COPY dashboard ./dashboard
COPY example ./example

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"

EXPOSE 8000
CMD ["python", "-m", "uvicorn", "api.app:app", \
    "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
