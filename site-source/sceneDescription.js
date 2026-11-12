// Community scene descriptions: a short plain-text blurb on each Community
// tile, edited by the scene's creator (owner key). Shared by the Cloudflare
// Worker and the Vercel server. Rendered with textContent / textarea.value
// so stored characters (including "<") never become HTML.

export const DESCRIPTION_MAX_CHARS = 2000;

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
