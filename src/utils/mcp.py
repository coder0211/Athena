"""Third-party MCP servers the assistant can connect to for extra tools.

Stored in `mcp_servers.json` at the project root, in the **standard MCP config
format** used across the ecosystem (Claude Desktop, Cursor, `.mcp.json`, …) so
configs can be copy-pasted between tools:

    {
      "mcpServers": {
        "brave-search": { "command": "npx", "args": [...], "env": {...} },
        "remote":       { "url": "https://…/mcp", "headers": {...} }
      }
    }

Transport is inferred: a `url` means http, otherwise stdio. `disabled: true`
turns a server off; `description` is an optional human note. The dashboard/API
work with a flat `{"servers": [ {name, enabled, transport, …} ]}` shape — this
module translates between that and the on-disk `mcpServers` object.
"""

from __future__ import annotations

import json

from config import PROJECT_ROOT

MCP_PATH = PROJECT_ROOT / "mcp_servers.json"

TRANSPORTS = ["stdio", "http"]


def load_mcp() -> dict:
    """Return {'servers': [{name, enabled, transport, command, args, env, url,
    headers, description}]} parsed from the standard mcpServers JSON."""
    if not MCP_PATH.exists():
        return {"servers": []}
    try:
        data = json.loads(MCP_PATH.read_text()) or {}
    except (json.JSONDecodeError, OSError):
        return {"servers": []}
    raw = data.get("mcpServers") or {}
    servers = []
    for name, cfg in raw.items():
        cfg = cfg or {}
        transport = cfg.get("transport") or ("http" if cfg.get("url") else "stdio")
        servers.append(
            {
                "name": name,
                "enabled": not cfg.get("disabled", False),
                "transport": transport,
                "command": cfg.get("command", ""),
                "args": cfg.get("args") or [],
                "env": cfg.get("env") or {},
                "url": cfg.get("url", ""),
                "headers": cfg.get("headers") or {},
                "description": cfg.get("description", ""),
            }
        )
    return {"servers": servers}


def save_mcp(data: dict) -> None:
    """Write the standard mcpServers JSON from the API's {'servers': [...]} shape.
    Only the keys relevant to each transport are emitted, so the file stays clean
    and interchangeable with other MCP tooling."""
    out: dict = {}
    for s in data.get("servers", []) or []:
        name = (s.get("name") or "").strip()
        if not name:
            continue
        entry: dict = {}
        if (s.get("transport") or "stdio") == "http":
            entry["url"] = s.get("url", "")
            if s.get("headers"):
                entry["headers"] = s["headers"]
        else:
            entry["command"] = s.get("command", "")
            if s.get("args"):
                entry["args"] = s["args"]
            if s.get("env"):
                entry["env"] = s["env"]
        if s.get("description"):
            entry["description"] = s["description"]
        if not s.get("enabled", True):
            entry["disabled"] = True
        out[name] = entry
    MCP_PATH.write_text(
        json.dumps({"mcpServers": out}, indent=2, ensure_ascii=False) + "\n"
    )
