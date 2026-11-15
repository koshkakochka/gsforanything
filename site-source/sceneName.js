// Community / saved scene names. Shared by the Cloudflare Worker, the Vercel
// server, and the editor. Empty or whitespace-only values fall back to a
// default; control characters are stripped; length is capped so list tiles
// and blob pathnames stay short. Older scenes that were stored without a
// name still read as the default ('Untitled') through this same helper.

export const SCENE_NAME_MAX = 80;
export const DEFAULT_SCENE_NAME = 'Untitled';
/** Name used when Upload Current Scene is submitted with the field left empty. */
export const DEFAULT_UPLOAD_NAME = 'My Scene';

/**
 * Normalize a scene name for storage and display.
 * @param {*} name
 * @param {string} [fallback=DEFAULT_SCENE_NAME]
 */
export function sanitizeSceneName(name, fallback = DEFAULT_SCENE_NAME) {
	const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return (cleaned || fallback).slice(0, SCENE_NAME_MAX);
}
