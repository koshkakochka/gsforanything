// Export permission of a Community scene ("Allow exports" / "Don't allow
// exports" on upload) and the embed page's server-side bits.
//
// Shared by the Vercel server (server.js), the Cloudflare Worker
// (worker/index.js) and the browser (main.js), so all three agree on:
//
//   record.allowExport   true (default) | false. Records uploaded before this
//                        existed have no field and count as allowed.
//   record.ownerKeyHash  SHA-256 (hex) of a random owner key the server
//                        returns ONCE from the upload (POST) as `ownerKey`.
//                        The uploader's browser keeps the key (localStorage)
//                        and sends it as the x-gs-owner-key header; that is
//                        how the server knows the owner (GS has no accounts).
//                        Never sent back to anyone.
//
// What "exports" means (see README / PR): GLB / glTF / FBX / OBJ / Blender,
// Save to Device / Export (.vrscene, the scene's code), Merge, and Embed. A
// share link (/s/:id, /e/:id) is not an export: it only points at the scene.

export const OWNER_KEY_HEADER = 'x-gs-owner-key';
export const EXPORTS_OFF_MESSAGE = 'The creator of this scene turned off exports, so it can\'t be downloaded, merged or embedded.';

/** Upload body -> stored flag. Only an explicit false turns exports off. */
export function allowExportFromBody(v) {
	return v === false || v === 'false' || v === 0 ? false : true;
}

/** Stored record (or list item) -> are exports allowed? Missing = allowed. */
export function exportAllowed(record) {
	return !(record && record.allowExport === false);
}

function hex(buf) {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random owner key (hex). Web Crypto: present in Workers, Node 18+, browsers. */
export function newOwnerKey() {
	const bytes = new Uint8Array(24);
	globalThis.crypto.getRandomValues(bytes);
	return hex(bytes);
}

export async function ownerKeyHash(key) {
	const data = new TextEncoder().encode(String(key));
	return hex(await globalThis.crypto.subtle.digest('SHA-256', data));
}

/** Does `key` (header value) match the record's owner? Constant-ish time compare. */
export async function isSceneOwner(record, key) {
	if (!record || !record.ownerKeyHash || !key || typeof key !== 'string' || key.length > 200) return false;
	const h = await ownerKeyHash(key);
	const want = String(record.ownerKeyHash);
	if (h.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ want.charCodeAt(i);
	return diff === 0;
}

/** The record as the API serves it: owner hash removed, flag explicit. */
export function publicSceneRecord(record, { isOwner = false } = {}) {
	const { ownerKeyHash: _omit, ...rest } = record || {};
	return { ...rest, allowExport: exportAllowed(record), isOwner: !!isOwner };
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

/** Small standalone page for /embed/:id when the scene is missing or its
 *  creator turned exports (and so embedding) off. */
export function embedUnavailableHtml({ status = 404, name = '', origin = '' } = {}) {
	const title = status === 403 ? 'Embedding is turned off' : 'Scene not found';
	const body = status === 403
		? `The creator of ${name ? `“${escapeHtml(name)}”` : 'this scene'} turned off exports, so it can't be embedded on other sites.`
		: 'This GS scene doesn\'t exist (any more).';
	const home = `${escapeHtml(origin)}/`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — GS For Anything</title>
<style>html,body{margin:0;height:100%;background:#16161f;color:#fff;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;box-sizing:border-box;text-align:center}h1{margin:0;font-size:18px}p{margin:0;color:rgba(255,255,255,.75);max-width:420px}a{color:#c7d2fe}</style></head>
<body><main id="gs-embed-unavailable" data-status="${status}"><h1>${title}</h1><p>${body}</p><p><a href="${home}" target="_blank" rel="noopener">Made with GS For Anything</a></p></main></body></html>`;
}
