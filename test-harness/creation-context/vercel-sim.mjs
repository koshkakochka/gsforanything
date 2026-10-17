// Runs site-source/server.js as on Vercel (no self-signed HTTPS) with an
// in-memory fake of the Vercel Blob HTTP API, on http://localhost:$PORT.
import http from 'http';
process.env.VERCEL = '1';
process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
const PORT = Number(process.env.SIM_PORT || 3601);
const store = new Map(); // pathname -> { body, uploadedAt, contentType }
const PUBLIC = `http://localhost:${PORT}/__blob/`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  if (url.startsWith('https://blob.vercel-storage.com')) {
    const u = new URL(url);
    if (method === 'PUT') {
      const pathname = decodeURIComponent(u.pathname.slice(1));
      const body = typeof init.body === 'string' ? init.body : String(init.body);
      store.set(pathname, { body, uploadedAt: new Date().toISOString() });
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
    return v ? new Response(v.body, { status: 200 }) : new Response('nf', { status: 404 });
  }
  return realFetch(input, init);
};
const { default: app } = await import(process.env.SERVER_JS || new URL('../../site-source/server.js', import.meta.url).href);
app.get('/__blobstore', (req, res) => res.json([...store.entries()].map(([p, v]) => ({ p, size: v.body.length }))));
app.post('/__blobstore/raw', (req, res) => { store.set(req.body.pathname, { body: req.body.body, uploadedAt: new Date().toISOString() }); res.json({ ok: true }); });
http.createServer(app).listen(PORT, () => console.log(`vercel-sim on ${PORT}`));
