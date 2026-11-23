// makefun-site-fast: a faster drop-in for makefun-site 1.0.0's build. run(input) returns the same output tree,
// path -> text, byte for byte. Same rules (front matter, Markdown subset, template dialect, slugs, report); the speed
// comes from scanning by char code instead of per-character regex and escape calls, memoised text helpers, templates
// compiled to closures, and template fragments memoised on the values they read (a tag cloud or a post's card is
// rendered once per build instead of once per page). No dependencies.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Byte mode. main.ts reads the input file as Latin-1, so every string holds the file's UTF-8 bytes one per char
 * (never decoded), and writes the answers back as Latin-1, so the bytes go out as they came. Every rule of the build
 * reads ASCII characters, and UTF-8 never uses an ASCII byte inside a multi-byte character, so the build is the same
 * on bytes; the few rules that read Unicode (slugs, \s and trim's whitespace, the line terminators a regex `.` stops
 * at, code-unit order) are handled for bytes where they occur. BYTES says which form the current build reads.
 */
let BYTES = false;

/** A byte-form string as the Unicode text it encodes. */
const decodeU = (s) => Buffer.from(s, 'latin1').toString('utf8');

/** Characters at or above U+00EE: in byte form, the lead bytes of U+E000 and up, where UTF-8 byte order and UTF-16
 * code-unit order part ways (a supplementary character sorts before U+E000-U+FFFF in code units). */
const HIGH = /[\u00ee-\uffff]/;

/** Code-unit order of the texts the strings hold: in byte form, byte order is code-point order, the same order unless
 * a string holds U+E000 or above; then the texts are decoded and compared. */
function sortU(xs, key) {
  if (BYTES && xs.some((x) => HIGH.test(key(x)))) {
    const dec = new Map(xs.map((x) => [x, decodeU(key(x))]));
    return xs.sort((x, y) => byCodeUnits(dec.get(x), dec.get(y)));
  }
  return xs.sort((x, y) => byCodeUnits(key(x), key(y)));
}
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

// ------------------------------------------------------------------ text

/** & < > " ' escaped; returns the input itself when nothing needs escaping. Native regex work, fast even when cold. */
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escOne = (c) => ESC_MAP[c];
function esc(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_ALL, escOne) : s;
}

/** Escape of one character code (for the inline renderer's escaped characters). */
function escCode(c) {
  if (c === 38) return '&amp;';
  if (c === 60) return '&lt;';
  if (c === 62) return '&gt;';
  if (c === 34) return '&quot;';
  if (c === 39) return '&#39;';
  return String.fromCharCode(c);
}

/**
 * JSON string escape, without the quotes: what JSON.stringify writes between them (" \ control characters and lone
 * surrogates escaped); the input itself when it needs none.
 */
const JSON_TEST = /["\\\u0000-\u001f\ud800-\udfff]/;
function jesc(s) {
  return JSON_TEST.test(s) ? JSON.stringify(s).slice(1, -1) : s;
}

/** HTML escape then JSON escape (after the HTML escape no " is left for JSON to escape). */
const JSON_TEST_NQ = /[\\\u0000-\u001f\ud800-\udfff]/;
function escJ(s) {
  if (ESC_TEST.test(s)) s = s.replace(ESC_ALL, escOne);
  return JSON_TEST_NQ.test(s) ? JSON.stringify(s).slice(1, -1) : s;
}

const MARK = /\p{M}/gu;
const slugMemo = new Map();
const slugMemoB = new Map(); // byte-form keys apart: one string can be a different text in each form

function slugCore(plain) {
  let out = '';
  let gap = false;
  const n = plain.length;
  for (let i = 0; i < n; i++) {
    let c = plain.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    else if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57))) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(c);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

/** The slug of `text` (NFKD, marks dropped, a-z0-9 runs joined by "-", at most 64, "untitled" when empty). */
function slugify(text) {
  const memo = BYTES ? slugMemoB : slugMemo;
  let s = memo.get(text);
  if (s !== undefined) return s;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  // Non-ASCII code points are never kept, so walking code units gives the same gaps as walking code points.
  s = slugCore(ascii ? text : (BYTES ? decodeU(text) : text).normalize('NFKD').replace(MARK, ''));
  memo.set(text, s);
  return s;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateMemo = new Map();
function longDate(date) {
  let s = dateMemo.get(date);
  if (s === undefined) {
    const [y, m, d] = date.split('-');
    s = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateMemo.set(date, s);
  }
  return s;
}

/** Whether char code `c` is whitespace as JavaScript's \s reads it. */
function isWs(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 160) return false;
  return c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * The length of the \s whitespace character at `i` in `s`, or 0. In byte form the non-ASCII ones are UTF-8
 * sequences: C2 A0, E1 9A 80, E2 80 80-8A, E2 80 A8, E2 80 A9, E2 80 AF, E2 81 9F, E3 80 80 and EF BB BF (each opens
 * on a lead byte, so a match is always a whole character).
 */
function wsLen(s, i) {
  const c = s.charCodeAt(i);
  if (c < 128) return c === 32 || (c >= 9 && c <= 13) ? 1 : 0;
  if (!BYTES) return isWs(c) ? 1 : 0;
  if (i + 1 >= s.length) return 0;
  const d = s.charCodeAt(i + 1);
  if (c === 0xc2) return d === 0xa0 ? 2 : 0;
  if (i + 2 >= s.length) return 0;
  const f = s.charCodeAt(i + 2);
  if (c === 0xe2) {
    if (d === 0x80) return (f >= 0x80 && f <= 0x8a) || f === 0xa8 || f === 0xa9 || f === 0xaf ? 3 : 0;
    return d === 0x81 && f === 0x9f ? 3 : 0;
  }
  if (c === 0xe1) return d === 0x9a && f === 0x80 ? 3 : 0;
  if (c === 0xe3) return d === 0x80 && f === 0x80 ? 3 : 0;
  if (c === 0xef) return d === 0xbb && f === 0xbf ? 3 : 0;
  return 0;
}

/** How many runs of non-whitespace `text` holds (as /\S+/g counts them). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; ) {
    const c = text.charCodeAt(i);
    const w = c > 32 && c < 128 ? 0 : wsLen(text, i);
    if (w === 0) {
      if (!inWord) {
        inWord = true;
        n++;
      }
      i++;
    } else {
      inWord = false;
      i += w;
    }
  }
  return n;
}

/** Whether `s` holds any \s whitespace. */
function hasWsU(s) {
  for (let i = 0; i < s.length; i++) if (wsLen(s, i) !== 0) return true;
  return false;
}

/** String.prototype.trim (its whitespace is \s's), in either form. */
function trimU(s) {
  if (!BYTES) return s.trim();
  let a = 0;
  let b = s.length;
  for (let w; a < b && (w = wsLen(s, a)) !== 0; ) a += w;
  while (b > a) {
    if (wsLen(s, b - 1) === 1) b--;
    else if (b - 2 >= a && wsLen(s, b - 2) === 2) b -= 2;
    else if (b - 3 >= a && wsLen(s, b - 3) === 3) b -= 3;
    else break;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/** Whether `s` holds U+2028 or U+2029, the line terminators beside \n and \r that a regex `.` does not match. */
const hasLT = (s) => (BYTES ? s.includes('\u00e2\u0080\u00a8') || s.includes('\u00e2\u0080\u00a9') : s.includes('\u2028') || s.includes('\u2029'));

/** Whether `s` is only spaces and tabs. */
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------------------ front matter

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    const end = raw.length - 1;
    for (let i = 1; i < end; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (trimU(inner) === '') return { value: [] };
      const tags = inner.split(',').map(trimU);
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Trailing spaces and tabs dropped. */
function trimEndST(s) {
  let b = s.length;
  while (b > 0) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return b === s.length ? s : s.slice(0, b);
}

/** { data, body } or { error }; `text` has "\n" line ends. */
function parseFrontMatter(text) {
  // lines[0] must be exactly "---"
  if (!(text.startsWith('---') && (text.length === 3 || text.charCodeAt(3) === 10))) return { error: 'no front matter' };
  // header lines: from index 4 up to the next line that is exactly "---"
  const header = [];
  let pos = 4;
  let bodyStart = -1;
  if (text.length > 3) {
    while (true) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? text.length : nl;
      if (lineEnd - pos === 3 && text.startsWith('---', pos)) {
        bodyStart = nl === -1 ? text.length : nl + 1;
        break;
      }
      header.push(text.slice(pos, lineEnd));
      if (nl === -1) break;
      pos = nl + 1;
    }
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < header.length; k++) {
    const line = header[k];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = BYTES && hasLT(line) ? null : FM_LINE.exec(line); // in byte form `.` would match a line terminator's bytes
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = trimEndST(m[2] ?? '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // body: the lines after the closing "---", joined by "\n" (a close on the last line leaves "")
  return { data, body: bodyStart >= text.length ? '' : text.slice(bodyStart) };
}

// ------------------------------------------------------------------ markdown

/** Escapable characters after a backslash: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (c) => c < 128 && ESCAPABLE[c] === 1;

/**
 * Whether the body being rendered holds U+2028 or U+2029, the line terminators a regex `.` stops at beside \n (a
 * source's \r is made \n before this), so the per-line checks for them run only on a body that has one.
 */
let bodyHasLT = false;

/** First index in [from, end) of `what` (1 or 2 chars) outside a backslash escape, or -1. */
function findUnescaped(s, what2, ch, from, end) {
  const lim = end - (what2 ? 2 : 1);
  for (let j = from; j <= lim; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end && isEscapable(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c === ch && (!what2 || s.charCodeAt(j + 1) === ch)) return j;
  }
  return -1;
}

/** First single "*" in [from, end) outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < end && isEscapable(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that open inline markup: \ ` * [ */
const OPENER = /[\\`*[]/g;

/** A link target back from its escaped form (the five entities esc writes). */
function unesc(t) {
  if (!t.includes('&')) return t;
  return t.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

/**
 * e[start, end) rendered inline, where `e` is the block's text already HTML-escaped (esc). Escaping maps each
 * character on its own and its entities hold none of \ ` * [ ] ( ), so the markup is found at the same places and
 * every plain run, code span and link label comes out escaped already. Two places differ: "\>" ('>' is escapable)
 * reads "\&gt;" here, and a link's target is resolved from its raw text.
 */
function inline(e, start, end, env) {
  let out = '';
  let i = start;
  while (i < end) {
    OPENER.lastIndex = i;
    let j = OPENER.test(e) ? OPENER.lastIndex - 1 : end;
    if (j >= end) {
      out += i === 0 && end === e.length ? e : e.slice(i, end);
      break;
    }
    if (j > i) out += e.slice(i, j);
    i = j;
    const c = e.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < end) {
        const n = e.charCodeAt(i + 1);
        if (isEscapable(n)) {
          out += e[i + 1];
          i += 2;
          continue;
        }
        if (n === 38 && e.startsWith('&gt;', i + 1)) {
          out += '&gt;';
          i += 5;
          continue;
        }
      }
      out += '\\';
      i++;
      continue;
    }
    if (c === 96) {
      const k = e.indexOf('`', i + 1);
      if (k !== -1 && k < end && k > i + 1) {
        out += `<code>${e.slice(i + 1, k)}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < end && e.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(e, true, 42, i + 2, end);
        if (k > i + 2) {
          out += `<strong>${inline(e, i + 2, k, env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(e, i + 1, end);
      if (k > i + 1) {
        out += `<em>${inline(e, i + 1, k, env)}</em>`;
        i = k + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(e, false, 93, i + 1, end);
    if (k !== -1 && k + 1 < end && e.charCodeAt(k + 1) === 40) {
      const m = e.indexOf(')', k + 2);
      if (m !== -1 && m < end) {
        const target = unesc(e.slice(k + 2, m));
        if (target !== '' && !hasWsU(target)) {
          const href = esc(env.link(target));
          out += `<a href="${href}">${inline(e, i + 1, k, env)}</a>`;
          i = m + 1;
          continue;
        }
      }
    }
    out += '[';
    i++;
  }
  return out;
}


/** Already-escaped text `e` rendered inline. */
const inlineE = (e, env) => inline(e, 0, e.length, env);

/** esc for a whole body: one native pass per character that occurs, better than a callback per match on long text. */
function escBig(s) {
  if (!ESC_TEST.test(s)) return s;
  if (s.includes('&')) s = s.replaceAll('&', '&amp;');
  if (s.includes('<')) s = s.replaceAll('<', '&lt;');
  if (s.includes('>')) s = s.replaceAll('>', '&gt;');
  if (s.includes('"')) s = s.replaceAll('"', '&quot;');
  if (s.includes("'")) s = s.replaceAll("'", '&#39;');
  return s;
}

// The block lexer works on the escaped body `e` by positions: line k is e[LS[k], LE[k]). No line strings are made;
// a block whose text needs no trimming goes to the inline renderer as a range of `e`.

let LS = new Int32Array(4096);
let LE = new Int32Array(4096);

/** Fill LS/LE with the lines of `e` as split('\n') gives them (a trailing "\n" leaves an empty last line). */
function splitLines(e) {
  const n = e.length;
  let k = 0;
  let a = 0;
  while (true) {
    if (k === LS.length) {
      const ls = new Int32Array(k * 2);
      ls.set(LS);
      LS = ls;
      const le = new Int32Array(k * 2);
      le.set(LE);
      LE = le;
    }
    let b = e.indexOf('\n', a);
    if (b === -1) b = n;
    LS[k] = a;
    LE[k] = b;
    k++;
    if (b === n) return k;
    a = b + 1;
  }
}

const isSpTab = (c) => c === 32 || c === 9;

function blankR(e, a, b) {
  for (let i = a; i < b; i++) if (!isSpTab(e.charCodeAt(i))) return false;
  return true;
}

/** Whether e[a, b) holds U+2028 or U+2029 (only looked for when the body has one). */
function ltR(e, a, b) {
  if (BYTES) {
    for (let i = a; i + 2 < b; i++) {
      if (e.charCodeAt(i) === 0xe2 && e.charCodeAt(i + 1) === 0x80) {
        const f = e.charCodeAt(i + 2);
        if (f === 0xa8 || f === 0xa9) return true;
      }
    }
    return false;
  }
  for (let i = a; i < b; i++) {
    const c = e.charCodeAt(i);
    if (c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

const isLangChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence opener's language (/^```([A-Za-z0-9_+-]*)[ \t]*$/), or null. */
function fenceOpenR(e, a, b) {
  if (b - a < 3 || e.charCodeAt(a) !== 96 || e.charCodeAt(a + 1) !== 96 || e.charCodeAt(a + 2) !== 96) return null;
  let k = a + 3;
  while (k < b && isLangChar(e.charCodeAt(k))) k++;
  const langEnd = k;
  while (k < b && isSpTab(e.charCodeAt(k))) k++;
  return k === b ? e.slice(a + 3, langEnd) : null;
}

function fenceCloseR(e, a, b) {
  if (b - a < 3 || e.charCodeAt(a) !== 96 || e.charCodeAt(a + 1) !== 96 || e.charCodeAt(a + 2) !== 96) return false;
  return blankR(e, a + 3, b);
}

/** /^(?:---|\*\*\*)[ \t]*$/ */
function hrR(e, a, b) {
  if (b - a < 3) return false;
  const c = e.charCodeAt(a);
  if ((c !== 45 && c !== 42) || e.charCodeAt(a + 1) !== c || e.charCodeAt(a + 2) !== c) return false;
  return blankR(e, a + 3, b);
}

// A heading's parts, set by headingR: its depth and its text e[HA, HB).
let HA = 0;
let HB = 0;

/** The depth of an ATX heading (/^(#{1,6})[ \t]+(.*?)[ \t]*$/ with a non-empty text), or 0; sets HA/HB. */
function headingR(e, a, b) {
  if (b - a < 2 || e.charCodeAt(a) !== 35) return 0;
  let d = a + 1;
  while (d < b && e.charCodeAt(d) === 35) d++;
  const depth = d - a;
  if (depth > 6 || d >= b || !isSpTab(e.charCodeAt(d))) return 0;
  // `.` and [ \t] match no line terminator and `$` only the end, so one anywhere after the hashes fails the match.
  if (bodyHasLT && ltR(e, d, b)) return 0;
  let x = d + 1;
  while (x < b && isSpTab(e.charCodeAt(x))) x++;
  let y = b;
  while (y > x && isSpTab(e.charCodeAt(y - 1))) y--;
  if (x === y) return 0;
  HA = x;
  HB = y;
  return depth;
}

/** Whether escaped line e[a, b) opens on ">" (written "&gt;"; a raw "&gt;" reads "&amp;gt;", so this is never it). */
const quoteR = (e, a, b) => b - a >= 4 && e.charCodeAt(a) === 38 && e.startsWith('&gt;', a);

/** Where the text of a bullet item starts (/^[-*] (.*)$/), or -1. */
function bulletR(e, a, b) {
  if (b - a < 2) return -1;
  const c = e.charCodeAt(a);
  if ((c !== 45 && c !== 42) || e.charCodeAt(a + 1) !== 32) return -1;
  if (bodyHasLT && ltR(e, a + 2, b)) return -1;
  return a + 2;
}

/** Where the text of an ordered item starts (/^(\d{1,9})\. (.*)$/), or -1; its number's digits end at OD. */
let OD = 0;
function orderedR(e, a, b) {
  let i = a;
  while (i < b && i - a < 10) {
    const c = e.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  const nd = i - a;
  if (nd === 0 || nd > 9 || i + 2 > b) return -1;
  if (e.charCodeAt(i) !== 46 || e.charCodeAt(i + 1) !== 32) return -1;
  if (bodyHasLT && ltR(e, i + 2, b)) return -1;
  OD = i;
  return i + 2;
}

/** /^ {2,}\S/ */
function continuedR(e, a, b) {
  if (b - a < 3 || e.charCodeAt(a) !== 32 || e.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && e.charCodeAt(i) === 32) i++;
  return i < b && wsLen(e, i) === 0;
}

function endsParagraphR(e, a, b) {
  return blankR(e, a, b) || fenceOpenR(e, a, b) !== null || headingR(e, a, b) !== 0 || hrR(e, a, b);
}

// A trimmed range, set by trimR.
let TA = 0;
let TB = 0;
function trimR(e, a, b) {
  while (a < b && isSpTab(e.charCodeAt(a))) a++;
  while (b > a && isSpTab(e.charCodeAt(b - 1))) b--;
  TA = a;
  TB = b;
}

/**
 * The body rendered: { html, toc, excerpt }. The body is HTML-escaped once, whole, and lexed by positions: the
 * escape changes no character the block rules read but ">", which reads "&gt;" (quoteR), so the blocks are the same;
 * a heading's id is slugged from its text unescaped.
 */
function renderMarkdown(src, env) {
  bodyHasLT = hasLT(src);
  const e = escBig(src);
  const n = splitLines(e);
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  let i = 0;
  while (i < n) {
    const a = LS[i];
    const b = LE[i];
    if (blankR(e, a, b)) {
      i++;
      continue;
    }
    const lang = fenceOpenR(e, a, b);
    if (lang !== null) {
      i++;
      const first = i;
      while (i < n && !fenceCloseR(e, LS[i], LE[i])) i++;
      const body = i > first ? `${e.slice(LS[first], LE[i - 1])}\n` : '';
      i++;
      html += lang === '' ? `<pre><code>${body}</code></pre>\n` : `<pre><code class="language-${lang}">${body}</code></pre>\n`;
      continue;
    }
    const depth = headingR(e, a, b);
    if (depth !== 0) {
      const text = e.slice(HA, HB);
      const id = uniqueSlug(slugify(unesc(text)), ids);
      const h = inline(text, 0, text.length, env);
      html += `<h${depth} id="${id}">${h}</h${depth}>\n`;
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: h });
      i++;
      continue;
    }
    if (hrR(e, a, b)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (quoteR(e, a, b)) {
      let text = '';
      let any = false;
      while (i < n && quoteR(e, LS[i], LE[i])) {
        const qa = LS[i] + (e.charCodeAt(LS[i] + 4) === 32 && LS[i] + 4 < LE[i] ? 5 : 4);
        trimR(e, qa, LE[i]);
        i++;
        if (TA === TB) continue;
        text = any ? `${text}\n${e.slice(TA, TB)}` : e.slice(TA, TB);
        any = true;
      }
      html += any ? `<blockquote>\n<p>${inline(text, 0, text.length, env)}</p>\n</blockquote>\n` : '<blockquote>\n</blockquote>\n';
      continue;
    }
    let ta = bulletR(e, a, b);
    const ordered = ta === -1;
    if (ordered) ta = orderedR(e, a, b);
    if (ta !== -1) {
      const start = ordered ? Number(e.slice(a, OD)) : 1;
      html += ordered ? (start !== 1 ? `<ol start="${start}">\n` : '<ol>\n') : '<ul>\n';
      // items: each a range when one line, else its trimmed lines joined by "\n"
      let ia = -1;
      let ib = -1;
      let multi = null;
      while (i < n) {
        const la = LS[i];
        const lb = LE[i];
        const m = ordered ? orderedR(e, la, lb) : bulletR(e, la, lb);
        if (m !== -1) {
          if (ia !== -1) html += `<li>${multi === null ? inline(e, ia, ib, env) : inline(multi, 0, multi.length, env)}</li>\n`;
          trimR(e, m, lb);
          ia = TA;
          ib = TB;
          multi = null;
          i++;
        } else if (continuedR(e, la, lb)) {
          trimR(e, la, lb);
          multi = `${multi === null ? e.slice(ia, ib) : multi}\n${e.slice(TA, TB)}`;
          i++;
        } else break;
      }
      html += `<li>${multi === null ? inline(e, ia, ib, env) : inline(multi, 0, multi.length, env)}</li>\n`;
      html += ordered ? '</ol>\n' : '</ul>\n';
      continue;
    }
    // a paragraph: its lines trimmed and joined by "\n"; a range of e while no line needs trimming
    trimR(e, a, b);
    let pa = TA;
    let pb = TB;
    let text = null;
    i++;
    while (i < n && !endsParagraphR(e, LS[i], LE[i])) {
      const la = LS[i];
      const lb = LE[i];
      trimR(e, la, lb);
      if (text === null && pb === la - 1 && TA === la && TB === lb) pb = lb;
      else text = `${text === null ? e.slice(pa, pb) : text}\n${e.slice(TA, TB)}`;
      i++;
    }
    const h = text === null ? inline(e, pa, pb, env) : inline(text, 0, text.length, env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;

/**
 * A tag regex's match. In byte form \S reads the char A0 as no-break space, which it is only after C2: a tag holding
 * an A0 is matched on its decoded text, its groups encoded back.
 */
function execTag(re, tag) {
  if (!BYTES || !tag.includes('\u00a0')) return re.exec(tag);
  const m = re.exec(decodeU(tag));
  return m === null ? null : m.map((g) => (g === undefined ? g : Buffer.from(g, 'utf8').toString('latin1')));
}
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

const WS_ONLY = /^[ \t]*$/;

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, trimU(src.slice(open + (raw ? 3 : 2), close))) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = WS_ONLY.test(src.slice(lineStart, open)) && WS_ONLY.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: trimU(src.slice(open + 2, close)) });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A template's tree of nodes, or a TemplateError. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = execTag(T_FOR, tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = execTag(T_IF, tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Rendering: scopes are { vars, parent }; a path's first name comes from the nearest scope that holds it.

const MISSING = Symbol('missing');

function rootOf(scope, name) {
  let s = scope;
  while (s !== null) {
    if (Object.hasOwn(s.vars, name)) return s.vars[name];
    s = s.parent;
  }
  return MISSING;
}

function navigate(v, path) {
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function lookup(scope, path) {
  const v = rootOf(scope, path[0]);
  return v === MISSING ? undefined : path.length === 1 ? v : navigate(v, path);
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The compiled templates of one build. Each node becomes a closure (scope, depth) -> string. `for` and `include`
 * nodes are memoised on the values of the free names they read (their "roots") and the include depth: the output of a
 * node is a function of those alone, since every value a template reads is fixed for the whole build.
 */
class Compiled {
  constructor(trees) {
    this.trees = trees; // name -> nodes
    this.fns = new Map(); // name -> compiled body
    this.rootsMemo = new Map(); // name -> Set of roots
    this.computeRoots();
    for (const [name, nodes] of trees) this.fns.set(name, this.compileSeq(nodes));
  }

  /** Every template's free names, to a fixpoint (includes may recurse). */
  computeRoots() {
    for (const name of this.trees.keys()) this.rootsMemo.set(name, new Set());
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, nodes] of this.trees) {
        const set = this.rootsMemo.get(name);
        const before = set.size;
        for (const r of this.seqRoots(nodes)) set.add(r);
        if (set.size !== before) changed = true;
      }
    }
  }

  seqRoots(nodes) {
    const out = new Set();
    for (const n of nodes) for (const r of this.nodeRoots(n)) out.add(r);
    return out;
  }

  nodeRoots(n) {
    switch (n.kind) {
      case 'text':
        return [];
      case 'var':
      case 'raw':
        return [n.path[0]];
      case 'if': {
        const s = this.seqRoots(n.then);
        if (n.else !== null) for (const r of this.seqRoots(n.else)) s.add(r);
        s.add(n.path[0]);
        return s;
      }
      case 'for': {
        const s = this.seqRoots(n.body);
        s.delete(n.name);
        s.delete('loop');
        s.add(n.path[0]);
        return s;
      }
      case 'include': {
        const t = this.rootsMemo.get(n.name);
        return t === undefined ? [] : t;
      }
    }
    return [];
  }

  compileSeq(nodes) {
    const fns = [];
    let text = '';
    for (const n of nodes) {
      if (n.kind === 'text') {
        text += n.text;
        continue;
      }
      if (text !== '') {
        const t = jesc(text);
        fns.push(() => t);
        text = '';
      }
      fns.push(this.compileNode(n));
    }
    if (text !== '') {
      const t = jesc(text);
      fns.push(() => t);
    }
    if (fns.length === 0) return () => '';
    if (fns.length === 1) return fns[0];
    if (fns.length === 2) {
      const [a, b] = fns;
      return (sc, d) => a(sc, d) + b(sc, d);
    }
    if (fns.length === 3) {
      const [a, b, c] = fns;
      return (sc, d) => a(sc, d) + b(sc, d) + c(sc, d);
    }
    const len = fns.length;
    return (sc, d) => {
      let out = '';
      for (let k = 0; k < len; k++) out += fns[k](sc, d);
      return out;
    };
  }

  compileNode(n) {
    switch (n.kind) {
      case 'var': {
        const p = n.path;
        return (sc) => escJ(textOf(lookup(sc, p)));
      }
      case 'raw': {
        const p = n.path;
        return (sc) => jesc(textOf(lookup(sc, p)));
      }
      case 'if': {
        const p = n.path;
        const not = n.not;
        const thenF = this.compileSeq(n.then);
        const elseF = n.else === null ? null : this.compileSeq(n.else);
        return (sc, d) => {
          if (truthy(lookup(sc, p)) !== not) return thenF(sc, d);
          return elseF === null ? '' : elseF(sc, d);
        };
      }
      case 'for': {
        const p = n.path;
        const name = n.name;
        const bodyF = this.compileSeq(n.body);
        const f = (sc, d) => {
          const xs = lookup(sc, p);
          if (!Array.isArray(xs)) return '';
          let out = '';
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            const vars = { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            out += bodyF({ vars, parent: sc }, d);
          }
          return out;
        };
        return this.memo(f, [...this.nodeRoots(n)]);
      }
      case 'include': {
        const name = n.name;
        const self = this;
        let target;
        const f = (sc, d) => {
          if (target === undefined) target = self.fns.get(name) ?? null;
          if (target === null || d >= INCLUDE_DEPTH) return '';
          return target(sc, d + 1);
        };
        if (!this.trees.has(name)) return () => '';
        return this.memo(f, [...this.rootsMemo.get(name)]);
      }
    }
    return () => '';
  }

  /** `f` memoised on its roots' values and the depth, until it shows it misses nearly every time. */
  memo(f, roots) {
    const nr = roots.length;
    if (nr > 4) return f;
    const cache = new Map();
    let hits = 0;
    let misses = 0;
    let off = false;
    return (sc, d) => {
      if (off) return f(sc, d);
      let m = cache;
      let key = d;
      for (let k = 0; k < nr; k++) {
        let next = m.get(key);
        if (next === undefined) {
          next = new Map();
          m.set(key, next);
        }
        m = next;
        key = rootOf(sc, roots[k]);
      }
      const hit = m.get(key);
      if (hit !== undefined) {
        hits++;
        return hit;
      }
      misses++;
      if (misses > 48 && hits * 8 < misses) {
        off = true;
        cache.clear();
      }
      const out = f(sc, d);
      if (!off) m.set(key, out);
      return out;
    };
  }
}

// ------------------------------------------------------------------ the build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
};

/** Whether `t` opens on a URL scheme: /^[A-Za-z][A-Za-z0-9+.-]*:/ */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) continue;
    return false;
  }
  return false;
}

function build(input) {
  const report = [];
  const trees = new Map();
  for (const name of sortU(Object.keys(input.templates), (x) => x)) {
    try {
      trees.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources in code-unit order of their paths
  const files = sortU([...input.files], (f) => f.path);
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!trees.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkMemo = new Map(); // dir -> Map(target -> href)
  for (const s of sources) {
    const dir = dirOf(s.path);
    let memo = linkMemo.get(dir);
    if (memo === undefined) {
      memo = new Map();
      linkMemo.set(dir, memo);
    }
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35 || hasScheme(target)) return target;
        let r = memo.get(target);
        if (r === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) r = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) r = `${base}/${path}${frag}`;
          else r = null;
          memo.set(target, r);
        }
        if (r === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return r;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const list = s.data.tags;
    if (list === undefined) return [];
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts. `output` maps each path to its text already JSON-escaped (templates render in that form).
  const output = new Map();
  const put = (path, json) => {
    if (path !== '__proto__') output.set(path, json); // as a plain object's assignment would (a string is no prototype)
  };
  const tpl = new Compiled(trees);
  const cardOf = (s) => {
    const date = s.data.date;
    return {
      title: s.data.title,
      url: s.url,
      date: date ?? '',
      date_long: date === undefined ? '' : longDate(date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      // counted on first read: a layout that never shows it never pays for the word count
      get reading_minutes() {
        if (s.minutes === undefined) s.minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
        return s.minutes;
      },
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, extra, value) => {
    const f = tpl.fns.get(name);
    if (f === undefined) return null;
    const vars = { site, tags: allTags, recent };
    if (extra !== null) vars[extra] = value;
    return f({ vars, parent: null }, 0);
  };
  const renderPager = (name, postsV, pager) => {
    const f = tpl.fns.get(name);
    if (f === undefined) return null;
    return f({ vars: { site, tags: allTags, recent, posts: postsV, pager }, parent: null }, 0);
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      get reading_minutes() {
        return card.reading_minutes;
      },
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    put(`${s.outDir}/index.html`, render(s.layout, 'page', page));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderPager(
      'index',
      posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    );
    if (html !== null) put(k === 1 ? 'index.html' : `page/${k}/index.html`, html);
  }
  for (const t of tags) {
    const html = render('tag', 'tag', { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
    if (html !== null) put(`tags/${t.slug}/index.html`, html);
  }
  const tagsHtml = render('tags', null, null);
  if (tagsHtml !== null) put('tags/index.html', tagsHtml);
  for (const f of statics) {
    if (output.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else put(f.path, jesc(f.content));
  }

  // 8. report
  const lines = sortU([...report, ...broken], (x) => x);
  let nPages = 0;
  for (const s of sources) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  put(REPORT_FILE, jesc(`${lines.join('\n')}\n`));
  return output;
}

/** The JSON text of one build's output tree, in the current form. */
function treeJson(input) {
  let out = '{';
  let first = true;
  for (const [path, json] of build(input)) {
    out += first ? `"${jesc(path)}":"${json}"` : `,"${jesc(path)}":"${json}"`;
    first = false;
  }
  return `${out}}`;
}

/** One case's answer, the output tree, as JSON text: what JSON.stringify(run(input)) reads back as. */
export function runJson(input) {
  BYTES = false;
  return treeJson(input);
}

/** runJson for an input in byte form (its strings the UTF-8 bytes of the text, one per char), answering in byte form. */
export function runJsonBytes(input) {
  BYTES = true;
  try {
    return treeJson(input);
  } finally {
    BYTES = false;
  }
}

/** A \uD800-\uDFFF escape: JSON.parse makes it a char no byte holds, so such a file is read as Unicode text. */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

/**
 * Every answer for a cases.json whose bytes are `raw` (read as Latin-1), handed to `emit(text, encoding)` in order:
 * "[", the answers joined by ",", "]". Read and answered in byte form, or as Unicode text when the file holds a
 * surrogate escape.
 */
export function answerFile(raw, emit) {
  const bytes = !SURROGATE_ESCAPE.test(raw);
  const enc = bytes ? 'latin1' : 'utf8';
  const cases = JSON.parse(bytes ? raw : decodeU(raw));
  emit('[', enc);
  for (let i = 0; i < cases.length; i++) {
    if (i > 0) emit(',', enc);
    emit(bytes ? runJsonBytes(cases[i].input) : runJson(cases[i].input), enc);
    cases[i] = null; // its input is garbage from here
  }
  emit(']', enc);
}

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  return JSON.parse(runJson(input));
}
