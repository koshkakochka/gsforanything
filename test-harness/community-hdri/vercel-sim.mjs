// Runs site-source/server.js as on Vercel (no self-signed HTTPS) with an
// in-memory, binary-safe fake of the Vercel Blob HTTP API, on
// http://localhost:$SIM_PORT (default 3611).
import http from 'http';
process.env.VERCEL = '1';
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
const PORT = Number(process.env.SIM_PORT || 3611);
const store = new Map(); // pathname -> { body: Buffer, uploadedAt, contentType }
const PUBLIC = `http://localhost:${PORT}/__blob/`;
const realFetch = globalThis.fetch;
const toBuf = (b) => Buffer.isBuffer(b) ? b : b instanceof ArrayBuffer ? Buffer.from(b) : ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(String(b));
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://blob.vercel-storage.com')) {
    const u = new URL(url);
    if (method === 'PUT') {
      const pathname = decodeURIComponent(u.pathname.slice(1));
      const body = toBuf(init.body);
      store.set(pathname, { body, uploadedAt: new Date().toISOString(), contentType: init.headers?.['x-content-type'] || 'application/octet-stream' });
      return new Response(JSON.stringify({ url: PUBLIC + pathname, pathname, size: body.length }), { status: 200 });
    }
    if (method === 'GET') {
      const prefix = u.searchParams.get('prefix') || '';
      const blobs = [...store.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, v]) => ({ pathname: p, url: PUBLIC + p, uploadedAt: v.uploadedAt, size: v.body.length }));
      return new Response(JSON.stringify({ blobs }), { status: 200 });
    }
    if (method === 'POST' && u.pathname === '/delete') {
      for (const x of JSON.parse(init.body).urls) store.delete(x.slice(PUBLIC.length));
      return new Response('{}', { status: 200 });
    }
  }
  if (url.startsWith(PUBLIC)) {
    const v = store.get(decodeURIComponent(url.slice(PUBLIC.length)));
    return v ? new Response(v.body, { status: 200, headers: { 'content-type': v.contentType } }) : new Response('nf', { status: 404 });
  }
  return realFetch(input, init);
};
const { default: app } = await import(process.env.SERVER_JS || new URL('../../site-source/server.js', import.meta.url).href);
app.get('/__blobstore', (req, res) => res.json([...store.entries()].map(([p, v]) => ({ p, size: v.body.length, type: v.contentType }))));
// Test hook: age a scene record so the one-shot HDRI upload window has closed.
app.post('/__blobstore/age', (req, res) => {
  for (const [p, v] of store) if (p.startsWith(`community-scenes/${req.body.id}--`)) {
    const r = JSON.parse(v.body.toString()); r.updatedAt = new Date(Date.now() - 3600e3).toISOString(); v.body = Buffer.from(JSON.stringify(r));
  }
  res.json({ ok: true });
});
http.createServer(app).listen(PORT, () => console.log(`vercel-sim on ${PORT}`));
