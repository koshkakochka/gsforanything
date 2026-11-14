// API + route checks for the per-scene export setting and the retired
// /embed/:id route (302 -> /s/:id), per host:
//   HOSTS=vercel-sim=http://localhost:3631,cf=http://127.0.0.1:3632 node api.mjs
// vercel-sim: ../community-hdri/vercel-sim.mjs (in-memory Blob). cf: wrangler dev
// with a local --persist-to dir. Never point this at production.
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3631').split(',').map(s => s.split('='));
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const H_KEY = 'x-gs-owner-key';
const post = (base, body) => fetch(base + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = (base, id, { key } = {}) => fetch(`${base}/api/community-scenes/${id}`, { headers: key ? { [H_KEY]: key } : {} });
const patch = (base, id, body, key) => fetch(`${base}/api/community-scenes/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(key ? { [H_KEY]: key } : {}) }, body: JSON.stringify(body) });
const list = (base) => fetch(base + '/api/community-scenes').then(r => r.json()).then(d => d.scenes || []);

for (const [H, base] of HOSTS) {
  console.log(`\n== ${H} ${base}`);
  const stamp = Date.now();
  // Default upload: exports allowed, owner key returned once
  const a = await post(base, { version: 1, name: `perm-allow ${stamp}`, codeBlocks: ['scene.add(new THREE.Object3D())'] });
  ok(`${H} default upload allows exports`, a.ok && a.allowExport === true, JSON.stringify({ allowExport: a.allowExport }));
  ok(`${H} upload returns an owner key`, /^[0-9a-f]{48}$/.test(a.ownerKey || ''));
  ok(`${H} upload has no embedUrl`, !('embedUrl' in a) && (a.viewUrl || '').endsWith(`/s/${a.id}`), JSON.stringify(Object.keys(a)));
  const arec = await (await get(base, a.id)).json();
  ok(`${H} record has no embedUrl`, !('embedUrl' in arec));
  ok(`${H} record allowExport true, hash never served`, arec.allowExport === true && !('ownerKeyHash' in arec) && arec.isOwner === false);

  // Don't allow exports
  const d = await post(base, { version: 1, name: `perm-deny ${stamp}`, codeBlocks: ['scene.add(new THREE.Object3D())'], allowExport: false });
  ok(`${H} upload with allowExport:false`, d.ok && d.allowExport === false);
  const drec = await (await get(base, d.id)).json();
  ok(`${H} flag persisted on the record`, drec.allowExport === false && Array.isArray(drec.codeBlocks), JSON.stringify({ allowExport: drec.allowExport }));
  ok(`${H} viewer is not the owner`, drec.isOwner === false && !('ownerKeyHash' in drec));
  ok(`${H} owner key -> isOwner`, (await (await get(base, d.id, { key: d.ownerKey })).json()).isOwner === true);
  ok(`${H} someone else's key -> not owner`, (await (await get(base, d.id, { key: a.ownerKey })).json()).isOwner === false);
  const ls = await list(base);
  ok(`${H} list carries allowExport`, ls.find(s => s.id === d.id)?.allowExport === false && ls.find(s => s.id === a.id)?.allowExport === true);

  // Embedding was removed: /embed/:id is a 302 to the view-only share link
  // (exports on or off, existing or not), never the app or an embed page.
  for (const [label, id] of [['allowed', a.id], ['exports off', d.id], ['missing', `nope${stamp}`]]) {
    const r = await fetch(`${base}/embed/${id}`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    ok(`${H} /embed/:id (${label}) -> 302 /s/:id`, r.status === 302 && new URL(loc, base).pathname === `/s/${id}`, `${r.status} ${loc}`);
  }
  const rq = await fetch(`${base}/embed/${a.id}?vr=0`, { redirect: 'manual' });
  ok(`${H} /embed/:id?vr=0 -> 302 /s/:id`, rq.status === 302 && new URL(rq.headers.get('location') || '', base).pathname === `/s/${a.id}`, String(rq.status));
  const bad = await fetch(`${base}/embed/${encodeURIComponent('bad id!')}`, { redirect: 'manual' });
  ok(`${H} /embed/<bad id> -> 302 home`, bad.status === 302 && new URL(bad.headers.get('location') || '', base).pathname === '/', `${bad.status} ${bad.headers.get('location')}`);
  const followed = await fetch(`${base}/embed/${a.id}`);
  ok(`${H} following the redirect lands on the app`, followed.status === 200 && new URL(followed.url).pathname === `/s/${a.id}` && (await followed.text()).includes('main.js'), followed.url);
  ok(`${H} ?embed=1 is just a normal read now`, (await fetch(`${base}/api/community-scenes/${d.id}?embed=1`)).status === 200);
  const s = await fetch(`${base}/s/${d.id}`);
  ok(`${H} /s/:id of a no-export scene can't be framed elsewhere`, s.status === 200 && /frame-ancestors 'self'/.test(s.headers.get('content-security-policy') || ''), s.headers.get('content-security-policy'));
  const sa = await fetch(`${base}/s/${a.id}`);
  ok(`${H} /s/:id of an allowed scene has no frame block`, sa.status === 200 && !/frame-ancestors/.test(sa.headers.get('content-security-policy') || ''));

  // Spoofing on upload
  const sp = await post(base, { version: 1, name: `perm-spoof ${stamp}`, codeBlocks: ['1'], ownerKeyHash: 'x', isOwner: true, ownerKey: 'abc' });
  const sprec = await (await get(base, sp.id)).json();
  ok(`${H} upload can't spoof ownership`, sprec.isOwner === false && !('ownerKeyHash' in sprec) && !('ownerKey' in sprec));

  // PATCH: only the owner changes the flag
  ok(`${H} PATCH allowExport without key refused`, (await patch(base, d.id, { allowExport: true })).status === 403);
  ok(`${H} PATCH allowExport with wrong key refused`, (await patch(base, d.id, { allowExport: true }, a.ownerKey)).status === 403);
  ok(`${H} still off`, (await (await get(base, d.id)).json()).allowExport === false);
  const pr = await patch(base, d.id, { name: `perm-deny renamed ${stamp}` });
  const prj = await pr.json();
  ok(`${H} rename (no key) keeps exports off`, pr.ok && prj.allowExport === false && (await (await get(base, d.id)).json()).allowExport === false);
  const on = await patch(base, d.id, { allowExport: true }, d.ownerKey);
  ok(`${H} owner turns exports on`, on.ok && (await on.json()).allowExport === true);
  const onrec = await (await get(base, d.id)).json();
  ok(`${H} on: record`, onrec.allowExport === true && onrec.name === `perm-deny renamed ${stamp}`);
  ok(`${H} on: list updated`, (await list(base)).find(x => x.id === d.id)?.allowExport === true);
  const off = await patch(base, d.id, { allowExport: false }, d.ownerKey);
  ok(`${H} owner turns exports off again`, off.ok && (await off.json()).allowExport === false);
  ok(`${H} only one list entry per scene`, (await list(base)).filter(x => x.id === d.id).length === 1);
  ok(`${H} owner key still works after rename/toggle`, (await (await get(base, d.id, { key: d.ownerKey })).json()).isOwner === true);
}
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
