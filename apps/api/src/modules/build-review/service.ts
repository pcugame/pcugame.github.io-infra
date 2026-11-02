import type { BuildReviewDecision } from '@pcu/contracts';
import { conflict, forbidden } from '../../shared/errors.js';
import type { BuildReviewRepository } from './ports.js';
export function createBuildReviewService(repository: BuildReviewRepository) {
	return {
		list: (actorId: number, projectId?: number) => repository.list(actorId, projectId),
		detail: (actorId: number, id: string) => repository.detail(actorId, id),
		decide: (actorId: number, id: string, decision: BuildReviewDecision) =>
			repository.decide(actorId, id, async (snapshot, save) => {
				if (!['ADMIN', 'OPERATOR'].includes(snapshot.currentRole)) throw forbidden();
				const review = snapshot.review;
				if (
					snapshot.currentGeneration !== review.generation ||
					snapshot.currentIdentity !== review.sourceIdentity
				)
					throw conflict('Review source changed');
				if (review.decision !== 'PENDING') {
					if (
						review.decision === decision.decision &&
						review.reason === decision.reason &&
						review.entryPath === (decision.entryPath ?? review.inspection.entryPath) &&
						decision.version === review.version - 1
					)
						return review;
					throw conflict('Review has already been decided');
				}
				if (review.version !== decision.version || snapshot.state !== 'AWAITING_REVIEW')
					throw conflict('Review version changed');
				if (decision.decision === 'APPROVED' && review.kind === 'WEBGL') {
					const entry = decision.entryPath ?? review.inspection.entryPath;
					if (!entry || !review.inspection.entryCandidates.includes(entry))
						throw conflict('Select an analyzed web entry');
					if (
						decision.entryPath &&
						review.inspection.entryPath &&
						decision.entryPath !== review.inspection.entryPath
					)
						throw conflict('Web entry is already unambiguous');
				} else if (decision.entryPath) throw conflict('Entry selection is only allowed for web approval');
				return save(decision);
			}),
	};
}
