export interface MultipartAbortTarget {
	bucket: string;
	storageKey: string;
	uploadId: string;
	reason: string;
}

export interface MultipartAbortRepository {
	queue(target: MultipartAbortTarget): Promise<unknown>;
	claim(
		limit: number,
		now: Date,
		claimToken: string,
		claimUntil: Date,
	): Promise<Array<{
		id: string;
		bucket: string;
		storageKey: string;
		uploadId: string;
		attemptCount: number;
	}>>;
	renew(
		id: string,
		claimToken: string,
		now: Date,
		claimUntil: Date,
	): Promise<unknown>;
	resolve(id: string, claimToken: string, now: Date): Promise<unknown>;
	fail(
		id: string,
		claimToken: string,
		error: unknown,
		nextAttemptAt: Date,
	): Promise<unknown>;
}
