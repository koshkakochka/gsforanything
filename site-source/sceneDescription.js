// Community scene descriptions: a short plain-text blurb on each Community
// tile. Anyone can edit a description, the same way anyone can rename a
// scene (GS has no accounts). Export settings stay creator-only (owner key).
// Shared by the Cloudflare Worker and the Vercel server. Rendered with
// textContent / textarea.value so stored characters (including "<") never
// become HTML.

export const DESCRIPTION_MAX_CHARS = 2000;
export const DESCRIPTION_RAW_MAX_CHARS = 8192;
export const DESCRIPTION_PLACEHOLDER = 'No description yet';
export const DESCRIPTION_PATCH_WINDOW_MS = 60_000;
export const DESCRIPTION_PATCH_MAX_PER_WINDOW = 30;

/**
 * Normalize a description for storage. Preserves line breaks, strips
 * control characters, caps length. An empty or whitespace-only value
 * becomes '' (the tile shows a placeholder, nothing is stored).
 */
export function sanitizeDescription(input) {
	if (input == null) return '';
	let s = String(input);
	s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
	if (s.length > DESCRIPTION_MAX_CHARS) s = s.slice(0, DESCRIPTION_MAX_CHARS);
	if (!s.trim()) return '';
	return s;
}

export function descriptionForList(value) {
	return typeof value === 'string' ? value : '';
}

/** Reject a PATCH before sanitizing if the raw string is unreasonably large. */
export function descriptionPayloadTooLarge(input) {
	if (input == null) return false;
	return String(input).length > DESCRIPTION_RAW_MAX_CHARS;
}

/**
 * In-memory sliding-window limiter. Not shared across Worker isolates, but
 * it still blocks a burst in one isolate. `check(key)` returns true if the
 * request is allowed.
 */
export function createRateLimiter({ windowMs = DESCRIPTION_PATCH_WINDOW_MS, max = DESCRIPTION_PATCH_MAX_PER_WINDOW } = {}) {
	const hits = new Map();
	return (key) => {
		const now = Date.now();
		const k = String(key || 'unknown');
		let arr = hits.get(k) || [];
		arr = arr.filter((t) => now - t < windowMs);
		if (arr.length >= max) {
			hits.set(k, arr);
			return false;
		}
		arr.push(now);
		hits.set(k, arr);
		if (hits.size > 2000) {
			for (const [id, ts] of hits) {
				const kept = ts.filter((t) => now - t < windowMs);
				if (!kept.length) hits.delete(id);
				else hits.set(id, kept);
			}
		}
		return true;
	};
}

export function clientIpFromHeaders(headers, fallback = 'unknown') {
	if (!headers) return fallback;
	const get = typeof headers.get === 'function'
		? (name) => headers.get(name)
		: (name) => headers[name] || headers[name.toLowerCase()];
	const cf = get('CF-Connecting-IP') || get('cf-connecting-ip');
	if (cf && String(cf).trim()) return String(cf).trim();
	const xff = get('X-Forwarded-For') || get('x-forwarded-for');
	if (xff) {
		const first = String(xff).split(',')[0].trim();
		if (first) return first;
	}
	return fallback;
}
