// Scene names on Community upload: sceneName.js unit checks, then the upload
// API on the Cloudflare Worker (in-process, mock KV — never production) and
// any HOSTS (e.g. the Vercel sim from ../community-grid/vercel-sim.mjs).
//   node api.mjs
//   HOSTS=vercel-sim=http://localhost:3621 node api.mjs
import worker from '../../worker/index.js';
import { sanitizeSceneName, SCENE_NAME_MAX, DEFAULT_SCENE_NAME, DEFAULT_UPLOAD_NAME } from '../../site-source/sceneName.js';

let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

// --- unit ---
ok('trims whitespace', sanitizeSceneName('  Neon Garden  ') === 'Neon Garden');
ok('empty -> Untitled', sanitizeSceneName('   ') === DEFAULT_SCENE_NAME && sanitizeSceneName(null) === 'Untitled' && sanitizeSceneName(undefined) === 'Untitled');
ok('empty -> custom fallback', sanitizeSceneName('', DEFAULT_UPLOAD_NAME) === 'My Scene');
ok('strips control chars', sanitizeSceneName('a\u0000b\nc\u007f') === 'abc');
ok(`caps at ${SCENE_NAME_MAX}`, sanitizeSceneName('x'.repeat(200)).length === SCENE_NAME_MAX && SCENE_NAME_MAX === 80);
ok('keeps unicode and <>', sanitizeSceneName('café 🌸 <b>') === 'café 🌸 <b>');

// --- API ---
function mockKv() {
  const store = new Map();
  return {
    store,
    async get(k) { const e = store.get(k); return e ? (typeof e.value === 'string' ? e.value : new TextDecoder().decode(e.value)) : null; },
    async getWithMetadata(k) { const e = store.get(k); return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null }; },
    async put(k, value, o = {}) { store.set(k, { value, metadata: o.metadata || null }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })) }; }
  };
}
const kv = mockKv();
const workerFetch = (path, init) => worker.fetch(new Request('http://upload-name.test' + path, init), { SCENES: kv, ASSETS: { fetch: async () => new Response('ok') } });
const hosts = [['worker', workerFetch], ...(process.env.HOSTS || '').split(',').filter(Boolean).map(s => { const [h, b] = s.split('='); return [h, (p, i) => fetch(b + p, i)]; })];

const code = ["const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); scene.add(m);"];
for (const [H, f] of hosts) {
  const post = async (body) => (await f('/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const list = async () => { const r = await (await f('/api/community-scenes')).json(); return r.scenes || r; };
  const stamp = Date.now();
  const named = await post({ version: 1, name: `  Named ${stamp}  `, codeBlocks: code });
  ok(`${H} upload stores trimmed name`, named.scene?.name === `Named ${stamp}`, named.scene?.name);
  const rec = await (await f(`/api/community-scenes/${named.id}`)).json();
  ok(`${H} GET returns name`, rec.name === `Named ${stamp}`);
  const l = await list();
  ok(`${H} list tile title is the name`, Array.isArray(l) && l.some(s => s.id === named.id && s.name === `Named ${stamp}`));
  const long = await post({ version: 1, name: 'L'.repeat(300), codeBlocks: code });
  ok(`${H} long name capped to 80`, long.scene?.name === 'L'.repeat(80));
  const blank = await post({ version: 1, name: '   ', codeBlocks: code });
  ok(`${H} blank name -> Untitled`, blank.scene?.name === 'Untitled');
  const legacy = await post({ version: 1, codeBlocks: code });
  ok(`${H} legacy upload without a name still works`, !!legacy.id && legacy.scene?.name === 'Untitled');
  const lr = await (await f(`/api/community-scenes/${legacy.id}`)).json();
  ok(`${H} legacy scene loads`, Array.isArray(lr.codeBlocks) && lr.name === 'Untitled');
}
// Pre-existing KV record that never had a name field
const oldId = 'oldscene0001';
await kv.put(`cs:${oldId}`, JSON.stringify({ id: oldId, codeBlocks: code, createdAt: '2026-01-01T00:00:00Z' }));
const old = await (await workerFetch(`/api/community-scenes/${oldId}`)).json();
ok('worker: stored record with no name still loads', Array.isArray(old.codeBlocks), JSON.stringify(old).slice(0, 120));

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
