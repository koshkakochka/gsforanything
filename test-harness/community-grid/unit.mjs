// Unit tests for sceneThumbnail.js and sceneDescription.js (no server).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  parseThumbnailPayload, listThumbFields, thumbStub, THUMB_ACCEPT_MAX_BYTES, publicThumbnailField
} from '../../site-source/sceneThumbnail.js';
import { sanitizeDescription, DESCRIPTION_MAX_CHARS } from '../../site-source/sceneDescription.js';

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

console.log(`\n${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
