import {
	LabBetaUserSchema,
  LabRiskThresholdSchema, LabSaveReviewSchema, LabHumanReviewSchema, LabReviewBundleSchema, LabCreateCandidateSchema, LabCandidateSchema, LabCandidateDecisionSchema, LabCurationOverviewSchema, LabCurationExportRequestSchema, LabCurationExportSchema,
	LabCaseSchema,
	LabCasesQuerySchema,
	LabCompareQuerySchema,
	LabCreateRunSchema,
	LabDatasetSchema,
	LabExportFormatSchema,
	LabPageQuerySchema,
	LabResultsQuerySchema,
	LabResultSchema,
	LabRoleChangeSchema,
	LabRunSchema,
	LabStatusSchema,
	LabUploadSchema,
	apiSuccessSchema,
	ApiErrorResponseSchema,
} from '@pcu/contracts';
import { z } from 'zod';
import type { RouteRuntimeContract } from './http-route-schemas.js';

const id = z.strictObject({ id: z.uuid() });
const empty = z.strictObject({});
const runId = z.object({ runId: z.uuid() });
const page = <S extends z.ZodType>(item: S) =>
	z.object({ items: z.array(item), total: z.number().int().nonnegative() });

function contract(
	method: RouteRuntimeContract['method'],
	path: string,
	data: z.ZodType,
	opts: {
		params?: z.ZodType;
		query?: z.ZodType;
		body?: z.ZodType;
		status?: number;
	} = {},
): RouteRuntimeContract {
	return {
		method,
		url: '/api/lab' + path,
		family: 'lab',
		bodyBoundary: opts.body ? 'json' : 'none',
		responseBoundary: 'json',
		body: opts.body ?? z.null().optional(),
		params: opts.params ?? empty,
		querystring: opts.query ?? empty,
		response: { [opts.status ?? 200]: apiSuccessSchema(data), default: ApiErrorResponseSchema },
	};
}

export const labRouteContracts = [
	contract('GET', '/status', LabStatusSchema),
	contract('GET', '/datasets', z.array(LabDatasetSchema), { query: LabPageQuerySchema }),
	contract('POST', '/datasets', LabDatasetSchema, { body: LabUploadSchema, status: 201 }),
	contract('GET', '/datasets/:id/cases', page(LabCaseSchema), { params: id, query: LabCasesQuerySchema }),
	contract('GET', '/runs', z.array(LabRunSchema), { query: LabPageQuerySchema }),
	contract('POST', '/runs', runId, { body: LabCreateRunSchema, status: 202 }),
	contract('GET', '/runs/:id', LabRunSchema, { params: id }),
	contract('GET', '/runs/:id/results', page(LabResultSchema), { params: id, query: LabResultsQuerySchema }),
  contract('GET', '/runs/:id/results/:caseId/review', LabReviewBundleSchema, { params: id.extend({ caseId: LabCaseSchema.shape.id }) }),
  contract('POST', '/runs/:id/results/:caseId/review', LabHumanReviewSchema, { params: id.extend({ caseId: LabCaseSchema.shape.id }), body: LabSaveReviewSchema, status: 201 }),
  contract('POST', '/runs/:id/results/:caseId/candidates', LabCandidateSchema, { params: id.extend({ caseId: LabCaseSchema.shape.id }), body: LabCreateCandidateSchema, status: 201 }),
  contract('POST', '/runs/:id/candidates/:candidateId/decision', LabCandidateSchema, { params: id.extend({ candidateId: z.uuid() }), body: LabCandidateDecisionSchema }),
  contract('GET', '/runs/:id/curation', LabCurationOverviewSchema, { params: id, query: z.strictObject({ threshold: LabRiskThresholdSchema }) }),
  contract('POST', '/runs/:id/curation/exports', LabCurationExportSchema, { params: id, body: LabCurationExportRequestSchema, status: 201 }),
  contract('GET', '/runs/:id/curation/exports/:exportId', LabCurationExportSchema, { params: id.extend({ exportId: z.uuid() }) }),

	contract('POST', '/runs/:id/cancel', runId, { params: id }),
	contract('POST', '/runs/:id/retry', runId, { params: id }),
  contract('POST', '/runs/:id/bertscore/retry', runId, { params: id }),
	contract(
		'GET',
		'/compare',
		page(
			z.object({ caseId: z.string(), left: LabResultSchema.nullable(), right: LabResultSchema.nullable() }),
		),
		{ query: LabCompareQuerySchema },
	),
	contract('GET', '/runs/:id/export', z.object({ filename: z.string(), content: z.string() }), {
		params: id,
		query: z.strictObject({ format: LabExportFormatSchema, threshold: LabRiskThresholdSchema }),
	}),
	contract('GET', '/beta-users', z.object({ items: z.array(LabBetaUserSchema) }), {
		query: LabPageQuerySchema,
	}),
	contract('PATCH', '/beta-users/:id', LabBetaUserSchema, {
		params: z.strictObject({ id: z.string().regex(/^[1-9]\d{0,8}$/) }),
		body: LabRoleChangeSchema,
	}),
];
