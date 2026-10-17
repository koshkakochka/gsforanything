/**
 * GS build version — single source of truth.
 * Bump GS_VERSION here before every deploy (always ask the user for the number).
 * See DEPLOY.md.
 */

export const GS_VERSION = '0.972';

/** @typedef {{ id: string, label?: string, url?: string|null, date?: string, changes?: string[] }} GsVersionEntry */

/**
 * Built-in fallback when /versions.json is missing or empty.
 * `url: null` means "this build" (stay on the current page).
 * @returns {GsVersionEntry[]}
 */
export function getBuiltinVersions() {
	return [
		{
			id: GS_VERSION,
			label: `GS ${GS_VERSION} (this build)`,
			url: null
		}
	];
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ versions?: GsVersionEntry[] }|null>}
 */
export async function loadVersionManifest(fetchImpl = fetch) {
	try {
		const res = await fetchImpl('./versions.json', { cache: 'no-store' });
		if (!res.ok) return null;
		const data = await res.json();
		if (!data || typeof data !== 'object') return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * Merge manifest entries with the current build so the picker always lists
 * at least this version (selected).
 * @param {{ versions?: GsVersionEntry[] }|null|undefined} manifest
 * @param {string} [currentId]
 * @returns {GsVersionEntry[]}
 */
export function mergeVersionList(manifest, currentId = GS_VERSION) {
	const fromManifest = Array.isArray(manifest?.versions) ? manifest.versions : [];
	const cleaned = [];
	const seen = new Set();
	for (const raw of fromManifest) {
		if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) continue;
		const id = raw.id.trim();
		if (seen.has(id)) continue;
		seen.add(id);
		cleaned.push({
			id,
			label: (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : `GS ${id}`,
			url: raw.url == null || raw.url === '' ? null : String(raw.url),
			date: typeof raw.date === 'string' ? raw.date.trim() : '',
			// Changelog lines for this version (shown under it in the picker).
			changes: Array.isArray(raw.changes)
				? raw.changes.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim())
				: []
		});
	}
	if (!seen.has(currentId)) {
		cleaned.unshift(...getBuiltinVersions());
	} else {
		// Ensure the current build row can mean "stay here" when url omitted.
		const cur = cleaned.find(v => v.id === currentId);
		if (cur && (cur.url == null || cur.url === '')) cur.url = null;
		if (cur && (!cur.label || cur.label === `GS ${currentId}`)) {
			cur.label = `GS ${currentId} (this build)`;
		}
	}
	return cleaned;
}

/**
 * Resolve whether an entry is the build currently running.
 * @param {GsVersionEntry} entry
 * @param {string} [currentId]
 * @param {string} [pageHref]
 */
export function isCurrentVersionEntry(entry, currentId = GS_VERSION, pageHref = (typeof location !== 'undefined' ? location.href : '')) {
	if (!entry) return false;
	if (entry.id === currentId && (entry.url == null || entry.url === '')) return true;
	if (!entry.url) return entry.id === currentId;
	try {
		const target = new URL(entry.url, pageHref);
		const here = new URL(pageHref);
		return target.origin === here.origin && target.pathname.replace(/\/$/, '') === here.pathname.replace(/\/$/, '');
	} catch {
		return entry.id === currentId;
	}
}
