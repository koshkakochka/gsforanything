// API checks for environmentHdri on Community uploads, per host:
//   HOSTS=vercel-sim=http://localhost:3611,cf=http://localhost:3612 node api.mjs
// (vercel-sim.mjs here; the Worker via `wrangler dev`, see README.md)
const HOSTS = (process.env.HOSTS || 'vercel-sim=http://localhost:3611').split(',').map(s => s.split('='));
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const post = (base, body) => fetch(base + '/api/community-scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const get = (base, id) => fetch(`${base}/api/community-scenes/${id}`).then(r => r.json());
const bytes = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n' + '\u0080\u0080\u0080\u0081'.repeat(2), 'latin1');

for (const [H, base] of HOSTS) {
  // Legacy scene (no environmentHdri)
  const legacy = await post(base, { version: 1, name: 'hdri-legacy', codeBlocks: ['1'] });
  const lrec = await get(base, legacy.id);
  ok(`${H} legacy upload has no environmentHdri`, legacy.ok && !('environmentHdri' in lrec));
  ok(`${H} legacy scene has no stored HDRI`, (await fetch(`${base}/api/community-scenes/${legacy.id}/hdri`)).status === 404);
  ok(`${H} HDRI PUT refused for a scene without a file HDRI`, (await fetch(`${base}/api/community-scenes/${legacy.id}/hdri`, { method: 'PUT', body: bytes })).status === 409);

  // URL HDRI
  const u = await post(base, { version: 1, name: 'hdri-url', codeBlocks: ['1'], environmentHdri: { kind: 'url', url: 'https://example.test/sky.hdr', background: false } });
  const urec = await get(base, u.id);
  ok(`${H} url HDRI stored`, JSON.stringify(urec.environmentHdri) === JSON.stringify({ kind: 'url', url: 'https://example.test/sky.hdr', format: 'hdr', background: false }), JSON.stringify(urec.environmentHdri));

  // Invalid HDRI is dropped, upload still works
  const bad = await post(base, { version: 1, name: 'hdri-bad', codeBlocks: ['1'], environmentHdri: { kind: 'url', url: 'javascript:alert(1)' } });
  ok(`${H} invalid HDRI dropped`, bad.ok && !('environmentHdri' in (await get(base, bad.id))));

  // File HDRI: declared on POST, bytes via PUT once
  const fl = await post(base, { version: 1, name: 'hdri-file', codeBlocks: ['1'], environmentHdri: { kind: 'file', name: 'studio.hdr', size: bytes.length, url: 'https://evil.test/x.hdr' } });
  const frec = await get(base, fl.id);
  ok(`${H} file HDRI url is the scene's own endpoint`, frec.environmentHdri?.url === `/api/community-scenes/${fl.id}/hdri`, JSON.stringify(frec.environmentHdri));
  ok(`${H} file HDRI not served before upload`, (await fetch(`${base}/api/community-scenes/${fl.id}/hdri`)).status === 404);
  const put = await fetch(`${base}/api/community-scenes/${fl.id}/hdri`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  ok(`${H} HDRI PUT accepted`, put.ok, String(put.status));
  const g = await fetch(`${base}${frec.environmentHdri.url}`);
  const gb = Buffer.from(await g.arrayBuffer());
  ok(`${H} HDRI served byte-identical`, g.ok && gb.equals(bytes), `${g.status} ${gb.length}/${bytes.length}`);
  ok(`${H} HDRI content-type`, g.headers.get('content-type') === 'image/vnd.radiance', g.headers.get('content-type'));
  ok(`${H} second HDRI PUT refused`, (await fetch(`${base}/api/community-scenes/${fl.id}/hdri`, { method: 'PUT', body: Buffer.from('xx') })).status === 409);
  ok(`${H} scene record unchanged by PUT`, JSON.stringify((await get(base, fl.id)).environmentHdri) === JSON.stringify(frec.environmentHdri));
  ok(`${H} HDRI on unknown id 404`, (await fetch(`${base}/api/community-scenes/zzzzzzzzzzzz/hdri`, { method: 'PUT', body: bytes })).status === 404);
  ok(`${H} empty HDRI refused`, (await fetch(`${base}/api/community-scenes/${(await post(base, { version: 1, name: 'e', codeBlocks: ['1'], environmentHdri: { kind: 'file', name: 'a.hdr' } })).id}/hdri`, { method: 'PUT', body: Buffer.alloc(0) })).status === 400);
  // Too large (> 20 MB)
  const big = await post(base, { version: 1, name: 'hdri-big', codeBlocks: ['1'], environmentHdri: { kind: 'file', name: 'big.exr' } });
  const bigRes = await fetch(`${base}/api/community-scenes/${big.id}/hdri`, { method: 'PUT', body: Buffer.alloc(21 * 1024 * 1024, 1) });
  ok(`${H} >20 MB HDRI refused (413)`, bigRes.status === 413, String(bigRes.status));
  // Rename keeps environmentHdri
  await fetch(`${base}/api/community-scenes/${fl.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'hdri-file-renamed' }) });
  const rr = await get(base, fl.id);
  ok(`${H} rename keeps environmentHdri + HDRI`, rr.name === 'hdri-file-renamed' && rr.environmentHdri?.url === frec.environmentHdri.url && (await fetch(`${base}${rr.environmentHdri.url}`)).ok);
  if (H.startsWith('vercel')) {
    const late = await post(base, { version: 1, name: 'late', codeBlocks: ['1'], environmentHdri: { kind: 'file', name: 'a.hdr' } });
    await fetch(`${base}/__blobstore/age`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: late.id }) });
    ok(`${H} HDRI PUT after the upload window refused`, (await fetch(`${base}/api/community-scenes/${late.id}/hdri`, { method: 'PUT', body: bytes })).status === 409);
  }
}
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
