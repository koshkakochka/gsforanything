import * as M from '../../site-source/communityMerge.js';
if (process.env.GS_REAL_CALL !== '1') { console.log('Spends one real AI call on the live site. Set GS_REAL_CALL=1 to run.'); process.exit(0); }
import fs from 'fs';
const B64 = fs.readFileSync('noise.b64', 'utf8').trim().slice(0, 1200);
const A = ["const st = (window.st ??= {}); st.score ??= 0;\nconst player = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.3,0.3), new THREE.MeshStandardMaterial({ color: 0x33aaff }));\nplayer.name = 'a_player'; player.position.set(0, 0.15, -1.5); scene.add(player);\nwindow._vrAnimations.push(() => { if (gsGamepad.connected) player.position.x += gsGamepad.axis('leftX') * 0.02; });"];
const B = [`const tex = new THREE.TextureLoader().load("data:image/png;base64,${B64}");\nconst box = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.5), new THREE.MeshBasicMaterial({ map: tex })); box.name = 'b_catBox'; box.position.set(0.8, 0.25, -2); scene.add(box);`];
const req = M.buildMergeRequest({ sceneA: { label: 'A', id: 'realA', name: 'Runner', codeBlocks: A }, sceneB: { label: 'B', id: 'realB', name: 'Cat Garden', codeBlocks: B }, prompt: 'Controls from A; use B\'s textured box as the player instead of the plain cube. Keep it short.', picks: { controls: 'A', assets: 'B' } });
console.log('sent chars', req.message.length, 'assets', req.stats.assets, 'b64 leaked', req.message.includes(B64.slice(0, 40)));
const t0 = Date.now();
const res = await fetch((process.env.GS_URL || 'https://gs.krossruiz.workers.dev') + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: req.message }], backend: 'claude-haiku-55' }) });
const data = await res.json();
const raw = data.content?.[0]?.text || JSON.stringify(data);
fs.writeFileSync('real-reply.txt', raw);
console.log('status', res.status, 'ms', Date.now() - t0);
const blocks = [...raw.matchAll(/```vr-exec\s*\n([\s\S]*?)```/g)].map(m => m[1]);
const ex = M.expandMergedBlocks(blocks, req.tables);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let syntax = 'ok'; try { for (const b of ex.blocks) new AsyncFunction('THREE', 'scene', 'camera', 'renderer', 'document', b); } catch (e) { syntax = e.message; }
console.log({ blocks: blocks.length, kept: ex.kept, restored: ex.restored, syntax, assetRestored: ex.blocks.join('\n').includes(B64), usesToken: raw.includes('__GS_ASSET_B1__'), retypedBase64: raw.includes(B64.slice(100, 160)) });
