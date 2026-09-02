import type { Readable } from 'node:stream';
import type { ProjectPublicationPlan } from './plan.js';

export interface ClaimedProjectPublicationJob {
	id: string;
	projectId: number;
	submissionId: string;
	attemptCount: number;
	plan: unknown;
}

export interface ValidatedProjectPublicationJob extends Omit<ClaimedProjectPublicationJob, 'plan'> {
	plan: ProjectPublicationPlan;
}

export type ProjectPublicationPlanValidation =
	| { status: 'VALID'; job: ValidatedProjectPublicationJob }
	| { status: 'FAILED'; error: string }
	| { status: 'CANCELLED' };

export interface ProjectPublicationRepository {
	claim(input: { token: string; leaseMs: number }): Promise<ClaimedProjectPublicationJob | null>;
	validatePlan(job: ClaimedProjectPublicationJob, token: string): Promise<ProjectPublicationPlanValidation>;
	renew(jobId: string, token: string, leaseMs: number): Promise<boolean>;
	complete(job: ValidatedProjectPublicationJob, token: string): Promise<'COMPLETED' | 'CANCELLED'>;
	release(jobId: string, token: string, error: string, retryDelayMs: number): Promise<boolean>;
	fail(jobId: string, token: string, error: string): Promise<boolean>;
	queueCancelledCleanup(jobId: string): Promise<void>;
}

export interface ProjectPublicationStorage {
	head(bucket: string, key: string, signal?: AbortSignal): Promise<{
		size: number;
		checksumSha256?: string;
	} | null>;
	stream(bucket: string, key: string, signal?: AbortSignal): Promise<{ body: Readable; size: number }>;
	upload(input: {
		bucket: string;
		key: string;
		body: Readable;
		contentType: string;
		contentLength: number;
		checksumSha256: string;
		contentEncoding?: string;
		cacheControl: string;
		signal?: AbortSignal;
	}): Promise<void>;
	delete(bucket: string, key: string, signal?: AbortSignal): Promise<void>;
}
