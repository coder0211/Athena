// Thin fetch wrappers for the JSON API (same origin — the chat backend proxies
// graph endpoints to the upstream service).
export async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}

export async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await _errText(r)) || r.statusText);
  return r.json();
}

export async function apiDelete(path) {
  const r = await fetch(path, { method: "DELETE" });
  if (!r.ok) throw new Error((await _errText(r)) || r.statusText);
  return r.json();
}

// Pull a human message out of a FastAPI error body ({detail}) when present.
async function _errText(r) {
  try {
    const j = await r.clone().json();
    return typeof j.detail === "string" ? j.detail : "";
  } catch {
    return "";
  }
}
