export interface OrphanClaimRenewalPolicy {
	/**
	 * PostgreSQL server-side hard limit for the renewal statement after the
	 * transaction-local setting has been installed. This includes advisory-lock
	 * wait, but does not bound transaction setup or client-side socket cleanup.
	 */
	statementTimeoutMs: number;
	/**
	 * PostgreSQL server-side limit for an idle transaction after the local
	 * setting has been installed. It can terminate an abandoned backend, but
	 * does not guarantee that a partitioned client releases its pool slot.
	 */
	idleTransactionTimeoutMs: number;
	/** Prisma's timer for acquiring an interactive transaction connection. */
	transactionMaxWaitMs: number;
	/**
	 * Prisma's interactive-transaction callback timer. It is a cleanup guard for
	 * responsive transports, not active-query cancellation or a hard connection
	 * lifetime bound.
	 */
	transactionTimeoutMs: number;
	/**
	 * Emergency limit on the JavaScript caller's wait. Expiry does not by itself
	 * cancel underlying PostgreSQL work.
	 */
	jsDeadlineMs: number;
}

export const DEFAULT_ORPHAN_CLAIM_RENEWAL_POLICY = Object.freeze({
	statementTimeoutMs: 45_000,
	idleTransactionTimeoutMs: 5_000,
	transactionMaxWaitMs: 5_000,
	transactionTimeoutMs: 50_000,
	jsDeadlineMs: 60_000,
} satisfies OrphanClaimRenewalPolicy);

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
}

export function resolveOrphanClaimRenewalPolicy(
	overrides: Partial<OrphanClaimRenewalPolicy> = {},
): Readonly<OrphanClaimRenewalPolicy> {
	const policy = { ...DEFAULT_ORPHAN_CLAIM_RENEWAL_POLICY, ...overrides };
	for (const [name, value] of Object.entries(policy)) {
		assertPositiveInteger(name, value);
	}
	if (policy.statementTimeoutMs >= policy.transactionTimeoutMs) {
		throw new Error('Orphan claim renewal statement timeout must precede transaction timeout');
	}
	if (policy.idleTransactionTimeoutMs >= policy.transactionTimeoutMs) {
		throw new Error('Orphan claim renewal idle transaction timeout must precede transaction timeout');
	}
	if (policy.transactionMaxWaitMs + policy.transactionTimeoutMs >= policy.jsDeadlineMs) {
		throw new Error(
			'Orphan claim renewal responsive-transport timing budget must precede the JS deadline',
		);
	}
	return Object.freeze(policy);
}
