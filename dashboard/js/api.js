// JSON API client for the dashboard (same origin — the management service).
export const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : null,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  // multipart upload (single file) — used by the Documents tab. `subpath` is an
  // optional relative target folder under .docs/uploads/ (preserves a folder tree).
  async upload(path, file, subpath = "") {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (subpath) fd.append("path", subpath);
    const r = await fetch(path, { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  },
  // Same as upload(), but reports byte progress via onProgress(loaded, total).
  // Uses XHR because fetch() has no upload-progress events.
  uploadWithProgress(path, file, subpath = "", onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append("file", file, file.name);
      if (subpath) fd.append("path", subpath);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", path);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total);
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON response */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.detail || xhr.statusText || "upload failed"));
      };
      xhr.onerror = () => reject(new Error("network error during upload"));
      xhr.send(fd);
    });
  },
};
