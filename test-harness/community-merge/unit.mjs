import * as M from '../../site-source/communityMerge.js';
const b64 = 'iVBORw0KGgo' + 'A'.repeat(3000) + '==';
const A = ["// player\nconst p = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); p.name='player'; scene.add(p);\ngs.state.score ??= 0;\nconst s = 'it\\'s fine';"];
const B = [`await gsImportP5Sketch({\n\tname: "Cat",\n\tfiles: {\n\t\t"sketch.js": \`function setup(){createCanvas(100,100)}\`,\n\t\t"assets/cat.png": {"base64":"${b64}","type":"image/png"}\n\t}\n});`, `const tex = new THREE.TextureLoader().load("data:image/png;base64,${b64}"); // texture\nconst prose = "${'lorem ipsum dolor '.repeat(100)}";`];
const r = M.buildMergeRequest({ sceneA: { label: 'A', id: 'a1', name: 'Runner', codeBlocks: A }, sceneB: { label: 'B', id: 'b1', name: 'Cats', codeBlocks: B }, prompt: 'controls from A, art from B', picks: { controls: 'A', assets: 'B' } });
console.log(r.stats, r.message.includes(b64.slice(0, 50)) ? 'LEAK' : 'no base64 in message');
console.log([...r.tables.assets.values()].map(a => [a.id, a.kind, a.mime, a.chars]));
const out = M.expandMergedBlocks(['// @gs-keep B1\nconst t2 = __GS_ASSET_B2__; const q = "__GS_ASSET_B1__";', '// @gs-keep A1'], r.tables);
console.log(out.kept, out.restored, out.blocks[0] === B[0] + `\nconst t2 = "data:image/png;base64,${b64}"; const q = "${b64}";`, out.blocks[1] === A[0]);
try { M.expandMergedBlocks(['x = __GS_ASSET_B9__'], r.tables); } catch (e) { console.log('err ok:', e.message); }
console.log(r.message.slice(0, 300));
