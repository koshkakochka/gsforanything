// One progress bar for WebLLM's multi-phase load (localLLM.js createProgressTracker).
//   node unit.mjs
import { createProgressTracker, progressPhase } from '../../site-source/localLLM.js';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${!ok && d !== '' ? '  — ' + JSON.stringify(d) : ''}`); };

// The report texts WebLLM 0.2.88 emits (see fetchTensorCacheInternal / shader loading / reload).
const seq = (cached) => {
	const out = [{ progress: 0, text: 'Start to fetch params' }];
	if (!cached) for (let i = 1; i <= 30; i++) out.push({ progress: i / 30, text: `Fetching param cache[${i}/30]: ${i * 28}MB fetched. ${Math.floor(i / 30 * 100)}% completed, ${i} secs elapsed. It can take a while when we first visit this page to populate the cache. Later refreshes will become faster.` });
	for (let i = 1; i <= 30; i++) out.push({ progress: i / 30, text: `Loading model from cache[${i}/30]: ${i * 28}MB loaded. ${Math.floor(i / 30 * 100)}% completed, ${30 + i} secs elapsed.` });
	for (let i = 1; i <= 12; i++) out.push({ progress: i / 12, text: `Loading GPU shader modules[${i}/12]: ${Math.floor(i / 12 * 100)}% completed, ${70 + i} secs elapsed.` });
	out.push({ progress: 1, text: 'Finish loading on WebGPU - google' });
	return out;
};

for (const cached of [false, true]) {
	const name = cached ? 'cached' : 'first download';
	const t = createProgressTracker();
	const values = seq(cached).map((r) => t.update(r).progress);
	const pcts = values.map((v) => Math.floor(v * 100));
	check(`${name}: progress never goes backwards`, values.every((v, i) => i === 0 || v >= values[i - 1]), pcts);
	check(`${name}: never 100% before the engine is ready`, values.every((v) => v < 1), Math.max(...values));
	check(`${name}: ends near the top (99%)`, pcts[pcts.length - 1] === 99, pcts[pcts.length - 1]);
	const fin = t.complete();
	check(`${name}: 100% exactly once, when complete() is called`, fin.progress === 1 && fin.done && [...values, fin.progress].filter((v) => v >= 1).length === 1);
	check(`${name}: reports after complete() are ignored`, t.update({ progress: 0.1, text: 'Loading model from cache[1/30]: 1MB loaded. 3% completed' }).progress === 1);
	check(`${name}: the WebLLM per-phase "% completed" is not shown`, !/% completed/.test(createProgressTracker().update(seq(cached)[3]).text));
}
// Download phase ends at 80%; the GPU load then continues from there instead of restarting at 0.
{
	const t = createProgressTracker();
	for (const r of seq(false)) { t.update(r); if (/Fetching param cache\[30\/30\]/.test(r.text)) break; }
	const afterDl = t.snapshot().progress;
	const firstLoad = t.update({ progress: 1 / 30, text: 'Loading model from cache[1/30]: 28MB loaded. 3% completed' }).progress;
	check('download fills 0–80%, GPU load continues from 80%', Math.abs(afterDl - 0.8) < 1e-9 && firstLoad > afterDl, { afterDl, firstLoad });
	check('phase label follows the phase', t.snapshot().label === 'Loading onto the GPU');
}
check('phases detected from the texts', progressPhase('Fetching param cache[1/2]') === 'fetch' && progressPhase('Loading model from cache[1/2]') === 'load' && progressPhase('Loading GPU shader modules[1/2]') === 'shader' && progressPhase('Finish loading on WebGPU') === 'finish');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
