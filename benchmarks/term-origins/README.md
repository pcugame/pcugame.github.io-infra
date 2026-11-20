# Term origins benchmark

Upload `benchmark-500.jsonl` to the term origins lab as one file. Each row pairs an expression with a specific use. For example, `ko-0030` concerns a comparison between recipients of social assistance and parasites. A separate biology-class example uses the same Korean word for an actual parasite. The pair tests whether an analysis responds to *who or what is being described*.

## Coverage

| Language bucket | Derogatory use | Historical or social conflict | Meaning change | Neutral control | Uncertain | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Korean | 72 | 60 | 60 | 60 | 48 | 300 |
| English | 24 | 20 | 20 | 20 | 16 | 100 |
| Japanese | 12 | 10 | 10 | 10 | 8 | 50 |
| Other and multilingual | 12 | 10 | 10 | 10 | 8 | 50 |
| **Total** | **120** | **100** | **100** | **100** | **80** | **500** |

The fourth bucket includes Chinese, French, German, Portuguese, Spanish and code-switching. The `language` field stores the individual language code, including `mul` for multilingual cases. Each ten consecutive rows aligned to the start of the file contains six Korean cases, two English cases, one Japanese case and one case from the fourth bucket. The first 10 and 50 rows both cover all five categories. The prefixes are for testing runs and inspecting responses. Differences measured on these small selections carry substantial sampling uncertainty.

## Row schema

| Field | Meaning in this edition |
| --- | --- |
| `id` | Stable within this edition. Language bucket plus four decimal digits starting at 0001. Compare runs using the dataset hash and case ID. |
| `term`, `context` | The target expression and an authored example containing it. A speaker in an example may quote, criticise, reclaim or apply a term. |
| `language` | Language of the case. The target can be a loanword. |
| `category` | One primary sampling stratum from `derogatory`, `historical_conflict`, `semantic_shift`, `neutral`, `uncertain`. It records the reason for including a case. |
| `tags` | Optional annotations. `context-contrast` links repeated same-language targets via their term. `code-switching` marks multilingual contexts. `invented` and `underdetermined` distinguish two types of uncertainty control. |
| `expectedBehavior` | Qualitative review cue. Distinguish uses for `CONTEXT_SENSITIVE`, support claims for `EVIDENCE_REQUIRED`, recognise the contextual meaning for `NEUTRAL_EXPECTED`, and withhold unsupported claims for `ABSTAIN_IF_UNSUPPORTED`. |
| `reference` | Object containing nullable integer scores (0–100), verification status, nullable `originNote` and a list of source URLs. Both scores and the note are null in all 500 rows. Every status is `UNVERIFIED` and every source list is empty. |

The executable upload contract lives in [lab.ts](../../packages/contracts/src/lab.ts). A neutral use can have a contested history. An ambiguous use can have well-attested component words. Human review should distinguish the expression's history, evidence for its use in this context and the model's confidence about each. An unsupported conclusion can justify abstention or a null score. This edition supplies no calibrated numerical ground truth.

## Authorship and publication

The Codex dataset agent in this implementation session (GPT-6 family) authored the expressions in context and the synthetic controls. No separate external model API was called. Dialogue, situations and quoted examples are newly composed fixtures. The corpus includes no collected posts, named private individuals, contact details or attributed quotations. It contains explicit discriminatory language in research contexts, including examples of direct exclusion and critical quotation.

The 40 cases tagged `invented` use an author-coined label in a stated fictional setting. Such a label could coincidentally appear elsewhere. The 40 tagged `underdetermined` contain fragmentary records or missing speaker and referent information. A dictionary entry for an individual word need not resolve the meaning of the fragment. The remaining cases likewise have no adjudicated origin, earliest date or controversy score. Source verification, expert annotation and independent native-speaker review have not been performed. The corpus supports exploratory comparisons between prompts and retrieval settings.

## Reproduce the upload file

Run from the repository root after installing workspace dependencies.

```sh
npm run build -w @pcu/contracts
node benchmarks/term-origins/benchmark.mjs
```

The default command reads the committed bytes with a strict UTF-8 decoder, passes them to the same Zod-backed parser used by the lab, checks edition-specific provenance and control annotations, regenerates all rows in memory and checks the committed file and validation receipt for exact agreement. The receipt in [validation.json](validation.json) records the SHA-256, byte length, language counts, cross-tabulation and uncertainty/contrast counts.

To edit authored content, update a file under `cases/`. A heading selects the category and, for uncertain cases, its subtype. Each data line has a term and a context template separated by a vertical bar. The fourth language bucket has one additional leading language column. A section sign marks where the target is inserted verbatim. IDs follow row numbers within each language bucket, before interleaving. Keep source records in their current order to preserve IDs when correcting wording.

```sh
node benchmarks/term-origins/benchmark.mjs --write
node benchmarks/term-origins/benchmark.mjs
```
