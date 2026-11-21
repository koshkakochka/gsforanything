// Unit tests for sceneThumbnail.js and sceneDescription.js (no server).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  parseThumbnailPayload, listThumbFields, thumbStub, THUMB_ACCEPT_MAX_BYTES, publicThumbnailField
} from '../../site-source/sceneThumbnail.js';
import {
  sanitizeDescription, DESCRIPTION_MAX_CHARS, DESCRIPTION_RAW_MAX_CHARS,
  DESCRIPTION_PLACEHOLDER, descriptionPayloadTooLarge, createRateLimiter,
  clientIpFromHeaders
} from '../../site-source/sceneDescription.js';
import {
  sanitizeGenre, genreForList, sceneMatchesGenreFilter, COMMUNITY_GENRES,
  findGenre, formatGenre, UNCATEGORIZED_LABEL, applyGenreToRecord
} from '../../site-source/sceneGenre.js';

const dir = dirname(fileURLToPath(import.meta.url));
const jpeg = readFileSync(join(dir, 'sample.jpg'));
const webp = readFileSync(join(dir, 'sample.webp'));
const toData = (buf, type) => `data:${type};base64,${buf.toString('base64')}`;

let fails = 0, n = 0;
const ok = (name, cond, extra = '') => {
  n++; if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

// --- descriptions ---
ok('empty / whitespace becomes ""', sanitizeDescription('') === '' && sanitizeDescription('  \n\t  ') === '');
ok('null/undefined becomes ""', sanitizeDescription(null) === '' && sanitizeDescription(undefined) === '');
ok('preserves multiline', sanitizeDescription('hello\nworld') === 'hello\nworld');
ok('normalizes CRLF', sanitizeDescription('a\r\nb\rc') === 'a\nb\nc');
ok('strips control chars, keeps text', sanitizeDescription('ok\x00x\x07y') === 'okxy');
ok('caps at max', sanitizeDescription('x'.repeat(DESCRIPTION_MAX_CHARS + 50)).length === DESCRIPTION_MAX_CHARS);
ok('keeps angle brackets as text', sanitizeDescription('<script>alert(1)</script>') === '<script>alert(1)</script>');
ok('keeps unicode', sanitizeDescription('café 🌸') === 'café 🌸');
ok('placeholder wording', DESCRIPTION_PLACEHOLDER === 'No description yet');
ok('raw payload under cap is allowed', descriptionPayloadTooLarge('z'.repeat(DESCRIPTION_MAX_CHARS)) === false);
ok('raw payload over cap is too large', descriptionPayloadTooLarge('z'.repeat(DESCRIPTION_RAW_MAX_CHARS + 1)) === true);
ok('null payload is not too large', descriptionPayloadTooLarge(null) === false);

const lim = createRateLimiter({ windowMs: 60_000, max: 3 });
ok('limiter allows first bursts', lim('a') && lim('a') && lim('a'));
ok('limiter blocks the next in the window', lim('a') === false);
ok('limiter is per-key', lim('b') === true);

ok('CF-Connecting-IP wins', clientIpFromHeaders({ 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' }) === '1.2.3.4');
ok('XFF first hop', clientIpFromHeaders({ 'X-Forwarded-For': ' 8.8.8.8, 1.1.1.1' }) === '8.8.8.8');
ok('headers.get form', clientIpFromHeaders(new Headers({ 'CF-Connecting-IP': '5.5.5.5' })) === '5.5.5.5');
ok('fallback when missing', clientIpFromHeaders({}, 'local') === 'local');

// --- thumbnails ---
const jpgUrl = toData(jpeg, 'image/jpeg');
const webpUrl = toData(webp, 'image/webp');
const pj = parseThumbnailPayload(jpgUrl);
ok('parses JPEG data URL', pj && pj.bytes && pj.contentType === 'image/jpeg' && Buffer.from(pj.bytes).equals(jpeg), pj && pj.error);
const pw = parseThumbnailPayload(webpUrl);
ok('parses WebP data URL', pw && pw.contentType === 'image/webp' && Buffer.from(pw.bytes).equals(webp));
ok('image/jpg alias', parseThumbnailPayload(toData(jpeg, 'image/jpg'))?.contentType === 'image/jpeg');
ok('null input is omit', parseThumbnailPayload(null) === null && parseThumbnailPayload('') === null);
ok('rejects garbage', parseThumbnailPayload('not-an-image')?.error === 'invalid');
ok('rejects HTML spoof', parseThumbnailPayload('data:text/html;base64,PHNjcmlwdD4=')?.error === 'invalid');
ok('rejects truncated JPEG', parseThumbnailPayload('data:image/jpeg;base64,////')?.error === 'invalid');
const big = Buffer.concat([jpeg, Buffer.alloc(THUMB_ACCEPT_MAX_BYTES)]);
ok('rejects oversized', parseThumbnailPayload(toData(big, 'image/jpeg'))?.error === 'too large');
ok('object payload', parseThumbnailPayload({ data: jpeg.toString('base64'), contentType: 'image/jpeg' })?.contentType === 'image/jpeg');

ok('list fields when present', JSON.stringify(listThumbFields('abc', true)) === JSON.stringify({ hasThumbnail: true, thumbUrl: '/api/community-scenes/abc/thumb' }));
ok('list fields when absent', JSON.stringify(listThumbFields('abc', false)) === JSON.stringify({ hasThumbnail: false, thumbUrl: null }));
ok('stub shape', thumbStub('xyz').stored === 'separate' && thumbStub('xyz').url === '/api/community-scenes/xyz/thumb');
ok('public field strips data URLs to stub', publicThumbnailField({ id: 'zz', thumbnail: jpgUrl })?.url === '/api/community-scenes/zz/thumb');
ok('public field keeps stub', publicThumbnailField({ thumbnail: thumbStub('aa') })?.url === '/api/community-scenes/aa/thumb');
ok('public field omits empty', publicThumbnailField({ thumbnail: '' }) === undefined);

// --- genres ---
ok('blank / missing is uncategorized', sanitizeGenre({}).genre === '' && sanitizeGenre({ genre: '', subGenre: '' }).subGenre === '' && !sanitizeGenre(null).error);
ok('accepts Games / Action by label', sanitizeGenre({ genre: 'Games', subGenre: 'Action' }).genre === 'games' && sanitizeGenre({ genre: 'Games', subGenre: 'Action' }).subGenre === 'action');
ok('accepts ids', sanitizeGenre({ genre: 'interactive-experiences', subGenre: 'shader-demos' }).subGenre === 'shader-demos');
ok('unknown genre errors', sanitizeGenre({ genre: 'bogus', subGenre: 'action' }).error === 'Unknown genre');
ok('unknown sub-genre errors', sanitizeGenre({ genre: 'games', subGenre: 'shader-demos' }).error === 'Unknown sub-genre');
ok('genre without sub-genre errors', !!sanitizeGenre({ genre: 'games', subGenre: '' }).error);
ok('corrupt stored values list as uncategorized', genreForList({ genre: 'nope', subGenre: 'x' }).genre === '');
ok('Games and Interactive Experiences both exist', COMMUNITY_GENRES.map((g) => g.id).join() === 'games,interactive-experiences');
ok('Games has expected subs including Other', findGenre('games').subGenres.some((s) => s.id === 'other') && findGenre('games').subGenres.length === 15);
ok('Interactive Experiences has expected subs', findGenre('interactive-experiences').subGenres.length === 11);
ok('format uncategorized', formatGenre({}) === UNCATEGORIZED_LABEL);
ok('format tagged', formatGenre({ genre: 'games', subGenre: 'puzzle' }) === 'Games · Puzzle');
const rec = { name: 'x' };
applyGenreToRecord(rec, { genre: 'games', subGenre: 'racing' });
ok('apply writes ids', rec.genre === 'games' && rec.subGenre === 'racing');
applyGenreToRecord(rec, { genre: '', subGenre: '' });
ok('apply clears uncategorized', rec.genre == null && rec.subGenre == null);
ok('filter all matches everything', sceneMatchesGenreFilter({ genre: 'games', subGenre: 'action' }, { mode: 'all' }) && sceneMatchesGenreFilter({}, { mode: 'all' }));
ok('filter uncategorized', sceneMatchesGenreFilter({}, { mode: 'uncategorized' }) && !sceneMatchesGenreFilter({ genre: 'games', subGenre: 'action' }, { mode: 'uncategorized' }));
ok('filter genre all subs', sceneMatchesGenreFilter({ genre: 'games', subGenre: 'action' }, { mode: 'genre', genre: 'games' }) && !sceneMatchesGenreFilter({ genre: 'interactive-experiences', subGenre: 'educational' }, { mode: 'genre', genre: 'games' }));
ok('filter sub-genre', sceneMatchesGenreFilter({ genre: 'games', subGenre: 'action' }, { mode: 'genre', genre: 'games', subGenre: 'action' }) && !sceneMatchesGenreFilter({ genre: 'games', subGenre: 'puzzle' }, { mode: 'genre', genre: 'games', subGenre: 'action' }));

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
