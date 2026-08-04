"""Unit tests for the MCP bridge + config translation (no network/subprocess)."""

import json
import re

from query import mcp_bridge as m
from utils import mcp as mcpcfg

_OK = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def test_fn_name_valid_and_readable():
    n = m._fn_name("brave-search", "brave_web_search")
    assert n == "mcp__brave-search__brave_web_search"
    assert _OK.match(n)


def test_fn_name_sanitizes_invalid_chars():
    n = m._fn_name("my.server", "tool.with.dots")
    assert _OK.match(n)
    assert "." not in n


def test_fn_name_bounds_length_and_stays_unique():
    a = m._fn_name("s" * 40, "toolA" + "x" * 40)
    b = m._fn_name("s" * 40, "toolB" + "x" * 40)
    assert _OK.match(a) and len(a) == 64
    assert a != b  # trailing hash keeps truncated names distinct


def test_env_var_expansion(monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "secret123")
    assert m._expand("Bearer ${MY_TOKEN}") == "Bearer secret123"
    assert m._expand("${NOPE}") == ""  # unknown → empty
    assert m._expand_map({"Authorization": "Bearer ${MY_TOKEN}", "X": "plain"}) == {
        "Authorization": "Bearer secret123",
        "X": "plain",
    }


def test_sanitize_schema():
    assert m._sanitize_schema(None) == {"type": "object", "properties": {}}
    assert m._sanitize_schema({"type": "string"}) == {"type": "object", "properties": {}}
    assert m._sanitize_schema({"type": "object"})["properties"] == {}
    s = m._sanitize_schema(
        {"type": "object", "$schema": "x", "properties": {"a": {"type": "string"}}}
    )
    assert "$schema" not in s and s["properties"] == {"a": {"type": "string"}}


def test_is_mcp_tool():
    assert m.is_mcp_tool("mcp__x__y")
    assert not m.is_mcp_tool("search_docs")


def test_call_unknown_tool_returns_error(monkeypatch):
    monkeypatch.setattr(m, "load_mcp", lambda: {"servers": []})
    out = m.call_tool("mcp__nope__x", {})
    assert isinstance(out, dict) and "error" in out


def test_config_roundtrip_standard_format(tmp_path, monkeypatch):
    p = tmp_path / "mcp_servers.json"
    monkeypatch.setattr(mcpcfg, "MCP_PATH", p)
    p.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "brave": {
                        "command": "npx",
                        "args": ["-y", "x"],
                        "env": {"K": "V"},
                        "disabled": True,
                    },
                    "remote": {"url": "https://h/mcp", "headers": {"A": "B"}},
                }
            }
        )
    )
    # load → normalized flat shape with inferred transport + enabled
    by_name = {s["name"]: s for s in mcpcfg.load_mcp()["servers"]}
    assert by_name["brave"]["transport"] == "stdio"
    assert by_name["brave"]["enabled"] is False
    assert by_name["remote"]["transport"] == "http"
    assert by_name["remote"]["url"] == "https://h/mcp"

    # save → back to the standard mcpServers object, clean per transport
    mcpcfg.save_mcp(mcpcfg.load_mcp())
    disk = json.loads(p.read_text())["mcpServers"]
    assert disk["brave"]["command"] == "npx" and disk["brave"]["disabled"] is True
    assert "url" not in disk["brave"]  # stdio server has no url key
    assert disk["remote"]["url"] == "https://h/mcp"
    assert "command" not in disk["remote"]  # http server has no command key
