import { parseArgs, type ParseArgsConfig } from 'node:util';
import { prepare, smokeData, save, protocol } from './data.mts';
import { freeze, evaluate, corpusFromReports, captureQueries } from './evaluation.mts';
import { gate, reviewTemplate, select } from './gate.mts';

const options: ParseArgsConfig['options'] = Object.fromEntries([
  'train', 'provenance', 'output', 'data', 'training', 'base', 'candidate', 'policy', 'search', 'corpus',
  'validation-gate', 'plan', 'arm', 'endpoint', 'search-url', 'reviews', 'registration', 'gate',
].map(name => [name, { type: 'string' as const }]));
options.reports = { type: 'string', multiple: true };
options.unconstrained = { type: 'boolean' };
const { values: v, positionals } = parseArgs({ allowPositionals: true, options });
const required = (key: string) => { const value = v[key]; if (typeof value !== 'string') throw Error(`--${key} is required`); return value; };
const optional = (key: string) => typeof v[key] === 'string' ? v[key] as string : undefined;
const reports = () => { if (!Array.isArray(v.reports) || !v.reports.length) throw Error('--reports is required (repeat for each file)'); return v.reports as string[]; };
switch (positionals[0]) {
  case 'prepare': await prepare(required('train'), required('provenance'), required('output')); break;
  case 'smoke-data': await smokeData(required('output')); break;
  case 'protocol': await save(required('output'), protocol()); break;
  case 'freeze': await freeze({ data: required('data'), training: required('training'), base: required('base'),
    candidate: required('candidate'), policy: required('policy'), output: required('output'), search: required('search'),
    corpus: optional('corpus'), validationGate: optional('validation-gate'), unconstrained: v.unconstrained === true }); break;
  case 'evaluate': await evaluate(required('plan'), required('arm'), required('endpoint'), required('output'), optional('search-url')); break;
  case 'corpus': await corpusFromReports(reports(), required('output')); break;
  case 'capture': await captureQueries(required('data'), required('search-url'), required('output')); break;
  case 'review-template': await reviewTemplate(reports(), required('output')); break;
  case 'gate': {
    const decision = await gate(required('plan'), reports(), required('reviews'), required('output'));
    console.log(decision); if (decision === 'keep_base') process.exitCode = 2; break;
  }
  case 'select': await select(required('registration'), required('output'), optional('gate')); break;
  default: console.log(`Nickname LoRA experiment CLI (run from repository root)
  smoke-data --output DIR
  prepare --train JSONL --provenance JSON --output DIR
  freeze --data EVALUATION_JSONL --training MANIFEST --base REGISTRATION --candidate REGISTRATION
         --policy JSON --search replay|live [--corpus JSON] [--validation-gate JSON] --output DIR
  evaluate --plan JSON --arm A|B|C|D --endpoint http://127.0.0.1:18089 [--search-url URL] --output DIR
  corpus --reports LIVE_REPORT [--reports LIVE_REPORT] --output JSON
  capture --data QUERY_JSONL --search-url SEARXNG_URL --output JSON
  review-template --reports REPORT [--reports REPORT] --output JSON
  gate --plan JSON --reports REPORT (four times) --reviews JSON --output JSON
  select --registration JSON [--gate FINAL_GATE] --output LOCAL_POINTER_JSON
  protocol --output JSON`);
}
