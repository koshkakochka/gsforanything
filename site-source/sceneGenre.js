// Community scene genres. Shared by the Cloudflare Worker, the Vercel server,
// the Publish to Community modal, and Community tiles. Existing scenes with
// no genre fields are uncategorized (empty strings). Stored values are the
// stable ids below; labels are for display and also accepted as input.

export const UNCATEGORIZED_GENRE = '';
export const UNCATEGORIZED_LABEL = 'Uncategorized';
export const ALL_GENRES_LABEL = 'All';

export const COMMUNITY_GENRES = [
	{
		id: 'games',
		label: 'Games',
		subGenres: [
			{ id: 'action', label: 'Action' },
			{ id: 'adventure', label: 'Adventure' },
			{ id: 'puzzle', label: 'Puzzle' },
			{ id: 'mystery', label: 'Mystery' },
			{ id: 'horror', label: 'Horror' },
			{ id: 'platformer', label: 'Platformer' },
			{ id: 'racing', label: 'Racing' },
			{ id: 'shooter', label: 'Shooter' },
			{ id: 'sports', label: 'Sports' },
			{ id: 'strategy', label: 'Strategy' },
			{ id: 'simulation', label: 'Simulation' },
			{ id: 'rhythm-music', label: 'Rhythm & Music' },
			{ id: 'arcade', label: 'Arcade' },
			{ id: 'party-multiplayer', label: 'Party & Multiplayer' },
			{ id: 'other', label: 'Other' }
		]
	},
	{
		id: 'interactive-experiences',
		label: 'Interactive Experiences',
		subGenres: [
			{ id: 'art-installations', label: 'Art Installations' },
			{ id: 'shader-demos', label: 'Shader Demos' },
			{ id: 'music-visualizers', label: 'Music Visualizers' },
			{ id: 'generative-art', label: 'Generative Art' },
			{ id: 'virtual-tours-spaces', label: 'Virtual Tours & Spaces' },
			{ id: 'storytelling', label: 'Storytelling' },
			{ id: 'educational', label: 'Educational' },
			{ id: 'relaxation-meditation', label: 'Relaxation & Meditation' },
			{ id: 'data-visualization', label: 'Data Visualization' },
			{ id: 'tech-demos', label: 'Tech Demos' },
			{ id: 'other', label: 'Other' }
		]
	}
];

function norm(s) {
	return String(s ?? '').trim();
}

function key(s) {
	return norm(s).toLowerCase();
}

export function findGenre(idOrLabel) {
	const k = key(idOrLabel);
	if (!k) return null;
	return COMMUNITY_GENRES.find((g) => g.id === k || key(g.label) === k) || null;
}

export function findSubGenre(genre, idOrLabel) {
	const g = typeof genre === 'object' && genre ? genre : findGenre(genre);
	if (!g) return null;
	const k = key(idOrLabel);
	if (!k) return null;
	return g.subGenres.find((s) => s.id === k || key(s.label) === k) || null;
}

export function genreLabel(idOrLabel) {
	if (!norm(idOrLabel)) return UNCATEGORIZED_LABEL;
	const g = findGenre(idOrLabel);
	return g ? g.label : UNCATEGORIZED_LABEL;
}

export function subGenreLabel(genre, idOrLabel) {
	const s = findSubGenre(genre, idOrLabel);
	return s ? s.label : '';
}

export function formatGenre(value) {
	const g = genreForList(value);
	if (!g.genre) return UNCATEGORIZED_LABEL;
	const sub = subGenreLabel(g.genre, g.subGenre);
	const top = genreLabel(g.genre);
	return sub ? `${top} · ${sub}` : top;
}

/**
 * Normalize genre + sub-genre for storage.
 * Missing / blank → uncategorized ({ genre: '', subGenre: '' }).
 * Unknown or incomplete (genre without a valid sub-genre) → { error }.
 * @returns {{ genre: string, subGenre: string, error?: string }}
 */
export function sanitizeGenre(input) {
	const raw = input && typeof input === 'object' && !Array.isArray(input)
		? input
		: { genre: input, subGenre: '' };
	const gIn = norm(raw.genre);
	const sIn = norm(raw.subGenre);
	if (!gIn && !sIn) return { genre: UNCATEGORIZED_GENRE, subGenre: UNCATEGORIZED_GENRE };
	const g = findGenre(gIn);
	if (!g) return { genre: UNCATEGORIZED_GENRE, subGenre: UNCATEGORIZED_GENRE, error: 'Unknown genre' };
	const s = findSubGenre(g, sIn);
	if (!s) return { genre: UNCATEGORIZED_GENRE, subGenre: UNCATEGORIZED_GENRE, error: 'Unknown sub-genre' };
	return { genre: g.id, subGenre: s.id };
}

/** List/GET view: corrupt or missing values become uncategorized, never an error. */
export function genreForList(value) {
	const r = sanitizeGenre(value);
	if (r.error) return { genre: UNCATEGORIZED_GENRE, subGenre: UNCATEGORIZED_GENRE };
	return { genre: r.genre, subGenre: r.subGenre };
}

export function genreListFields(value) {
	const g = genreForList(value);
	return { genre: g.genre, subGenre: g.subGenre };
}

/** Write sanitized fields onto a scene record (drops them when uncategorized). */
export function applyGenreToRecord(record, parsed) {
	if (!record) return record;
	const g = parsed && !parsed.error ? parsed : genreForList(parsed);
	if (!g.genre) {
		delete record.genre;
		delete record.subGenre;
	} else {
		record.genre = g.genre;
		record.subGenre = g.subGenre;
	}
	return record;
}

export function sceneMatchesGenreFilter(scene, filter) {
	const g = genreForList(scene);
	const f = filter || { mode: 'all' };
	if (f.mode === 'uncategorized') return !g.genre;
	if (f.mode === 'genre') {
		if (g.genre !== f.genre) return false;
		if (f.subGenre) return g.subGenre === f.subGenre;
		return true;
	}
	return true;
}

function addOption(sel, value, label) {
	const opt = document.createElement('option');
	opt.value = value;
	opt.textContent = label;
	sel.appendChild(opt);
}

/**
 * Shared Genre / Sub-genre picker (two <select>s). Used by the Publish
 * modal and by every Community tile. `onChange` receives the sanitized
 * { genre, subGenre } (or the same object with .error if incomplete).
 * @returns {{ el: HTMLElement, getValue: Function, setValue: Function }}
 */
export function mountGenrePicker(parent, opts = {}) {
	const idPrefix = opts.idPrefix || 'gs-genre';
	const allowUncategorized = opts.allowUncategorized !== false;
	const wrap = document.createElement('div');
	wrap.className = 'gs-genre-picker';

	const genreField = document.createElement('label');
	genreField.className = 'gs-genre-field';
	genreField.setAttribute('for', idPrefix + '-genre');
	const genreLbl = document.createElement('span');
	genreLbl.className = 'gs-genre-label';
	genreLbl.textContent = 'Genre';
	const genreSel = document.createElement('select');
	genreSel.id = idPrefix + '-genre';
	genreSel.className = 'gs-genre-select';
	genreSel.setAttribute('aria-label', 'Genre');
	genreField.append(genreLbl, genreSel);

	const subField = document.createElement('label');
	subField.className = 'gs-genre-field';
	subField.setAttribute('for', idPrefix + '-subgenre');
	const subLbl = document.createElement('span');
	subLbl.className = 'gs-genre-label';
	subLbl.textContent = 'Sub-genre';
	const subSel = document.createElement('select');
	subSel.id = idPrefix + '-subgenre';
	subSel.className = 'gs-genre-select';
	subSel.setAttribute('aria-label', 'Sub-genre');
	subField.append(subLbl, subSel);

	const fillGenres = () => {
		genreSel.innerHTML = '';
		if (allowUncategorized) addOption(genreSel, '', UNCATEGORIZED_LABEL);
		for (const g of COMMUNITY_GENRES) addOption(genreSel, g.id, g.label);
	};

	const fillSubs = (genreId, keepSub) => {
		subSel.innerHTML = '';
		const g = findGenre(genreId);
		if (!g) {
			addOption(subSel, '', UNCATEGORIZED_LABEL);
			subSel.value = '';
			subSel.disabled = true;
			return;
		}
		subSel.disabled = false;
		addOption(subSel, '', 'Select sub-genre');
		for (const s of g.subGenres) addOption(subSel, s.id, s.label);
		if (keepSub && findSubGenre(g, keepSub)) subSel.value = findSubGenre(g, keepSub).id;
		else subSel.value = '';
	};

	fillGenres();
	const initial = genreForList(opts.value);
	genreSel.value = initial.genre;
	fillSubs(initial.genre, initial.subGenre);

	const emit = () => {
		const v = sanitizeGenre({ genre: genreSel.value, subGenre: subSel.value });
		if (typeof opts.onChange === 'function') opts.onChange(v);
	};
	genreSel.addEventListener('change', () => {
		fillSubs(genreSel.value, '');
		emit();
	});
	subSel.addEventListener('change', emit);

	wrap.append(genreField, subField);
	if (parent) parent.appendChild(wrap);
	return {
		el: wrap,
		getValue: () => sanitizeGenre({ genre: genreSel.value, subGenre: subSel.value }),
		setValue: (value) => {
			const v = genreForList(value);
			genreSel.value = v.genre;
			fillSubs(v.genre, v.subGenre);
		}
	};
}
