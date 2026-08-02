"""Embedding client for the semantic half of hybrid document retrieval.

Speaks the OpenAI embeddings API and reuses the SAME provider config as the
Q&A client (query/ask.py) — so a local server (Ollama, LM Studio, vLLM),
OpenRouter, Together, or OpenAI all work by pointing ATHENA_API_BASE at the
endpoint:

    ATHENA_API_BASE / OPENAI_BASE_URL   base URL (unset → OpenAI default)
    ATHENA_API_KEY  / OPENAI_API_KEY    API key (a local endpoint may need none)
    ATHENA_EMBED_MODEL                  model id (default text-embedding-3-small)

When no key/endpoint is configured, `is_available()` is False and callers fall
back to BM25-only retrieval — the pipeline still works, just without semantics.
"""

from __future__ import annotations

import os

import config


def is_available() -> bool:
    return bool(
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("ATHENA_API_KEY")
        or os.environ.get("ATHENA_API_BASE")
        or os.environ.get("OPENAI_BASE_URL")
    )


def model() -> str:
    return os.environ.get("ATHENA_EMBED_MODEL", "text-embedding-3-small")


def _client():
    from openai import OpenAI  # lazy: the app runs fine without the dep present

    kwargs: dict = {}
    base = os.environ.get("ATHENA_API_BASE") or os.environ.get("OPENAI_BASE_URL")
    if base:
        kwargs["base_url"] = base
    key = os.environ.get("ATHENA_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if key:
        kwargs["api_key"] = key
    return OpenAI(**kwargs)


def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """Embed many texts (batched). Returns one vector per input, or None if no
    provider is configured. Raises on a real API error so ingest can report it."""
    if not texts or not is_available():
        return None
    client = _client()
    mdl = model()
    batch = config.int_env("ATHENA_EMBED_BATCH", 128)
    out: list[list[float]] = []
    for i in range(0, len(texts), batch):
        chunk = [t if t.strip() else " " for t in texts[i : i + batch]]
        resp = client.embeddings.create(model=mdl, input=chunk)
        out.extend(d.embedding for d in resp.data)
    return out


def embed_query(text: str) -> list[float] | None:
    vecs = embed_texts([text])
    return vecs[0] if vecs else None
