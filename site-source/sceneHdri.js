// Environment HDRI saved with a scene (Environment tab → 360 / HDRI).
//
// Shared by the browser (main.js), the Vercel server (server.js) and the
// Cloudflare Worker (worker/index.js) so all three agree on the shape:
//
//   environmentHdri = {
//     kind: 'url',  url: 'https://…/env.hdr',             format, background }
//   | { kind: 'file', name: 'studio.exr', size: 123456,
//       url: '/api/community-scenes/:id/hdri',             format, background }
//
// - 'url': an HDRI loaded from a URL; the scene just keeps the URL.
// - 'file': an HDRI the user picked from their computer. It only exists in
//   that browser, so a Community upload sends the bytes in a second request
//   (PUT /api/community-scenes/:id/hdri) and the server keeps them next to the
//   scene. `url` is set by the server, never trusted from the client.
// - format: 'hdr' | 'exr' | 'image' (picks the three.js loader; API URLs
//   have no file extension).
// - background: the "Show as background" checkbox.
// Scenes saved before this field existed have none and keep the viewer's
// current environment.

export const HDRI_FORMATS = ['hdr', 'exr', 'image'];
/** Largest custom HDRI file a Community upload stores (bytes, before any
 *  host limit: Vercel functions reject request bodies over ~4.5 MB). */
export const HDRI_FILE_MAX_BYTES = 20 * 1024 * 1024;
const URL_MAX = 2048;
const NAME_MAX = 120;

export function hdriFormatFromName(name) {
	const lower = String(name || '').split(/[?#]/)[0].toLowerCase();
	if (lower.endsWith('.hdr') || lower.endsWith('.hdri')) return 'hdr';
	if (lower.endsWith('.exr')) return 'exr';
	return 'image';
}

/** Community-stored HDRI path for a scene id. */
export function communityHdriPath(id) {
	return `/api/community-scenes/${encodeURIComponent(id)}/hdri`;
}

function okUrl(url) {
	if (typeof url !== 'string') return false;
	const u = url.trim();
	if (!u || u.length > URL_MAX) return false;
	return /^https?:\/\//i.test(u) || /^\/api\/community-scenes\/[A-Za-z0-9_-]{8,40}\/hdri$/.test(u);
}

/** Normalised copy of a scene's environmentHdri, or null when absent/invalid. */
export function normalizeEnvironmentHdri(v) {
	if (!v || typeof v !== 'object') return null;
	const background = v.background !== false;
	if (v.kind === 'url') {
		if (!okUrl(v.url)) return null;
		const url = v.url.trim();
		const format = HDRI_FORMATS.includes(v.format) ? v.format : hdriFormatFromName(url);
		return { kind: 'url', url, format, background };
	}
	if (v.kind === 'file') {
		const name = String(v.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) || 'environment.hdr';
		const format = HDRI_FORMATS.includes(v.format) ? v.format : hdriFormatFromName(name);
		const size = Number.isFinite(v.size) && v.size > 0 ? Math.floor(v.size) : null;
		const out = { kind: 'file', name, format, background };
		if (size) out.size = size;
		if (okUrl(v.url)) out.url = v.url.trim();
		return out;
	}
	return null;
}

/** What a server stores for an uploaded scene's environmentHdri (or null). A
 *  'file' gets the scene's own HDRI endpoint as its url. */
export function environmentHdriForRecord(v, id) {
	const n = normalizeEnvironmentHdri(v);
	if (!n) return null;
	if (n.kind === 'file') n.url = communityHdriPath(id);
	return n;
}

/** URL the browser loads, or null (e.g. a 'file' whose bytes never arrived). */
export function environmentHdriLoadUrl(v) {
	const n = normalizeEnvironmentHdri(v);
	return n && n.url ? n.url : null;
}

/** Stable string for "has the environment changed since it was shared?" */
export function environmentHdriSignature(v) {
	const n = normalizeEnvironmentHdri(v);
	if (!n) return 'null';
	// A loaded community 'file' and the same HDRI re-saved as its url match.
	return JSON.stringify(n.url ? [n.url, n.background] : ['file', n.name, n.size || 0, n.background]);
}

/** Content type for a stored HDRI. */
export function hdriContentType(format) {
	if (format === 'hdr') return 'image/vnd.radiance';
	if (format === 'exr') return 'image/x-exr';
	return 'application/octet-stream';
}
