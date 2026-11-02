// API + route checks for the per-scene export setting and /embed/:id, per host:
//   HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 node api.mjs
// vercel-sim: ../community-hdri/vercel-sim.mjs (in-memory Blob). cf: wrangler dev
// with a local --persist-to dir. Never point this at production.
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3631').split(',').map(s => s.split('='));
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const H_KEY = 'x-gs-owner-key';
const post = (base, body) => fetch(base + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = (base, id, { key, embed } = {}) => fetch(`${base}/api/community-scenes/${id}${embed ? '?embed=1' : ''}`, { headers: key ? { [H_KEY]: key } : {} });
const patch = (base, id, body, key) => fetch(`${base}/api/community-scenes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(key ? { [H_KEY]: key } : {}) }, body: JSON.stringify(body) });
const list = (base) => fetch(base + '/api/community-scenes').then(r => r.json()).then(d => d.scenes || []);

for (const [H, base] of HOSTS) {
  console.log(`\n== ${H} ${base}`);
  const stamp = Date.now();
  // Default upload: exports allowed, owner key returned once
  const a = await post(base, { version: 1, name: `embed-allow ${stamp}`, codeBlocks: ['scene.add(new THREE.Object3D())'] });
  ok(`${H} default upload allows exports`, a.ok && a.allowExport === true, JSON.stringify({ allowExport: a.allowExport }));
  ok(`${H} upload returns an owner key`, /^[0-9a-f]{48}$/.test(a.ownerKey || ''));
  // wrangler dev reports the route's host (gsforanything.com) as the origin
  ok(`${H} upload returns embedUrl`, (a.embedUrl || '').endsWith(`/embed/${a.id}`) && a.embedUrl.startsWith('http'), a.embedUrl);
  const arec = await (await get(base, a.id)).json();
  ok(`${H} record allowExport true, hash never served`, arec.allowExport === true && !('ownerKeyHash' in arec) && arec.isOwner === false);

  // Don't allow exports
  const d = await post(base, { version: 1, name: `embed-deny ${stamp}`, codeBlocks: ['scene.add(new THREE.Object3D())'], allowExport: false });
  ok(`${H} upload with allowExport:false`, d.ok && d.allowExport === false);
  const drec = await (await get(base, d.id)).json();
  ok(`${H} flag persisted on the record`, drec.allowExport === false && Array.isArray(drec.codeBlocks), JSON.stringify({ allowExport: drec.allowExport }));
  ok(`${H} viewer is not the owner`, drec.isOwner === false && !('ownerKeyHash' in drec));
  ok(`${H} owner key -> isOwner`, (await (await get(base, d.id, { key: d.ownerKey })).json()).isOwner === true);
  ok(`${H} someone else's key -> not owner`, (await (await get(base, d.id, { key: a.ownerKey })).json()).isOwner === false);
  const ls = await list(base);
  ok(`${H} list carries allowExport`, ls.find(s => s.id === d.id)?.allowExport === false && ls.find(s => s.id === a.id)?.allowExport === true);

  // ?embed=1 and /embed/:id
  ok(`${H} ?embed=1 refused when exports are off`, (await get(base, d.id, { embed: true })).status === 403);
  ok(`${H} ?embed=1 fine when allowed`, (await get(base, a.id, { embed: true })).status === 200);
  const e403 = await fetch(`${base}/embed/${d.id}`);
  const e403t = await e403.text();
  ok(`${H} /embed/:id 403 page when exports are off`, e403.status === 403 && e403t.includes('gs-embed-unavailable') && e403t.includes('Made with GS For Anything'), String(e403.status));
  const e200 = await fetch(`${base}/embed/${a.id}`);
  const e200t = await e200.text();
  ok(`${H} /embed/:id serves the app when allowed`, e200.status === 200 && e200t.includes('main.js'), String(e200.status));
  const e404 = await fetch(`${base}/embed/nope${stamp}`);
  ok(`${H} /embed/:id 404 for a missing scene`, e404.status === 404 && (await e404.text()).includes('gs-embed-unavailable'));
  const s = await fetch(`${base}/s/${d.id}`);
  ok(`${H} /s/:id of a no-export scene can't be framed elsewhere`, s.status === 200 && /frame-ancestors 'self'/.test(s.headers.get('content-security-policy') || ''), s.headers.get('content-security-policy'));
  const sa = await fetch(`${base}/s/${a.id}`);
  ok(`${H} /s/:id of an allowed scene has no frame block`, sa.status === 200 && !/frame-ancestors/.test(sa.headers.get('content-security-policy') || ''));

  // Spoofing on upload
  const sp = await post(base, { version: 1, name: `embed-spoof ${stamp}`, codeBlocks: ['1'], ownerKeyHash: 'x', isOwner: true, ownerKey: 'abc' });
  const sprec = await (await get(base, sp.id)).json();
  ok(`${H} upload can't spoof ownership`, sprec.isOwner === false && !('ownerKeyHash' in sprec) && !('ownerKey' in sprec));

  // PATCH: only the owner changes the flag
  ok(`${H} PATCH allowExport without key refused`, (await patch(base, d.id, { allowExport: true })).status === 403);
  ok(`${H} PATCH allowExport with wrong key refused`, (await patch(base, d.id, { allowExport: true }, a.ownerKey)).status === 403);
  ok(`${H} still off`, (await (await get(base, d.id)).json()).allowExport === false);
  const pr = await patch(base, d.id, { name: `embed-deny renamed ${stamp}` });
  const prj = await pr.json();
  ok(`${H} rename (no key) keeps exports off`, pr.ok && prj.allowExport === false && (await (await get(base, d.id)).json()).allowExport === false);
  const on = await patch(base, d.id, { allowExport: true }, d.ownerKey);
  ok(`${H} owner turns exports on`, on.ok && (await on.json()).allowExport === true);
  const onrec = await (await get(base, d.id)).json();
  ok(`${H} on: record + embed`, onrec.allowExport === true && onrec.name === `embed-deny renamed ${stamp}` && (await fetch(`${base}/embed/${d.id}`)).status === 200);
  ok(`${H} on: list updated`, (await list(base)).find(x => x.id === d.id)?.allowExport === true);
  const off = await patch(base, d.id, { allowExport: false }, d.ownerKey);
  ok(`${H} owner turns exports off again`, off.ok && (await off.json()).allowExport === false && (await fetch(`${base}/embed/${d.id}`)).status === 403);
  ok(`${H} only one list entry per scene`, (await list(base)).filter(x => x.id === d.id).length === 1);
  ok(`${H} owner key still works after rename/toggle`, (await (await get(base, d.id, { key: d.ownerKey })).json()).isOwner === true);
}
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
