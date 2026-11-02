// Pure helpers: embed snippet (embedExport.js) and export policy (sceneExportPolicy.js).
//   node unit.mjs
import { buildEmbedSnippet, embedUrlFor } from '../../site-source/embedExport.js';
import { allowExportFromBody, exportAllowed, isSceneOwner, newOwnerKey, ownerKeyHash, publicSceneRecord, embedUnavailableHtml } from '../../site-source/sceneExportPolicy.js';
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

ok('embed url', embedUrlFor('https://gsforanything.com/', 'abc123') === 'https://gsforanything.com/embed/abc123');
ok('embed url without VR', embedUrlFor('https://gsforanything.com', 'abc123', { vr: false }) === 'https://gsforanything.com/embed/abc123?vr=0');
const snip = buildEmbedSnippet({ origin: 'https://gsforanything.com', id: 'abc123', name: 'Tiny "house" <3' });
ok('snippet is an iframe to /embed/:id', /^<iframe src="https:\/\/gsforanything\.com\/embed\/abc123" /.test(snip) && snip.endsWith('></iframe>'), snip);
ok('snippet responsive by default', snip.includes('width="100%"') && snip.includes('aspect-ratio:16/9'));
ok('snippet allows WebXR + fullscreen', snip.includes('allow="xr-spatial-tracking; fullscreen;') && snip.includes('allowfullscreen'));
ok('snippet lazy-loads', snip.includes('loading="lazy"'));
ok('snippet escapes the name', snip.includes('title="Tiny &quot;house&quot; &lt;3 — GS For Anything"'), snip);
const fixed = buildEmbedSnippet({ origin: 'https://x.test', id: 'q', vr: false, size: '800x450' });
ok('fixed size + no VR', fixed.includes('width="800" height="450"') && fixed.includes('/embed/q?vr=0') && !fixed.includes('xr-spatial-tracking'), fixed);
let threw = false; try { buildEmbedSnippet({ origin: 'x' }); } catch { threw = true; }
ok('snippet needs an id', threw);

ok('allowExport default true', allowExportFromBody(undefined) === true && allowExportFromBody(null) === true && allowExportFromBody('yes') === true);
ok('allowExport false values', allowExportFromBody(false) === false && allowExportFromBody('false') === false && allowExportFromBody(0) === false);
ok('legacy record allows exports', exportAllowed({}) === true && exportAllowed({ allowExport: true }) && !exportAllowed({ allowExport: false }));
const key = newOwnerKey();
const rec = { id: 'a', allowExport: false, ownerKeyHash: await ownerKeyHash(key) };
ok('owner key is 48 hex chars', /^[0-9a-f]{48}$/.test(key));
ok('owner key matches its hash', await isSceneOwner(rec, key));
ok('wrong / missing key is not the owner', !(await isSceneOwner(rec, newOwnerKey())) && !(await isSceneOwner(rec, '')) && !(await isSceneOwner({ id: 'legacy' }, key)));
const pub = publicSceneRecord(rec, { isOwner: false });
ok('public record hides the hash', !('ownerKeyHash' in pub) && pub.allowExport === false && pub.isOwner === false);
const html = embedUnavailableHtml({ status: 403, name: '<b>x</b>', origin: 'https://gsforanything.com' });
ok('unavailable page escapes + links home', html.includes('&lt;b&gt;x&lt;/b&gt;') && html.includes('Made with GS For Anything') && html.includes('data-status="403"'));
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
