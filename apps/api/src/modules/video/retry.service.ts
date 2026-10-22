import type { UserRole } from '@pcu/contracts';
import { conflict, forbidden } from '../../shared/errors.js';

export interface VideoRetryRepository {
	retry(actorId: number, projectId: number, assetId: number,
		run: (currentRole: UserRole, enqueue: () => Promise<boolean>) => Promise<void>): Promise<void>;
}

export function createVideoRetryService(repository: VideoRetryRepository) {
	return {
		async retry(actorId: number, projectId: number, assetId: number) {
			await repository.retry(actorId, projectId, assetId, async (role, enqueue) => {
				if (role !== 'ADMIN' && role !== 'OPERATOR') throw forbidden();
				if (!await enqueue()) throw conflict('이 영상은 재시도할 수 없습니다. 처리 상태를 새로 확인해 주세요.');
			});
			return { assetId, playbackStatus: 'PENDING' as const };
		},
	};
}
