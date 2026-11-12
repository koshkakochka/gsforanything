// Community scene thumbnails: compact WebP/JPEG captured from the scene's
// initial camera pose, stored under a separate key/blob so the scene list
// stays small. Shared by the Cloudflare Worker and the Vercel server.

export const THUMB_WIDTH = 512;
export const THUMB_HEIGHT = 288;
export const THUMB_MAX_BYTES = 60 * 1024;
// A little headroom on incoming payloads (base64 padding, slightly higher quality).
export const THUMB_ACCEPT_MAX_BYTES = 80 * 1024;
export const THUMB_PREFIX = 'community-scene-thumbs/';
export const thumbKey = (id) => `scene:${id}:thumb`;
export const thumbPathname = (id) => `${THUMB_PREFIX}${id}`;
export const thumbEndpoint = (id) => `/api/community-scenes/${id}/thumb`;
export const thumbAliasEndpoint = (id) => `/api/scenes/${id}/thumb`;

const ALLOWED_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png']);

export function thumbStub(id, extra = {}) {
	return { stored: 'separate', url: thumbEndpoint(id), ...extra };
}

export function listThumbFields(id, hasThumbnail) {
	const has = !!hasThumbnail;
	return { hasThumbnail: has, thumbUrl: has ? thumbEndpoint(id) : null };
}

function normalizeType(t) {
	const s = String(t || '').toLowerCase().trim();
	if (s === 'image/jpg') return 'image/jpeg';
	return s;
}

function magicOk(bytes, mime) {
	if (!bytes || bytes.byteLength < 12) return false;
	if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mime === 'image/png') {
		return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	}
	if (mime === 'image/webp') {
		// RIFF....WEBP
		return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
			&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
	}
	return false;
}

function bytesFromBase64(b64) {
	const clean = String(b64 || '').replace(/\s+/g, '');
	if (!clean || /[^A-Za-z0-9+/=]/.test(clean)) return null;
	try {
		if (typeof atob === 'function') {
			const bin = atob(clean);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Parse a client-sent thumbnail (data URL, or { data, contentType }).
 * Returns { bytes: Uint8Array, contentType } on success, or { error }.
 * Returns null when nothing was sent (omit the field).
 */
export function parseThumbnailPayload(input) {
	if (input == null || input === '') return null;
	let mime = '';
	let b64 = '';
	if (typeof input === 'string') {
		const m = input.trim().match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
		if (!m) return { error: 'invalid' };
		mime = normalizeType(m[1]);
		b64 = m[2];
	} else if (typeof input === 'object' && typeof input.data === 'string') {
		mime = normalizeType(input.contentType || input.type || 'image/jpeg');
		if (input.data.startsWith('data:')) {
			const parsed = parseThumbnailPayload(input.data);
			return parsed;
		}
		b64 = input.data;
	} else {
		return { error: 'invalid' };
	}
	if (!ALLOWED_TYPES.has(mime)) return { error: 'invalid' };
	const bytes = bytesFromBase64(b64);
	if (!bytes || !bytes.byteLength) return { error: 'invalid' };
	if (bytes.byteLength > THUMB_ACCEPT_MAX_BYTES) return { error: 'too large' };
	if (!magicOk(bytes, mime)) return { error: 'invalid' };
	return { bytes, contentType: mime };
}

/** Drop inline data-URL thumbnails from a public scene record (listing stays light). */
export function publicThumbnailField(record) {
	if (!record) return undefined;
	const t = record.thumbnail;
	if (t && typeof t === 'object' && t.stored === 'separate' && t.url) {
		return { stored: 'separate', url: t.url, ...(t.contentType ? { contentType: t.contentType } : {}), ...(t.size ? { size: t.size } : {}) };
	}
	if (record.id && (record.hasThumbnail || (typeof t === 'string' && t.startsWith('data:image/')))) {
		return thumbStub(record.id);
	}
	return undefined;
}
