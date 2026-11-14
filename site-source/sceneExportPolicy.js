// Export permission of a Community scene ("Allow exports" / "Don't allow
// exports" on upload), plus where the retired /embed/:id route redirects.
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
// Save to Device / Export (.vrscene, the scene's code) and Merge. A
// share link (/s/:id, /e/:id) is not an export: it only points at the scene.

export const OWNER_KEY_HEADER = 'x-gs-owner-key';
export const EXPORTS_OFF_MESSAGE = 'The creator of this scene turned off exports, so it can\'t be downloaded or merged.';

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

// Embedding was removed. Old <iframe src="/embed/:id"> snippets
// and links get a 302 to the scene's view-only share link (/s/:id), so they
// still show the scene instead of breaking. 302 (not 301) so browsers don't
// cache it forever. Anything that isn't a valid scene id goes to the home page.
const LEGACY_EMBED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function legacyEmbedRedirectPath(rawId) {
	let id = '';
	try { id = decodeURIComponent(String(rawId ?? '')); } catch { id = ''; }
	return LEGACY_EMBED_ID_RE.test(id) ? `/s/${encodeURIComponent(id)}` : '/';
}
