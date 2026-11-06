// Minimal CardPointe Gateway REST client (auth, capture, void, inquireByOrderid, voidByOrderid)
// with a hard client-side timeout. A timeout returns { noResponse: true }: the caller must not
// assume the auth failed.
export function cardpointe({ baseUrl, merchid = "496160873888", user = "testing", pass = "testing123", timeoutMs = 31000 }) {
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  async function call(method, path, body) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(`${baseUrl}/cardconnect/rest${path}`, { method, headers: { "content-type": "application/json", authorization: auth }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      if (r.status >= 500) return { httpError: r.status };
      return await r.json();
    } catch (e) { return { noResponse: true, error: e.name }; }
    finally { clearTimeout(timer); }
  }
  return {
    auth: (o) => call("PUT", "/auth", { merchid, ...o }),
    capture: (retref) => call("PUT", "/capture", { merchid, retref }),
    void: (retref) => call("PUT", "/void", { merchid, retref }),
    inquireByOrderid: (orderid) => call("GET", `/inquireByOrderid/${encodeURIComponent(orderid)}/${merchid}`),
    voidByOrderid: (orderid) => call("GET", `/voidByOrderid/${encodeURIComponent(orderid)}/${merchid}`),
  };
}
