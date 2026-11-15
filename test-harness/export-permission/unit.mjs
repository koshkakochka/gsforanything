//   node unit.mjs
import { allowExportFromBody, exportAllowed, isSceneOwner, newOwnerKey, ownerKeyHash, publicSceneRecord, legacyEmbedRedirectPath } from '../../site-source/sceneExportPolicy.js';
let fails = 0, n = 0;
const ok = (name, cond, extra = '') => { n++; if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };


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
ok('legacy /embed/:id redirects to the share page', legacyEmbedRedirectPath('mvziiev10e4f789b') === '/s/mvziiev10e4f789b' && legacyEmbedRedirectPath('a_b-C') === '/s/a_b-C');
ok('bad /embed ids go home', legacyEmbedRedirectPath('') === '/' && legacyEmbedRedirectPath('..%2F..%2Fapi') === '/' && legacyEmbedRedirectPath('%E0%A4%A') === '/' && legacyEmbedRedirectPath('x'.repeat(65)) === '/' && legacyEmbedRedirectPath('a b') === '/');
let embedModuleGone = false;
try { await import('../../site-source/embedExport.js'); } catch { embedModuleGone = true; }
ok('embedExport.js is gone', embedModuleGone);
console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
