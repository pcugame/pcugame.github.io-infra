export interface MultipartAbortTarget {
	bucket: string;
	storageKey: string;
	uploadId: string;
	reason: string;
	/** Canonical direct session provenance; optional for Phase-1 legacy tasks. */
	uploadSessionId?: string;
}

export interface MultipartAbortRepository {
	queue(target: MultipartAbortTarget): Promise<unknown>;
	claim(
		limit: number,
		claimToken: string,
		leaseMs: number,
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
		leaseMs: number,
	): Promise<{ count: number }>;
	resolve(id: string, claimToken: string, now: Date): Promise<unknown>;
	fail(
		id: string,
		claimToken: string,
		error: unknown,
		nextAttemptAt: Date,
	): Promise<unknown>;
}
