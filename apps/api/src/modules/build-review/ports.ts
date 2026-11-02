import type { BuildReview, BuildReviewSummary, BuildReviewDecision } from '@pcu/contracts';
import type { BuildInspection, BuildReviewApproval } from '../build-package/types.js';
export interface BuildReviewWorkerPort {
	awaitReview(input: {
		sessionId: string;
		generation: number;
		sourceIdentity: string;
		token: string;
		inspection: BuildInspection;
	}): Promise<boolean>;
	approval(
		sessionId: string,
		generation: number,
		sourceIdentity: string,
	): Promise<BuildReviewApproval | null>;
}
export interface ReviewSnapshot {
	review: BuildReview;
	state: string;
	currentRole: string;
	currentIdentity: string;
	currentGeneration: number;
}
export interface BuildReviewRepository {
	list(actorId: number, projectId?: number): Promise<BuildReviewSummary[]>;
	detail(actorId: number, id: string): Promise<BuildReview>;
	decide<T>(
		actorId: number,
		id: string,
		run: (
			snapshot: ReviewSnapshot,
			save: (decision: BuildReviewDecision) => Promise<BuildReview>,
		) => Promise<T>,
	): Promise<T>;
}
