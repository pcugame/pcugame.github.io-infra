export interface NewUploadIntent {
	id: string;
	bucket: string;
	storageKey: string;
	purpose: string;
	notBefore: Date;
	ownerOperationId?: string;
	ownerActorId?: number;
	ownerProjectId?: number;
	ownerExhibitionId?: number;
}

export interface UploadIntentRepository {
	prepare(data: NewUploadIntent): Promise<{ id: string }>;
	markUploaded(id: string): Promise<unknown>;
	isUncommitted(id: string): Promise<boolean>;
	recordAmbiguousError(id: string, error: unknown): Promise<unknown>;
	claimStale(
		limit: number,
		now: Date,
		claimToken: string,
		claimUntil: Date,
	): Promise<Array<{
		id: string;
		bucket: string;
		storageKey: string;
		state: 'PREPARED' | 'UPLOADED' | 'COMMITTED';
		attemptCount: number;
	}>>;
	renewClaim(
		id: string,
		claimToken: string,
		now: Date,
		claimUntil: Date,
	): Promise<unknown>;
	markReferenced(id: string, claimToken: string): Promise<unknown>;
	markMissing(id: string, claimToken: string): Promise<unknown>;
	queueCleanup(
		id: string,
		claimToken: string,
		bucket: string,
		storageKey: string,
	): Promise<unknown>;
	markSweepFailed(
		id: string,
		claimToken: string,
		error: unknown,
		nextAttemptAt: Date,
	): Promise<unknown>;
}
