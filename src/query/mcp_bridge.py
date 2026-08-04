"""Bridge to third-party MCP servers configured in mcp_servers.json.

Discovers each enabled server's tools and exposes them to the Q&A agent as
OpenAI function specs (named ``mcp__<server>__<tool>``), then routes tool calls
back to the right server. The MCP SDK is async; this module wraps every
operation in a fresh event loop so the synchronous agent loop can use it.

Everything degrades quietly: if the SDK is missing, a server is unreachable, or
a call fails, the agent simply doesn't get those tools (or gets an ``{"error": …}``
result it can reason about) — natural-language Q&A never breaks because of MCP.

Notable behaviours:
  * tool names are sanitised to the LLM API's ``^[a-zA-Z0-9_-]{1,64}$``;
  * ``${ENV_VAR}`` in env/headers is expanded from the process environment, so
    secrets can stay out of ``mcp_servers.json``;
  * discovery probes servers concurrently; failures are logged, not swallowed;
  * local (stdio) servers run an arbitrary command and can be disabled with
    ``ATHENA_MCP_ALLOW_STDIO=0`` (e.g. a shared/exposed deployment).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import logging
import os
import re
import shutil
import threading
from contextlib import asynccontextmanager
from typing import Any

import config
from utils.mcp import MCP_PATH, load_mcp

log = logging.getLogger("athena.mcp")

_PREFIX = "mcp__"
# Cached per config-file mtime, guarded by a lock so concurrent requests (the
# API runs sync handlers in a threadpool) don't double-discover or read a
# half-updated cache.
_cache: dict = {"mtime": None, "specs": [], "routes": {}}
_lock = threading.Lock()

# OpenAI tool names must match ^[a-zA-Z0-9_-]{1,64}$ — anything else makes the API
# reject the WHOLE request. Sanitise + length-bound while staying unique/stable.
_BAD_NAME = re.compile(r"[^a-zA-Z0-9_-]")


def _fn_name(server_name: str, tool_name: str) -> str:
    raw = f"{_PREFIX}{server_name}__{tool_name}"
    name = _BAD_NAME.sub("_", raw)
    if len(name) <= 64:
        return name
    # Too long: keep a readable head + a short stable hash for uniqueness.
    return name[:55] + "_" + hashlib.sha1(raw.encode()).hexdigest()[:8]


# ${ENV_VAR} expansion so tokens can live in the environment, not in the JSON.
_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand(value: Any) -> str:
    return _VAR_RE.sub(lambda m: os.environ.get(m.group(1), ""), str(value))


def _expand_map(d) -> dict:
    return {k: _expand(v) for k, v in (d or {}).items()}


def _root_cause(exc: BaseException) -> str:
    """MCP connections run in anyio task groups, so a real failure arrives wrapped
    as an ExceptionGroup whose message is the useless "unhandled errors in a
    TaskGroup". Unwrap to the leaf so logs/UI show the actual reason (e.g.
    'MCPError: Connection closed', 'RuntimeError: command not found: uvx')."""
    depth = 0
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions and depth < 10:
        exc = exc.exceptions[0]
        depth += 1
    return f"{type(exc).__name__}: {exc}"


def _sanitize_schema(schema) -> dict:
    """Coerce an MCP inputSchema into an object schema the LLM API accepts."""
    if not isinstance(schema, dict) or schema.get("type") != "object":
        return {"type": "object", "properties": {}}
    out = dict(schema)
    out.pop("$schema", None)
    if not isinstance(out.get("properties"), dict):
        out["properties"] = {}
    return out


def _mtime() -> float:
    try:
        return MCP_PATH.stat().st_mtime
    except OSError:
        return 0.0


def _run(coro) -> Any:
    """Run an async coroutine to completion from sync code, whether or not an
    event loop is already running in this thread."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # A loop is already running here — run in a separate thread with its own loop.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(lambda: asyncio.run(coro)).result()


@asynccontextmanager
async def _connect(server: dict):
    """Open + initialize an MCP ClientSession for one server config."""
    from mcp import ClientSession

    if (server.get("transport") or "stdio") == "http":
        from mcp.client.streamable_http import (
            create_mcp_http_client,
            streamable_http_client,
        )

        headers = _expand_map(server.get("headers")) or None
        # Custom headers (e.g. auth tokens) ride on an httpx client passed in.
        http_client = create_mcp_http_client(headers=headers) if headers else None
        try:
            async with streamable_http_client(
                server.get("url", ""), http_client=http_client
            ) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    yield session
        finally:
            if http_client is not None:
                await http_client.aclose()
    else:
        # stdio servers execute an arbitrary local command, so they can be gated
        # off entirely (e.g. a shared/exposed deployment) via ATHENA_MCP_ALLOW_STDIO=0.
        if not config.bool_env("ATHENA_MCP_ALLOW_STDIO", True):
            raise RuntimeError(
                "local (stdio) MCP servers are disabled here "
                "(ATHENA_MCP_ALLOW_STDIO=0). Use an http server instead."
            )
        from mcp import StdioServerParameters
        from mcp.client.stdio import stdio_client

        command = server.get("command", "")
        # Clean, actionable error instead of a raw subprocess FileNotFoundError.
        if command and shutil.which(command) is None and not os.path.exists(command):
            raise RuntimeError(
                f"command not found: '{command}'. Install it in the environment "
                "(Node provides 'npx'; uv provides 'uvx') or use an absolute path."
            )
        params = StdioServerParameters(
            command=command,
            args=server.get("args") or [],
            env=_expand_map(server.get("env")) or None,
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session


async def _list_tools(server: dict) -> list:
    async with _connect(server) as session:
        res = await session.list_tools()
        return list(res.tools)


async def _call(server: dict, tool_name: str, args: dict) -> Any:
    async with _connect(server) as session:
        res = await session.call_tool(tool_name, args)
        return _extract(res)


async def _list_all(server: dict) -> tuple[list, list]:
    """Tools AND prompts for a server (prompts optional — many servers have none)."""
    async with _connect(server) as session:
        tools = (await session.list_tools()).tools
        prompts = []
        try:
            prompts = (await session.list_prompts()).prompts
        except Exception:  # noqa: BLE001 — server may not implement prompts
            prompts = []
        return list(tools), list(prompts)


def _extract(res) -> Any:
    """Flatten an MCP CallToolResult into text/JSON the LLM can consume."""
    texts = []
    for block in getattr(res, "content", None) or []:
        t = getattr(block, "text", None)
        texts.append(t if t is not None else str(getattr(block, "data", "") or ""))
    out = "\n".join(x for x in texts if x).strip()
    if getattr(res, "isError", False):
        return {"error": out or "tool call failed"}
    try:
        return json.loads(out)  # many servers return JSON text
    except Exception:  # noqa: BLE001 — plain text is fine too
        return out or {"ok": True}


def _spec(server_name: str, tool) -> dict:
    desc = (getattr(tool, "description", "") or f"{tool.name} (via {server_name})")[:1024]
    return {
        "type": "function",
        "function": {
            "name": _fn_name(server_name, tool.name),
            "description": desc,
            "parameters": _sanitize_schema(getattr(tool, "inputSchema", None)),
        },
    }


async def _discover(servers: list[dict], want_prompts: bool) -> list[tuple]:
    """Connect to every server CONCURRENTLY (rather than serially) and return
    [(server, result, error)]. `result` is a tools list, or (tools, prompts)."""

    async def one(server):
        try:
            fn = _list_all if want_prompts else _list_tools
            return server, await asyncio.wait_for(fn(server), timeout=20), None
        except (KeyboardInterrupt, SystemExit, asyncio.CancelledError):
            raise  # never swallow real cancellation/shutdown
        except BaseException as e:  # noqa: BLE001 — incl. ExceptionGroup; per-server
            return server, None, e

    return list(await asyncio.gather(*(one(s) for s in servers)))


def _refresh() -> None:
    with _lock:
        mt = _mtime()
        if _cache["mtime"] == mt:
            return
        enabled = [
            s
            for s in load_mcp().get("servers", [])
            if s.get("name") and s.get("enabled", True)
        ]
        specs: list[dict] = []
        routes: dict = {}
        for server, tools, err in (_run(_discover(enabled, False)) if enabled else []):
            if err:
                log.warning(
                    "MCP server %r: tool discovery failed: %s",
                    server["name"], _root_cause(err),
                )
                continue
            for t in tools:
                spec = _spec(server["name"], t)
                specs.append(spec)
                routes[spec["function"]["name"]] = (server, t.name)
        _cache.update(mtime=mt, specs=specs, routes=routes)


def get_specs() -> list[dict]:
    """OpenAI function specs for every enabled MCP server's tools ([] if none)."""
    try:
        _refresh()
    except Exception:  # noqa: BLE001 — never break Q&A over MCP discovery
        return []
    return _cache["specs"]


def is_mcp_tool(name: str) -> bool:
    return name.startswith(_PREFIX)


def call_tool(name: str, args: dict) -> Any:
    """Route a tool call to its MCP server; returns text/JSON or {'error': …}."""
    try:
        _refresh()
    except Exception:  # noqa: BLE001
        pass
    route = _cache["routes"].get(name)
    if not route:
        return {"error": f"unknown MCP tool: {name}"}
    server, tool_name = route
    try:
        return _run(asyncio.wait_for(_call(server, tool_name, args or {}), timeout=60))
    except (KeyboardInterrupt, SystemExit, asyncio.CancelledError):
        raise
    except BaseException as e:  # noqa: BLE001 — incl. ExceptionGroup; surface to model
        cause = _root_cause(e)
        log.warning("MCP tool %r failed: %s", name, cause)
        return {"error": cause}


def describe_servers() -> list[dict]:
    """Per-server view for the dashboard: metadata + discovered tools/prompts, or
    an error string. Always fresh (no cache) so the settings page shows reality.
    Enabled servers are probed concurrently."""
    servers = load_mcp().get("servers", [])
    enabled = [s for s in servers if s.get("enabled", True)]
    probed = {id(s): (r, e) for s, r, e in (_run(_discover(enabled, True)) if enabled else [])}
    out = []
    for server in servers:
        entry = {
            "name": server.get("name"),
            "enabled": server.get("enabled", True),
            "transport": server.get("transport") or "stdio",
            "description": server.get("description", ""),
            "tools": [],
            "prompts": [],
            "error": None,
        }
        if not entry["enabled"]:
            entry["error"] = "disabled"
            out.append(entry)
            continue
        res, err = probed.get(id(server), (None, RuntimeError("not probed")))
        if err:
            cause = _root_cause(err)
            log.warning("MCP server %r: describe failed: %s", entry["name"], cause)
            entry["error"] = cause
        else:
            tools, prompts = res
            entry["tools"] = [
                {"name": t.name, "description": getattr(t, "description", "") or ""}
                for t in tools
            ]
            entry["prompts"] = [
                {"name": p.name, "description": getattr(p, "description", "") or ""}
                for p in prompts
            ]
        out.append(entry)
    return out
