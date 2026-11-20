import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseLabJsonl } from '@pcu/contracts';

const root = new URL('./', import.meta.url);
const corpus = new URL('benchmark-500.jsonl', root);
const receipt = new URL('validation.json', root);
const groups = ['ko', 'en', 'ja', 'other'];
const categories = ['derogatory', 'historical_conflict', 'semantic_shift', 'neutral', 'uncertain'];
const expected = {
  derogatory: 'CONTEXT_SENSITIVE',
  historical_conflict: 'EVIDENCE_REQUIRED',
  semantic_shift: 'EVIDENCE_REQUIRED',
  neutral: 'NEUTRAL_EXPECTED',
  uncertain: 'ABSTAIN_IF_UNSUPPORTED',
};

async function readUtf8(url) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(url));
}

function languageGroup(language) {
  return groups.slice(0, 3).includes(language) ? language : 'other';
}

async function readCases(group) {
  const source = await readUtf8(new URL('cases/' + group + '.txt', root));
  const rows = [];
  let category;
  let uncertaintyTag;
  for (const [index, line] of source.trimEnd().split(/\r?\n/).entries()) {
    if (line.startsWith('# ')) {
      [, category, uncertaintyTag] = line.split(' ');
      assert(categories.includes(category), 'Unknown category on ' + group + ':' + (index + 1));
      assert.equal(category === 'uncertain', ['invented', 'underdetermined'].includes(uncertaintyTag));
      continue;
    }
    const fields = line.split('|');
    const language = group === 'other' ? fields.shift() : group;
    const [term, template] = fields;
    assert.equal(fields.length, 2, 'Expected term and context on ' + group + ':' + (index + 1));
    assert.equal(template.split('§').length, 2, 'Mark the target once on ' + group + ':' + (index + 1));
    assert(category && term.trim() === term && template.trim() === template);
    assert.equal(languageGroup(language), group);
    rows.push({
      id: group + '-' + String(rows.length + 1).padStart(4, '0'),
      term, language, context: template.replace('§', () => term), category,
      tags: uncertaintyTag ? [uncertaintyTag] : [],
      expectedBehavior: expected[category],
      reference: {
        proposedScore: null, verifiedScore: null, verification: 'UNVERIFIED', originNote: null, sources: [],
      },
    });
  }
  return rows;
}

// Spread each category through its language's sequence; n equally spaced bin centres
// give each of n cases one stable rank. Rotate ties to vary the small-run prefixes.
function interleaveCategories(rows, groupIndex) {
  return categories.flatMap((category, categoryIndex) => {
    const subset = rows.filter(row => row.category === category);
    return subset.map((row, i) => ({
      row, rank: (i + 0.5) / subset.length,
      tie: (categoryIndex + groupIndex) % categories.length,
    }));
  }).sort((a, b) => a.rank - b.rank || a.tie - b.tie).map(item => item.row);
}

function contrastKey(row) {
  return JSON.stringify([row.language, row.term.normalize('NFKC').toLowerCase()]);
}

async function generate() {
  const batches = await Promise.all(groups.map(readCases));
  const ordered = batches.map(interleaveCategories);
  const counts = new Map();
  for (const row of batches.flat()) {
    const key = contrastKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = ['ko', 'en', 'ko', 'ja', 'ko', 'other', 'ko', 'en', 'ko', 'ko'];
  const rows = [];
  for (let block = 0; block < 50; block++) {
    for (const group of order) {
      const row = ordered[groups.indexOf(group)].shift();
      assert(row, 'Too few cases in ' + group);
      if (counts.get(contrastKey(row)) > 1) row.tags.push('context-contrast');
      if (row.language === 'mul') row.tags.push('code-switching');
      rows.push(row);
    }
  }
  assert(ordered.every(batch => !batch.length), 'Unexpected surplus cases');
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

function audit(jsonl) {
  const rows = parseLabJsonl(jsonl);
  const table = Object.fromEntries(groups.map(group => [group, Object.fromEntries(categories.map(c => [c, 0]))]));
  const languages = {};
  const contrasts = new Set();
  let invented = 0;
  let underdetermined = 0;
  for (const row of rows) {
    const group = languageGroup(row.language);
    assert(row.id.startsWith(group + '-'));
    assert(row.context.includes(row.term));
    assert.equal(row.expectedBehavior, expected[row.category]);
    assert.deepEqual(row.reference, {
      proposedScore: null, verifiedScore: null, verification: 'UNVERIFIED', originNote: null, sources: [],
    });
    assert(!/https?:\/\/|\bwww\.|\S@\S/u.test(row.context), 'Review links or addresses on ' + row.id);
    table[group][row.category]++;
    languages[row.language] = (languages[row.language] ?? 0) + 1;
    if (row.tags.includes('context-contrast')) contrasts.add(contrastKey(row));
    if (row.tags.includes('invented')) invented++;
    if (row.tags.includes('underdetermined')) underdetermined++;
  }
  assert.equal(invented, 40);
  assert.equal(underdetermined, 40);
  assert(contrasts.size >= 12);
  for (const size of [10, 50]) {
    const prefix = rows.slice(0, size);
    assert.equal(new Set(prefix.map(row => row.category)).size, categories.length);
    assert.equal(new Set(prefix.map(row => languageGroup(row.language))).size, groups.length);
  }
  return {
    rows: rows.length,
    sha256: createHash('sha256').update(jsonl).digest('hex'),
    bytes: Buffer.byteLength(jsonl),
    languageByCategory: table, languages, sameLanguageContrastTerms: contrasts.size,
    invented, underdetermined, unverifiedReferences: rows.length, sourceUrls: 0,
  };
}

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === '--write'), 'Usage: node benchmark.mjs [--write]');
const generated = await generate();
const jsonl = args.length ? generated : await readUtf8(corpus);
const report = JSON.stringify(audit(jsonl), null, 2) + '\n';
if (args.length) {
  await writeFile(corpus, jsonl);
  await writeFile(receipt, report);
} else {
  assert.equal(jsonl, generated, 'Published corpus differs from authored cases. Regenerate with --write.');
  assert.equal(await readUtf8(receipt), report, 'Validation receipt differs from the corpus.');
}
process.stdout.write(report);
