import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseLabJsonl } from '@pcu/contracts';

const root = new URL('./', import.meta.url);
const shards = ['culture', 'internet', 'lexicon'];
const families = ['insult', 'social', 'politics', 'history', 'community', 'gaming'];
const methods = ['direct', 'compound', 'substitution', 'omission', 'initials', 'jamo', 'keyboard',
  'romanization', 'kana', 'symbols', 'spacing', 'syllable_anagram', 'jamo_anagram', 'multi'];
const sha = text => createHash('sha256').update(text).digest('hex');
const inputName = 'benchmark-500.jsonl';
const labelsName = 'benchmark-500.labels.jsonl';

async function read(name) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(new URL(name, root)));
}
function lines(text) {
  return text.trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
}
function jsonl(rows) {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}
function counts(rows, key) {
  const result = {};
  for (const row of rows) result[row[key]] = (result[row[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort());
}

// Use the same consonant for an onset and a coda. Expand compound vowels and final clusters
// into their two-set keystrokes, keeping doubled onset consonants distinct (e.g. ㄲ = R).
const onset = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const medial = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const coda = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const clusters = { ㅘ:'ㅗㅏ', ㅙ:'ㅗㅐ', ㅚ:'ㅗㅣ', ㅝ:'ㅜㅓ', ㅞ:'ㅜㅔ', ㅟ:'ㅜㅣ', ㅢ:'ㅡㅣ',
  ㄳ:'ㄱㅅ', ㄵ:'ㄴㅈ', ㄶ:'ㄴㅎ', ㄺ:'ㄹㄱ', ㄻ:'ㄹㅁ', ㄼ:'ㄹㅂ', ㄽ:'ㄹㅅ', ㄾ:'ㄹㅌ', ㄿ:'ㄹㅍ', ㅀ:'ㄹㅎ', ㅄ:'ㅂㅅ' };
const letters = onset + 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅛㅜㅠㅡㅣ';
const keys = 'rRseEfaqQtTdwWczxvg' + 'koiOjpuPhynbml';

function jamo(text) {
  let output = '';
  for (const char of text.normalize('NFC')) {
    const index = char.codePointAt(0) - 0xac00;
    if (index < 0 || index >= 11172) {
      output += clusters[char] ?? char;
      continue;
    }
    const vowel = medial[Math.floor(index / 28) % 21];
    const final = coda[index % 28].trim();
    output += onset[Math.floor(index / 588)] + (clusters[vowel] ?? vowel) + (clusters[final] ?? final);
  }
  return output;
}

function checkStep(from, to, method, name) {
  // Spaces in cited Korean lemmas represent word boundaries.
  const strip = s => s.normalize('NFC').replaceAll(' ', '');
  const bag = s => [...s].sort().join('');
  if (method === 'syllable_anagram' || method === 'jamo_anagram') {
    const unit = s => method === 'jamo_anagram' ? jamo(strip(s)) : strip(s);
    const original = unit(from);
    const permutation = unit(to);
    assert.match(original, method === 'jamo_anagram' ? /^[ㄱ-ㅎㅏ-ㅣ]+$/u : /^[가-힣]+$/u, name);
    assert.notEqual(permutation, original, 'Unchanged permutation: ' + name);
    assert.equal(bag(permutation), bag(original), 'Invalid permutation: ' + name);
  } else if (method === 'initials') {
    assert.match(strip(from), /^[가-힣]+$/u, name);
    const initials = [...strip(from)].map(char => onset[Math.floor((char.codePointAt(0) - 0xac00) / 588)]).join('');
    assert.equal(strip(to), initials, 'Invalid initials: ' + name);
  } else if (method === 'jamo') {
    assert.notEqual(strip(to), strip(from), name);
    assert.equal(jamo(strip(to)), jamo(strip(from)), 'Invalid jamo decomposition: ' + name);
  } else if (method === 'keyboard') {
    const keystrokes = [...jamo(strip(from))].map(char => keys[letters.indexOf(char)] ?? char).join('');
    assert.equal(strip(to), keystrokes, 'Invalid two-set keys: ' + name);
  } else if (method === 'spacing') {
    assert.equal(strip(from), strip(to), 'Invalid spacing change: ' + name);
    assert.notEqual(from, to, name);
  }
}

function checkLabel(row) {
  const { nickname, base, kind, family, method, rule, meaning, uncertainty, sources, stages } = row;
  const name = 'Label for ' + nickname;
  const fields = ['nickname', 'base', 'kind', 'family', 'method', 'rule', 'meaning', 'uncertainty', 'sources'];
  if (stages) fields.push('stages');
  assert.deepEqual(Object.keys(row).sort(), fields.sort(), name);
  for (const field of [nickname, base, rule, meaning, uncertainty]) {
    assert(typeof field === 'string' && field.trim() === field && field.length > 0, name);
  }
  assert(nickname.length <= 40 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(nickname), name);
  assert(['synthetic', 'attested'].includes(kind) && families.includes(family) && methods.includes(method), name);
  // A Korean-community code can itself be alphanumeric. Its Korean reading and record
  // are then particularly important (e.g. the baseball board's SS601B score reference).
  assert(Array.isArray(sources), name);
  if (!/[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(base)) {
    assert(/[가-힣]/u.test(meaning) && sources.length > 0, 'Undocumented source form: ' + base);
  }
  for (const { url, scope, locator } of sources) {
    assert(['http:', 'https:'].includes(new URL(url).protocol), name);
    assert(['surface', 'base'].includes(scope) && typeof locator === 'string' && locator.trim(), name);
  }
  if (kind === 'attested') assert(sources.some(s => s.scope === 'surface'), 'Missing surface evidence: ' + nickname);
  else {
    assert(sources.every(s => s.scope === 'base'), 'Synthetic surface cited as observed: ' + nickname);
    assert.notEqual(nickname, base, 'Unmodified synthetic case: ' + nickname);
  }
  checkStep(base, nickname, method, name);
  if (stages || method === 'multi') {
    assert(method === 'multi' && Array.isArray(stages) && stages.length >= 2, name);
    let current = base;
    for (const step of stages) {
      assert.equal(step.from, current, name);
      assert(methods.includes(step.method) && step.method !== 'multi', name);
      assert(typeof step.to === 'string' && step.from !== step.to, name);
      checkStep(step.from, step.to, step.method, name);
      current = step.to;
    }
    assert.equal(current, nickname, name);
  }
}

// Keep the self-contained Korean report's typesetting and refresh its numeric cells.
function updateReport(html, rows, stats) {
  const totals = { ...stats, ...stats.kind };
  return html.replace(/(data-count="([^"]+)">)\d+(?=<)/g, (_, marker, path) => {
    const [field, value, kind] = path.split('.');
    const count = value
      ? rows.filter(row => row[field] === value && (kind === 'all' || row.kind === kind)).length
      : totals[field];
    assert(Number.isInteger(count), path);
    return marker + count;
  });
}

async function build() {
  const rows = (await Promise.all(shards.map(async shard => lines(await read('cases/' + shard + '.jsonl'))))).flat();
  rows.forEach(checkLabel);
  // Sort independently of the authors' grouping. ID ranges should not reveal type or provenance.
  // The old multilingual edition already used ko-0001 to ko-0300.
  rows.sort((a, b) => sha(a.nickname).localeCompare(sha(b.nickname), 'en'));
  const labels = rows.map((row, i) => ({ id: 'ko-' + String(i + 501).padStart(4, '0'), ...row }));
  const inputs = labels.map(({ id, nickname }) => ({ id, nickname }));
  const inputText = jsonl(inputs);
  assert.deepEqual(parseLabJsonl(inputText), inputs, 'Upload contract must preserve all nickname-only rows');
  // Catch mass replication with punctuation, whitespace, or a changing serial number.
  const variants = new Map();
  for (const { nickname, base } of labels) {
    const key = nickname.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\p{N}\s]/gu, '');
    if (!key) continue;
    const group = variants.get(key) ?? [];
    group.push({ nickname, base });
    variants.set(key, group);
  }
  for (const group of variants.values()) assert(group.length < 4, 'Review trivial variants: ' + JSON.stringify(group));
  const labelText = jsonl(labels);
  const report = {
    rows: labels.length,
    inputSha256: sha(inputText),
    labelsSha256: sha(labelText),
    inputBytes: Buffer.byteLength(inputText),
    distinctBases: new Set(labels.map(({ base }) => base)).size,
    kind: counts(labels, 'kind'),
    family: counts(labels, 'family'),
    method: counts(labels, 'method'),
    distinctSourceUrls: new Set(labels.flatMap(row => row.sources.map(source => source.url))).size,
    syntheticWithBaseSource: labels.filter(row => row.kind === 'synthetic' && row.sources.length).length,
    checkedPermutations: labels.flatMap(row => row.stages ?? [row])
      .filter(step => ['syllable_anagram', 'jamo_anagram'].includes(step.method)).length,
  };
  assert.equal(labels.length, 500);
  assert.deepEqual(Object.keys(report.family).sort(), [...families].sort());
  assert.deepEqual(Object.keys(report.method).sort(), [...methods].sort());
  return {
    [inputName]: inputText,
    [labelsName]: labelText,
    'validation.json': JSON.stringify(report, null, 2) + '\n',
    'distribution.html': updateReport(await read('distribution.html'), labels, report),
  };
}

const args = process.argv.slice(2);
assert(!args.length || (args.length === 1 && args[0] === '--write'), 'Usage: node benchmark.mjs [--write]');
const files = await build();
for (const [name, content] of Object.entries(files)) {
  if (args.length) await writeFile(new URL(name, root), content);
  else assert((await read(name)) === content, name + ' differs from validated sources. Run with --write to regenerate.');
}
process.stdout.write(files['validation.json']);
