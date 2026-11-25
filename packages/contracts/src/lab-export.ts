import type { LabDataset, LabResult, LabRun } from './lab.js';
import type { LabHumanReview, LabReviewBody } from './lab-human.js';
import { labHumanMetrics, labLastAttempt } from './lab-curation.js';
import { labBertScoreSummary } from './lab-bertscore.js';

export type LabExportReview = LabHumanReview & { valid: boolean; resultSnapshot: unknown };
export const LAB_EXPORT_VERSION = 'nickname-evaluation-v2';

export function formatLabExport(run: LabRun, results: LabResult[], format: 'json' | 'jsonl' | 'csv', options: {
  generatedAt?: string; threshold?: number; dataset?: LabDataset; reviews?: LabExportReview[];
} = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const threshold = options.threshold ?? 50;
  const histories = new Map<string, LabExportReview[]>();
  for (const review of options.reviews ?? []) {
    const history = histories.get(review.caseId) ?? [];
    history.push(review);
    histories.set(review.caseId, history);
  }
  for (const history of histories.values()) history.sort((a, b) => a.revision - b.revision);
  const valid = new Map<string, LabReviewBody>();
  let stale = 0;
  const records = results.map((result, ordinal) => {
    const history = histories.get(result.caseId) ?? [];
    const latest = history.at(-1);
    if (latest?.valid) valid.set(result.caseId, latest.body);
    else if (latest) stale++;
    const actual = result.status === 'SUCCEEDED' && result.jsonValid ? result.output?.score ?? null : null;
    const reference = result.testCase.reference;
    const range = reference.scoreRange ?? [reference.expectedScore, reference.expectedScore];
    return { ordinal, ...result,
      evaluation: { expectedScore: reference.expectedScore, actualScore: actual,
        scoreError: actual === null ? null : actual - reference.expectedScore,
        absoluteError: actual === null ? null : Math.abs(actual - reference.expectedScore),
        withinRange: actual === null ? null : actual >= range[0] && actual <= range[1],
        highRisk: actual === null ? null : actual >= threshold },
      review: { latestReviewId: latest?.id ?? null, valid: latest?.valid ?? null, history },
    };
  });
  const metadata = { formatVersion: LAB_EXPORT_VERSION, generatedAt, riskThreshold: threshold, run,
    dataset: options.dataset ?? { id: run.datasetId, hash: run.datasetHash, version: run.datasetVersion, schemaVersion: run.schemaVersion },
    metrics: labHumanMetrics(results, valid, threshold, stale), bertScore: labBertScoreSummary(results) };
  const filename = `nickname-evaluation-${run.id}.${format}`;
  if (format === 'json') return { filename, content: JSON.stringify({ ...metadata, results: records }, null, 2) };
  if (format === 'jsonl') return { filename, content: records.map(result => JSON.stringify({ ...metadata, ...result })).join('\n') + (records.length ? '\n' : '') };

  // Scalars are separate analysis columns. Detailed traces and review revisions live in JSON/JSONL.
  const columns = ['formatVersion', 'generatedAt', 'runId', 'datasetId', 'datasetHash', 'datasetVersion', 'schemaVersion',
    'evaluationProtocol', 'model', 'provider', 'searchMode', 'temperature', 'maxTokens', 'selectedSplit', 'finalTest',
    'systemPrompt', 'actionPrompt', 'answerPrompt', 'promptHash', 'runStatus', 'runCreatedAt', 'runStartedAt', 'runCompletedAt',
    'ordinal', 'caseId', 'nickname', 'split', 'familyId', 'tags', 'expectedReason', 'reason', 'interpretedTerm',
    'expectedScore', 'scoreRangeMin', 'scoreRangeMax', 'score', 'scoreError', 'absoluteError', 'withinRange', 'riskThreshold', 'highRisk',
    'confidence', 'abstained', 'referenceSources', 'sourceIds', 'sourceUrls', 'sourceTitles', 'sourceSnippets', 'sourceCollectedAt',
    'bertScoreStatus', 'bertScoreReason', 'bertScorePrecision', 'bertScoreRecall', 'bertScoreF1', 'bertScoreAttempts',
    'bertScoreModel', 'bertScoreRevision', 'bertScoreConfigHash', 'bertScoreCompletedAt',
    'bertScoreLayers', 'bertScoreThreads', 'bertScoreBatchSize', 'bertScoreIdf', 'bertScoreRescaleWithBaseline', 'bertScoreMaxTokens',
    'bertScoreVersion', 'torchVersion', 'transformersVersion', 'tokenizersVersion',
    'runBertScoreMeasured', 'runBertScoreMissing', 'runBertScorePrecision', 'runBertScoreRecall', 'runBertScoreF1',
    'feedbackPolicy', 'replayOf', 'reviewBehavior', 'reviewBehaviorReasons', 'reviewFeedbackVersion',
    'reviewId', 'reviewRevision', 'reviewValid', 'reviewVerdict', 'reviewErrors', 'reviewCause', 'reviewCohort',
    'reviewRationaleFit', 'reviewInterpretationSuccess', 'reviewBlind', 'reviewNotes', 'reviewActorId', 'reviewCreatedAt',
    'status', 'error', 'jsonValid', 'attempts', 'durationMs', 'searchDurationMs', 'generationDurationMs', 'searchCount', 'toolSupport', 'toolSucceeded'];
  const cell = (value: string | number | boolean | null | undefined) => {
    const text = String(value ?? '');
    // Protect strings only; a negative numeric error remains a number in spreadsheets.
    const safe = typeof value === 'string' && /^[\t\r\n]|^\s*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const rows = records.map(r => {
    const latest = r.review.history.at(-1);
    const review = latest?.valid ? latest.body : undefined;
    const e = r.evaluation;
    const b = r.bertScore;
    const attempt = labLastAttempt(r);
    const duration = (kind: 'search' | 'generation') => attempt?.research
      ? attempt.research.steps.filter(s => kind === 'search' ? s.kind === 'search' : s.kind !== 'search').reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
      : (kind === 'search' ? attempt?.searchDurationMs : attempt?.generationDurationMs);
    return [LAB_EXPORT_VERSION, generatedAt, run.id, run.datasetId, run.datasetHash, run.datasetVersion, run.schemaVersion,
      run.evaluationProtocol, run.model, run.provider, run.searchMode, run.temperature, run.maxTokens, run.split, run.finalTest,
      run.systemPrompt, run.actionPrompt, run.answerPrompt, run.promptHash, run.status, run.createdAt, run.startedAt, run.completedAt,
      r.ordinal, r.caseId, r.testCase.nickname, r.testCase.split, r.testCase.familyId, r.testCase.tags.join('\n'),
      r.testCase.reference.expectedReason, r.output?.reason, r.output?.interpretedTerm, e.expectedScore,
      r.testCase.reference.scoreRange?.[0], r.testCase.reference.scoreRange?.[1], e.actualScore, e.scoreError, e.absoluteError,
      e.withinRange, threshold, e.highRisk, r.output?.confidence, r.output?.abstained, r.testCase.reference.sources.join('\n'),
      r.output?.sourceIds.join('\n'), r.sources.map(s => s.url).join('\n'), r.sources.map(s => s.title).join('\n'),
      r.sources.map(s => s.snippet).join('\n'), r.sources.map(s => s.collectedAt).join('\n'),
      b?.status ?? 'NOT_SCHEDULED', b?.reason, b?.precision, b?.recall, b?.f1, b?.attempts,
      b?.identity?.model, b?.identity?.revision, b?.identity?.configHash, b?.completedAt,
      b?.identity?.layers, b?.identity?.threads, b?.identity?.batchSize, b?.identity?.idf, b?.identity?.rescaleWithBaseline, b?.identity?.maxTokens,
      b?.identity?.versions['bert-score'], b?.identity?.versions.torch, b?.identity?.versions.transformers, b?.identity?.versions.tokenizers,
      metadata.bertScore.measured, metadata.bertScore.missing, metadata.bertScore.precision, metadata.bertScore.recall, metadata.bertScore.f1,
      run.feedbackPolicy, run.replayOf, review?.behavior, review?.behaviorReasons?.join('\n'), review?.feedbackVersion,
      latest?.id, latest?.revision, latest?.valid, review?.verdict, review?.errors.join('\n'), review?.cause, review?.cohort,
      review?.rationaleFit, review?.interpretationSuccess, review?.blind, review?.notes, latest?.actorId, latest?.createdAt,
      r.status, r.error, r.jsonValid, r.attempts, r.durationMs, duration('search'), duration('generation'), r.searchCount, r.toolSupport, r.toolSucceeded,
    ].map(cell).join(',');
  });
  return { filename, content: '\uFEFF' + [columns.join(','), ...rows].join('\r\n') + '\r\n' };
}
