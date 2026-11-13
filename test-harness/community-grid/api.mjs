// API checks for community thumbnails and descriptions, per host:
//   HOSTS=vercel-sim=http://localhost:3621 node api.mjs
// The Cloudflare Worker is always tested in-process against an in-memory
// mock of the SCENES KV (never the production namespace).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import worker from '../../worker/index.js';

const dir = dirname(fileURLToPath(import.meta.url));
const jpeg = readFileSync(join(dir, 'sample.jpg'));
const jpegUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
const HOSTS = (process.env.HOSTS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
  const i = s.indexOf('=');
  return i < 0 ? [s, s] : [s.slice(0, i), s.slice(i + 1)];
});

let fails = 0, n = 0;
const ok = (name, cond, extra = '') => {
  n++; if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

function mockKv() {
  const store = new Map();
  const asBuffer = (value) => {
    if (value == null) return null;
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
    return value;
  };
  return {
    async get(key, type) {
      const e = store.get(key);
      if (!e) return null;
      if (type === 'arrayBuffer') return asBuffer(e.value);
      if (typeof e.value === 'string') return e.value;
      return new TextDecoder().decode(e.value);
    },
    async getWithMetadata(key, type) {
      const e = store.get(key);
      if (!e) return { value: null, metadata: null };
      const value = type === 'arrayBuffer' ? asBuffer(e.value) : (typeof e.value === 'string' ? e.value : new TextDecoder().decode(e.value));
      return { value, metadata: e.metadata || null };
    },
    async put(key, value, opts = {}) {
      store.set(key, { value, metadata: opts.metadata || null });
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys };
    }
  };
}

const workerFetch = (path, init = {}) => worker.fetch(new Request('http://community-grid.test' + path, init), { SCENES: workerKv, ASSETS: { fetch: async () => new Response('ok') } });
let workerKv = mockKv();

async function runHost(H, fetchFn) {
  const post = (body) => fetchFn('/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const get = (id, headers = {}) => fetchFn(`/api/community-scenes/${id}`, { headers }).then((r) => r.json());
  const list = () => fetchFn('/api/community-scenes').then((r) => r.json());
  const patch = (id, body, headers = {}) => fetchFn(`/api/community-scenes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  // --- default: no thumb, no description ---
  const blank = await post({ version: 1, name: 'blank-scene', codeBlocks: ['1'] });
  ok(`${H} upload without thumb/desc succeeds`, blank.ok && blank.id, JSON.stringify(blank).slice(0, 200));
  const blankList = (await list()).scenes.find((s) => s.id === blank.id);
  ok(`${H} list: description blank by default`, blankList && blankList.description === '', JSON.stringify(blankList));
  ok(`${H} list: no thumbnail by default`, blankList && blankList.hasThumbnail === false && blankList.thumbUrl == null);
  ok(`${H} GET record description blank`, (await get(blank.id)).description === '' || (await get(blank.id)).description == null);
  const miss = await fetchFn(`/api/community-scenes/${blank.id}/thumb`);
  ok(`${H} thumb endpoint 404 when none`, miss.status === 404, String(miss.status));
  const missAlias = await fetchFn(`/api/scenes/${blank.id}/thumb`);
  ok(`${H} /api/scenes/:id/thumb alias 404 when none`, missAlias.status === 404);

  // --- upload with thumbnail + description ---
  const described = await post({
    version: 1,
    name: 'with-thumb',
    codeBlocks: ['2'],
    thumbnail: jpegUrl,
    description: 'A red tile.\nSecond line.'
  });
  ok(`${H} upload with thumb+desc`, described.ok && described.id, JSON.stringify(described).slice(0, 240));
  const dList = (await list()).scenes.find((s) => s.id === described.id);
  ok(`${H} list has description (multiline)`, dList && dList.description === 'A red tile.\nSecond line.', JSON.stringify(dList?.description));
  ok(`${H} list has thumbUrl, not image bytes`, !!(dList && dList.hasThumbnail && dList.thumbUrl === `/api/community-scenes/${described.id}/thumb`) && !JSON.stringify(dList).includes('data:image'), JSON.stringify(dList));
  const dRec = await get(described.id);
  ok(`${H} GET thumbnail is a stub, not a data URL`, dRec.thumbnail && dRec.thumbnail.stored === 'separate' && typeof dRec.thumbnail.url === 'string' && !String(dRec.thumbnail).includes('data:image'), JSON.stringify(dRec.thumbnail));
  ok(`${H} GET description preserved`, dRec.description === 'A red tile.\nSecond line.');

  // serve thumb — both endpoints, cache headers, bytes
  for (const path of [`/api/community-scenes/${described.id}/thumb`, `/api/scenes/${described.id}/thumb`]) {
    const t = await fetchFn(path);
    const buf = Buffer.from(await t.arrayBuffer());
    ok(`${H} ${path} serves JPEG`, t.ok && (t.headers.get('content-type') || '').startsWith('image/jpeg') && buf.equals(jpeg), `${t.status} ${t.headers.get('content-type')} ${buf.length}`);
    const cc = t.headers.get('cache-control') || '';
    ok(`${H} ${path} has cache-control`, /max-age|immutable|public/i.test(cc), cc);
  }

  // --- description PATCH (open like rename; export settings stay owner-only) ---
  const ownerKey = described.ownerKey;
  ok(`${H} ownerKey returned once`, typeof ownerKey === 'string' && ownerKey.length > 8);
  const escaped = 'Hello\n<script>alert(1)</script>\n& "quotes"';
  const saved = await patch(described.id, { description: escaped });
  ok(`${H} description PATCH without owner key succeeds`, saved.status === 200 && saved.description === escaped, JSON.stringify(saved).slice(0, 250));
  const after = await get(described.id);
  ok(`${H} multiline + brackets persist on GET`, after.description === escaped);
  const listed = (await list()).scenes.find((s) => s.id === described.id);
  ok(`${H} list shows updated description`, listed && listed.description === escaped);
  const second = 'Updated by the owner key path.';
  const savedOwner = await patch(described.id, { description: second }, { 'x-gs-owner-key': ownerKey });
  ok(`${H} PATCH with owner key still works`, savedOwner.status === 200 && savedOwner.description === second, JSON.stringify(savedOwner).slice(0, 200));
  const exportDenied = await patch(described.id, { allowExport: false });
  ok(`${H} export setting PATCH without owner key is still 403`, exportDenied.status === 403, JSON.stringify(exportDenied).slice(0, 200));
  const cleared = await patch(described.id, { description: '   ' });
  ok(`${H} whitespace clears description`, cleared.status === 200 && (cleared.description === '' || cleared.description == null), JSON.stringify(cleared).slice(0, 200));
  const long = 'z'.repeat(5000);
  const capped = await patch(described.id, { description: long });
  ok(`${H} overlong description is capped`, capped.status === 200 && (capped.description || '').length === 2000, String((capped.description || '').length));
  const tooBig = await patch(described.id, { description: 'z'.repeat(8193) });
  ok(`${H} oversized raw description is 413`, tooBig.status === 413, JSON.stringify(tooBig).slice(0, 200));
  const stillCapped = await get(described.id);
  ok(`${H} 413 did not change the stored description`, (stillCapped.description || '').length === 2000, String((stillCapped.description || '').length));

  // name-only PATCH still works (existing, no owner required)
  const renamed = await patch(described.id, { name: 'renamed-thumb' });
  ok(`${H} rename still works`, renamed.status === 200 && (renamed.scene?.name === 'renamed-thumb'), JSON.stringify(renamed).slice(0, 200));
}

// In-process Worker (mock KV — never production).
workerKv = mockKv();
await runHost('cf-mock', workerFetch);

// Optional live hosts (vercel-sim).
for (const [H, base] of HOSTS) {
  const fetchFn = (path, init) => fetch(base + path, init);
  await runHost(H, fetchFn);
}

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
