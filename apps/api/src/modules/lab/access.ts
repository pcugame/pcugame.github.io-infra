import { createHash } from 'node:crypto';
import { LAB_PAGE_SIZE, LabResultSchema, type LabResult, type UserRole } from '@pcu/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { notFound } from '../../shared/errors.js';
export type Actor = { id: number; role: UserRole };
type Tx = Prisma.TransactionClient;
type ResultRow = Prisma.LabResultGetPayload<{ include: { testCase: { select: { body: true } } } }>;
export const withCase = { testCase: { select: { body: true } } } as const;
export const betaRoles = ['USER', 'BETA_TESTER'] as const;
export const userFields = { id: true, email: true, name: true, role: true };
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const offset = (page: number) => (page - 1) * LAB_PAGE_SIZE;
export const scope = (actor: Actor) => (actor.role === 'ADMIN' ? {} : { ownerId: actor.id });

export function matchesCase(q: string): Prisma.LabTestCaseWhereInput {
	const contains = { contains: q, mode: 'insensitive' as const };
	return q ? { OR: [{ caseId: contains }, { nickname: contains }] } : {};
}

export function resultView(row: ResultRow): LabResult {
	return LabResultSchema.parse({ ...row, testCase: row.testCase.body });
}

export async function readableRun(db: Tx, actor: Actor, id: string) {
	const run = await db.labRun.findFirst({ where: { id, ...scope(actor) } });
	if (!run) throw notFound('Run not found');
	return run;
}

export async function readableDataset(db: Tx, actor: Actor, id: string) {
	const dataset = await db.labDataset.findFirst({ where: { id, ...scope(actor) } });
	if (!dataset) throw notFound('Dataset not found');
	return dataset;
}
