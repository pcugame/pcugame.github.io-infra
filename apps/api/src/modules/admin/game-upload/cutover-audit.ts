/**
 * Read-only preflight for the direct-only GAME/WEBGL upload cutover.
 *
 * The report intentionally contains counts and stable blocker categories only:
 * object keys, multipart upload IDs, credentials, and connection strings are
 * never serialized.
 */

import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';

const CANONICAL_PUBLIC_BUCKET = 'pcu-public';
const CANONICAL_PROTECTED_BUCKET = 'pcu-protected';

interface CountRow {
	count: bigint | number | string;
}

interface StatusRow extends CountRow {
	status: string;
}

interface SummaryRow {
	legacySessions: bigint | number | string;
	nonterminalLegacySessions: bigint | number | string;
	cleanupCandidateSessions: bigint | number | string;
	legacyActiveSlots: bigint | number | string;
	terminalLegacyActiveSlots: bigint | number | string;
	s3KeyResidue: bigint | number | string;
	s3UploadIdResidue: bigint | number | string;
	storageKeyResidue: bigint | number | string;
	protectedExactTargets: bigint | number | string;
	publicPrefixTargets: bigint | number | string;
	existingAbortTasks: bigint | number | string;
	existingMatchingAbortTasks: bigint | number | string;
	existingOrphanTasks: bigint | number | string;
	existingMatchingOrphanTasks: bigint | number | string;
	legacyPartRows: bigint | number | string;
	legacyPartClaimRows: bigint | number | string;
	preFenceDirectSessions: bigint | number | string;
	preFenceDirectPending: bigint | number | string;
	preFenceDirectCompleting: bigint | number | string;
	preFenceDirectVerifying: bigint | number | string;
	preFenceDirectMalformedLocators: bigint | number | string;
}

interface BlockerRow extends CountRow {
	category: string;
}

export interface GameUploadCutoverAuditReport {
	safeToMigrate: boolean;
	schemaState: 'LEGACY_PRESENT' | 'DIRECT_PRE_FENCE' | 'DIRECT_ONLY';
	legacySessions: {
		total: number;
		byStatus: Record<string, number>;
		nonterminal: number;
		cleanupCandidates: number;
		activeSlots: number;
		terminalActiveSlots: number;
	};
	preFenceDirectSessions: {
		total: number;
		byStatus: { pending: number; completing: number; verifying: number };
		malformedLocators: number;
	};
	collisions: {
		readyAssets: number;
		projects: number;
		preservedSessions: number;
		liveUploadIntents: number;
	};
	residue: {
		s3KeyRows: number;
		s3UploadIdRows: number;
		storageKeyRows: number;
		protectedExactTargets: number;
		publicGenerationPrefixTargets: number;
	};
	existingOutbox: {
		multipartAbortTasks: number;
		matchingMultipartAbortTasks: number;
		orphanDeletionTasks: number;
		matchingOrphanDeletionTasks: number;
	};
	legacyRowsRemoved: {
		gameUploadParts: number;
		gameUploadPartClaims: number;
	};
	namespace: {
		publicBucketMatchesCanonical: boolean;
		protectedBucketMatchesCanonical: boolean;
	};
	blockers: Array<{ category: string; count: number }>;
}

async function auditDirectPreFence(
	tx: Prisma.TransactionClient,
): Promise<GameUploadCutoverAuditReport> {
	const [summary] = await tx.$queryRawUnsafe<Array<{
		total: bigint; pending: bigint; completing: bigint; verifying: bigint;
		malformed: bigint; s3Keys: bigint; uploadIds: bigint; storageKeys: bigint;
		protectedTargets: bigint; publicTargets: bigint;
		abortTasks: bigint; matchingAbortTasks: bigint;
		orphanTasks: bigint; matchingOrphanTasks: bigint;
	}>>(`
		WITH candidates AS MATERIALIZED (
			SELECT "id", "project_id", "upload_kind", "status",
				NULLIF("s3_key", '') AS "s3_key",
				NULLIF("storage_key", '') AS "storage_key",
				NULLIF("s3_upload_id", '') AS "s3_upload_id"
			FROM "game_upload_sessions"
			WHERE "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
		), protected_targets AS MATERIALIZED (
			SELECT DISTINCT locator."storage_key"
			FROM candidates AS candidate
			CROSS JOIN LATERAL (VALUES (candidate."s3_key"), (candidate."storage_key"))
				AS locator("storage_key")
			WHERE locator."storage_key" IS NOT NULL
		), public_targets AS MATERIALIZED (
			SELECT DISTINCT format('webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id")
				AS "storage_key"
			FROM candidates AS candidate
			CROSS JOIN LATERAL (VALUES (candidate."s3_key"), (candidate."storage_key"))
				AS locator("storage_key")
			CROSS JOIN LATERAL (
				SELECT (regexp_match(locator."storage_key", format(
					'^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
					candidate."project_id"
				), 'i'))[1] AS "deployment_id"
			) AS parsed
			WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
				AND locator."storage_key" IS NOT NULL
				AND parsed."deployment_id" IS NOT NULL
		), abort_candidates AS MATERIALIZED (
			SELECT DISTINCT "s3_key" AS "storage_key", "s3_upload_id" AS "upload_id"
			FROM candidates WHERE "s3_key" IS NOT NULL AND "s3_upload_id" IS NOT NULL
		)
		SELECT
			(SELECT count(*) FROM candidates) AS "total",
			(SELECT count(*) FROM candidates WHERE "status" = 'PENDING') AS "pending",
			(SELECT count(*) FROM candidates WHERE "status" = 'COMPLETING') AS "completing",
			(SELECT count(*) FROM candidates WHERE "status" = 'VERIFYING') AS "verifying",
			(SELECT count(*) FROM candidates WHERE
				("status" IN ('PENDING', 'COMPLETING') AND ("s3_key" IS NULL OR "s3_upload_id" IS NULL))
				OR ("status" = 'VERIFYING' AND (
					"s3_key" IS NULL OR "storage_key" IS NULL OR "s3_upload_id" IS NOT NULL
					OR "storage_key" <> "s3_key"
				))
			) AS "malformed",
			(SELECT count(*) FROM candidates WHERE "s3_key" IS NOT NULL) AS "s3Keys",
			(SELECT count(*) FROM candidates WHERE "s3_upload_id" IS NOT NULL) AS "uploadIds",
			(SELECT count(*) FROM candidates WHERE "storage_key" IS NOT NULL) AS "storageKeys",
			(SELECT count(*) FROM protected_targets) AS "protectedTargets",
			(SELECT count(*) FROM public_targets) AS "publicTargets",
			(SELECT count(*) FROM "multipart_abort_tasks") AS "abortTasks",
			(SELECT count(*) FROM "multipart_abort_tasks" AS task WHERE task."bucket" = '${CANONICAL_PROTECTED_BUCKET}'
				AND EXISTS (SELECT 1 FROM abort_candidates AS candidate
					WHERE candidate."storage_key" = task."storage_key" AND candidate."upload_id" = task."upload_id"))
				AS "matchingAbortTasks",
			(SELECT count(*) FROM "orphan_objects") AS "orphanTasks",
			(SELECT count(*) FROM "orphan_objects" AS orphan WHERE
				(orphan."bucket" = '${CANONICAL_PROTECTED_BUCKET}' AND EXISTS (
					SELECT 1 FROM protected_targets AS target WHERE target."storage_key" = orphan."storage_key"
				)) OR (orphan."bucket" = '${CANONICAL_PUBLIC_BUCKET}' AND EXISTS (
					SELECT 1 FROM public_targets AS target WHERE target."storage_key" = orphan."storage_key"
				))) AS "matchingOrphanTasks"
	`);
	if (!summary) throw new Error('Direct pre-fence audit summary query returned no row');

	const blockerRows = await tx.$queryRawUnsafe<BlockerRow[]>(`
		WITH candidates AS MATERIALIZED (
			SELECT "id", "project_id", "upload_kind", "status",
				NULLIF("s3_key", '') AS "s3_key",
				NULLIF("storage_key", '') AS "storage_key",
				NULLIF("s3_upload_id", '') AS "s3_upload_id"
			FROM "game_upload_sessions"
			WHERE "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
		), protected_targets AS MATERIALIZED (
			SELECT DISTINCT locator."storage_key"
			FROM candidates AS candidate
			CROSS JOIN LATERAL (VALUES (candidate."s3_key"), (candidate."storage_key")) AS locator("storage_key")
			WHERE locator."storage_key" IS NOT NULL
		), public_targets AS MATERIALIZED (
			SELECT DISTINCT format('webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id")
				AS "storage_key"
			FROM candidates AS candidate
			CROSS JOIN LATERAL (VALUES (candidate."s3_key"), (candidate."storage_key")) AS locator("storage_key")
			CROSS JOIN LATERAL (
				SELECT (regexp_match(locator."storage_key", format(
					'^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
					candidate."project_id"
				), 'i'))[1] AS "deployment_id"
			) AS parsed
			WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
				AND locator."storage_key" IS NOT NULL AND parsed."deployment_id" IS NOT NULL
		), blocker_counts AS (
			SELECT 'UPLOAD_ID_WITHOUT_EXACT_KEY' AS "category", count(*) AS "count"
			FROM candidates WHERE "s3_upload_id" IS NOT NULL AND "s3_key" IS NULL
			UNION ALL
			SELECT 'PRE_FENCE_ACTIVE_MULTIPART_INCOMPLETE_LOCATOR', count(*) FROM candidates
			WHERE "status" IN ('PENDING', 'COMPLETING') AND ("s3_key" IS NULL OR "s3_upload_id" IS NULL)
			UNION ALL
			SELECT 'PRE_FENCE_VERIFYING_LOCATOR_MISMATCH', count(*) FROM candidates
			WHERE "status" = 'VERIFYING' AND (
				"s3_key" IS NULL OR "storage_key" IS NULL OR "s3_upload_id" IS NOT NULL OR "storage_key" <> "s3_key"
			)
			UNION ALL
			SELECT 'PRE_FENCE_MALFORMED_WEBGL_SOURCE', count(*) FROM candidates
			WHERE "upload_kind" = 'WEBGL'::"UploadKind" AND "s3_key" IS NOT NULL
				AND "s3_key" !~* format(
					'^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
					"project_id"
				)
			UNION ALL
			SELECT 'READY_ASSET_CLEANUP_COLLISION', count(DISTINCT asset."id") FROM "assets" AS asset
			WHERE asset."status" = 'READY'::"AssetStatus" AND (
				(NOT asset."is_public" AND EXISTS (SELECT 1 FROM protected_targets AS target
					WHERE target."storage_key" = asset."storage_key" OR target."storage_key" = asset."playback_storage_key"))
				OR (asset."is_public" AND EXISTS (SELECT 1 FROM public_targets AS target
					WHERE asset."storage_key" LIKE target."storage_key" || '%'
						OR asset."playback_storage_key" LIKE target."storage_key" || '%'))
			)
			UNION ALL
			SELECT 'PRESERVED_SESSION_CLEANUP_COLLISION', count(DISTINCT session."id")
			FROM "game_upload_sessions" AS session
			JOIN protected_targets AS target ON target."storage_key" = session."s3_key"
				OR target."storage_key" = session."storage_key"
			WHERE NOT EXISTS (SELECT 1 FROM candidates WHERE candidates."id" = session."id")
			UNION ALL
			SELECT 'LIVE_UPLOAD_INTENT_CLEANUP_COLLISION', count(DISTINCT intent."id")
			FROM "upload_intents" AS intent WHERE intent."state" IN (
				'PREPARED'::"UploadIntentState", 'UPLOADED'::"UploadIntentState", 'COMMITTED'::"UploadIntentState"
			) AND ((intent."bucket" = '${CANONICAL_PROTECTED_BUCKET}' AND EXISTS (
				SELECT 1 FROM protected_targets AS target WHERE target."storage_key" = intent."storage_key"
			)) OR (intent."bucket" = '${CANONICAL_PUBLIC_BUCKET}' AND EXISTS (
				SELECT 1 FROM public_targets AS target WHERE intent."storage_key" LIKE target."storage_key" || '%'
			)))
			UNION ALL
			SELECT 'PROJECT_WEBGL_GENERATION_COLLISION', count(DISTINCT project."id") FROM "projects" AS project
			WHERE project."webgl_entry_key" <> '' AND EXISTS (
				SELECT 1 FROM public_targets AS target WHERE project."webgl_entry_key" LIKE target."storage_key" || '%'
			)
			UNION ALL
			SELECT 'ACTIVE_OUTBOX_TARGET_KIND_CONFLICT', count(*) FROM "orphan_objects" AS orphan
			WHERE orphan."state" = 'DELETE_CLAIMED'::"OrphanState" AND orphan."claim_until" > clock_timestamp()
				AND ((orphan."bucket" = '${CANONICAL_PROTECTED_BUCKET}'
					AND orphan."target_kind" <> 'EXACT'::"OrphanTargetKind"
					AND EXISTS (SELECT 1 FROM protected_targets AS target WHERE target."storage_key" = orphan."storage_key"))
				OR (orphan."bucket" = '${CANONICAL_PUBLIC_BUCKET}'
					AND orphan."target_kind" <> 'PREFIX'::"OrphanTargetKind"
					AND EXISTS (SELECT 1 FROM public_targets AS target WHERE target."storage_key" = orphan."storage_key")))
		)
		SELECT "category", "count" FROM blocker_counts WHERE "count" > 0 ORDER BY "category"
	`);
	const collisionCategories = new Map([
		['READY_ASSET_CLEANUP_COLLISION', 'readyAssets'],
		['PROJECT_WEBGL_GENERATION_COLLISION', 'projects'],
		['PRESERVED_SESSION_CLEANUP_COLLISION', 'preservedSessions'],
		['LIVE_UPLOAD_INTENT_CLEANUP_COLLISION', 'liveUploadIntents'],
	] as const);
	const collisions = { readyAssets: 0, projects: 0, preservedSessions: 0, liveUploadIntents: 0 };
	for (const row of blockerRows) {
		const key = collisionCategories.get(row.category as never);
		if (key) collisions[key] = numberValue(row.count);
	}
	const blockers = blockerRows
		.filter((row) => !collisionCategories.has(row.category as never))
		.map((row) => ({ category: row.category, count: numberValue(row.count) }));
	return {
		safeToMigrate: blockers.length === 0,
		schemaState: 'DIRECT_PRE_FENCE',
		legacySessions: {
			total: 0, byStatus: {}, nonterminal: 0, cleanupCandidates: 0,
			activeSlots: 0, terminalActiveSlots: 0,
		},
		preFenceDirectSessions: {
			total: numberValue(summary.total),
			byStatus: {
				pending: numberValue(summary.pending),
				completing: numberValue(summary.completing),
				verifying: numberValue(summary.verifying),
			},
			malformedLocators: numberValue(summary.malformed),
		},
		collisions,
		residue: {
			s3KeyRows: numberValue(summary.s3Keys),
			s3UploadIdRows: numberValue(summary.uploadIds),
			storageKeyRows: numberValue(summary.storageKeys),
			protectedExactTargets: numberValue(summary.protectedTargets),
			publicGenerationPrefixTargets: numberValue(summary.publicTargets),
		},
		existingOutbox: {
			multipartAbortTasks: numberValue(summary.abortTasks),
			matchingMultipartAbortTasks: numberValue(summary.matchingAbortTasks),
			orphanDeletionTasks: numberValue(summary.orphanTasks),
			matchingOrphanDeletionTasks: numberValue(summary.matchingOrphanTasks),
		},
		legacyRowsRemoved: { gameUploadParts: 0, gameUploadPartClaims: 0 },
		namespace: { publicBucketMatchesCanonical: true, protectedBucketMatchesCanonical: true },
		blockers,
	};
}

function numberValue(value: bigint | number | string | undefined): number {
	if (value === undefined) return 0;
	const converted = Number(value);
	if (!Number.isSafeInteger(converted) || converted < 0) {
		throw new Error('Cutover audit count is outside the safe integer range');
	}
	return converted;
}

export function addNamespaceBlockers(
	report: GameUploadCutoverAuditReport,
	configured: { publicBucket: string; protectedBucket: string },
): GameUploadCutoverAuditReport {
	const publicBucketMatchesCanonical = configured.publicBucket === CANONICAL_PUBLIC_BUCKET;
	const protectedBucketMatchesCanonical = configured.protectedBucket === CANONICAL_PROTECTED_BUCKET;
	const blockers = [...report.blockers];
	if (!protectedBucketMatchesCanonical && report.residue.protectedExactTargets > 0) {
		blockers.push({ category: 'PROTECTED_BUCKET_NAMESPACE_MISMATCH', count: 1 });
	}
	if (!publicBucketMatchesCanonical && report.residue.publicGenerationPrefixTargets > 0) {
		blockers.push({ category: 'PUBLIC_BUCKET_NAMESPACE_MISMATCH', count: 1 });
	}
	return {
		...report,
		safeToMigrate: blockers.length === 0,
		namespace: { publicBucketMatchesCanonical, protectedBucketMatchesCanonical },
		blockers,
	};
}

export async function auditGameUploadCutover(
	prisma: PrismaClient,
	configured: { publicBucket: string; protectedBucket: string },
): Promise<GameUploadCutoverAuditReport> {
	const report = await prisma.$transaction(async (tx) => {
		// This must be the first application statement in the transaction.
		await tx.$executeRawUnsafe(
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
		);
		const [catalog] = await tx.$queryRawUnsafe<Array<{
			hasTransport: boolean;
			hasExpectedTargetFence: boolean;
			hasParts: boolean;
			hasPartClaims: boolean;
		}>>(`
			SELECT
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = current_schema()
						AND table_name = 'game_upload_sessions'
						AND column_name = 'transport'
				) AS "hasTransport",
				EXISTS (
					SELECT 1 FROM information_schema.columns
					WHERE table_schema = current_schema()
						AND table_name = 'game_upload_sessions'
						AND column_name = 'expected_target_asset_id'
				) AS "hasExpectedTargetFence",
				to_regclass(format('%I.game_upload_parts', current_schema())) IS NOT NULL AS "hasParts",
				to_regclass(format('%I.game_upload_part_claims', current_schema())) IS NOT NULL AS "hasPartClaims"
		`);

		if (!catalog?.hasTransport && !catalog?.hasExpectedTargetFence) {
			return auditDirectPreFence(tx);
		}

		if (!catalog?.hasTransport) {
			const [abortTaskRows, orphanTaskRows] = await Promise.all([
				tx.$queryRawUnsafe<CountRow[]>('SELECT count(*) AS "count" FROM "multipart_abort_tasks"'),
				tx.$queryRawUnsafe<CountRow[]>('SELECT count(*) AS "count" FROM "orphan_objects"'),
			]);
			const abortTasks = abortTaskRows[0] ?? { count: 0 };
			const orphanTasks = orphanTaskRows[0] ?? { count: 0 };
			return {
				safeToMigrate: true,
				schemaState: 'DIRECT_ONLY' as const,
				legacySessions: {
					total: 0, byStatus: {}, nonterminal: 0, cleanupCandidates: 0,
					activeSlots: 0, terminalActiveSlots: 0,
				},
				preFenceDirectSessions: {
					total: 0,
					byStatus: { pending: 0, completing: 0, verifying: 0 },
					malformedLocators: 0,
				},
				collisions: {
					readyAssets: 0, projects: 0, preservedSessions: 0, liveUploadIntents: 0,
				},
				residue: {
					s3KeyRows: 0,
					s3UploadIdRows: 0,
					storageKeyRows: 0,
					protectedExactTargets: 0,
					publicGenerationPrefixTargets: 0,
				},
				existingOutbox: {
					multipartAbortTasks: numberValue(abortTasks.count),
					matchingMultipartAbortTasks: 0,
					orphanDeletionTasks: numberValue(orphanTasks.count),
					matchingOrphanDeletionTasks: 0,
				},
				legacyRowsRemoved: { gameUploadParts: 0, gameUploadPartClaims: 0 },
				namespace: {
					publicBucketMatchesCanonical: true,
					protectedBucketMatchesCanonical: true,
				},
				blockers: [],
			};
		}

		const statuses = await tx.$queryRawUnsafe<StatusRow[]>(`
			SELECT "status", count(*) AS "count"
			FROM "game_upload_sessions"
			WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
			GROUP BY "status"
			ORDER BY "status"
		`);

		const [summary] = await tx.$queryRawUnsafe<SummaryRow[]>(`
			WITH candidates AS MATERIALIZED (
				SELECT "id", "project_id", "upload_kind", "status",
					NULLIF("s3_key", '') AS "s3_key",
					NULLIF("storage_key", '') AS "storage_key",
					NULLIF("s3_upload_id", '') AS "s3_upload_id"
				FROM "game_upload_sessions"
				WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
			), cleanup_candidates AS MATERIALIZED (
				SELECT * FROM candidates WHERE "status" <> 'COMPLETED'
			), target_fence_candidates AS MATERIALIZED (
				SELECT "id", "project_id", "upload_kind", "status",
					NULLIF("s3_key", '') AS "s3_key",
					NULLIF("storage_key", '') AS "storage_key",
					NULLIF("s3_upload_id", '') AS "s3_upload_id"
				FROM "game_upload_sessions"
				WHERE "transport" = 'DIRECT_MULTIPART'::"GameUploadTransport"
					AND "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
			), all_cleanup_candidates AS MATERIALIZED (
				SELECT * FROM cleanup_candidates
				UNION ALL
				SELECT * FROM target_fence_candidates
			), protected_targets AS MATERIALIZED (
				SELECT DISTINCT locator."storage_key"
				FROM all_cleanup_candidates AS candidate
				CROSS JOIN LATERAL (
					VALUES (candidate."s3_key"), (candidate."storage_key")
				) AS locator("storage_key")
				WHERE locator."storage_key" IS NOT NULL
			), public_targets AS MATERIALIZED (
				SELECT DISTINCT format(
					'webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id"
				) AS "storage_key"
				FROM all_cleanup_candidates AS candidate
				CROSS JOIN LATERAL (
					VALUES (candidate."s3_key"), (candidate."storage_key")
				) AS locator("storage_key")
				CROSS JOIN LATERAL (
					SELECT (regexp_match(
						locator."storage_key",
						format(
							'^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
							candidate."project_id"
						), 'i'
					))[1] AS "deployment_id"
				) AS parsed
				WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
					AND locator."storage_key" IS NOT NULL
					AND parsed."deployment_id" IS NOT NULL
			), abort_candidates AS MATERIALIZED (
				SELECT DISTINCT "s3_key" AS "storage_key", "s3_upload_id" AS "upload_id"
				FROM all_cleanup_candidates
				WHERE "s3_key" IS NOT NULL AND "s3_upload_id" IS NOT NULL
			)
			SELECT
				(SELECT count(*) FROM candidates) AS "legacySessions",
				(SELECT count(*) FROM candidates WHERE "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')) AS "nonterminalLegacySessions",
				(SELECT count(*) FROM cleanup_candidates) AS "cleanupCandidateSessions",
					(SELECT count(*)
					 FROM "game_upload_active_sessions" AS active
					 JOIN candidates ON candidates."id" = active."session_id") AS "legacyActiveSlots",
					(SELECT count(*)
					 FROM "game_upload_active_sessions" AS active
					 JOIN candidates ON candidates."id" = active."session_id"
					 WHERE candidates."status" NOT IN ('PENDING', 'COMPLETING', 'VERIFYING'))
						AS "terminalLegacyActiveSlots",
				(SELECT count(*) FROM all_cleanup_candidates WHERE "s3_key" IS NOT NULL) AS "s3KeyResidue",
				(SELECT count(*) FROM all_cleanup_candidates WHERE "s3_upload_id" IS NOT NULL) AS "s3UploadIdResidue",
				(SELECT count(*) FROM all_cleanup_candidates WHERE "storage_key" IS NOT NULL) AS "storageKeyResidue",
				(SELECT count(*) FROM protected_targets) AS "protectedExactTargets",
				(SELECT count(*) FROM public_targets) AS "publicPrefixTargets",
				(SELECT count(*) FROM "multipart_abort_tasks") AS "existingAbortTasks",
				(SELECT count(*) FROM "multipart_abort_tasks" AS task
				 WHERE EXISTS (
					SELECT 1 FROM abort_candidates AS candidate
					WHERE candidate."storage_key" = task."storage_key"
						AND candidate."upload_id" = task."upload_id"
						AND task."bucket" = '${CANONICAL_PROTECTED_BUCKET}'
				 )) AS "existingMatchingAbortTasks",
				(SELECT count(*) FROM "orphan_objects") AS "existingOrphanTasks",
				(SELECT count(*) FROM "orphan_objects" AS orphan
				 WHERE (orphan."bucket" = '${CANONICAL_PROTECTED_BUCKET}' AND EXISTS (
					SELECT 1 FROM protected_targets AS target
					WHERE target."storage_key" = orphan."storage_key"
				 )) OR (orphan."bucket" = '${CANONICAL_PUBLIC_BUCKET}' AND EXISTS (
					SELECT 1 FROM public_targets AS target
					WHERE target."storage_key" = orphan."storage_key"
				 ))) AS "existingMatchingOrphanTasks",
				(SELECT count(*) FROM "game_upload_parts") AS "legacyPartRows",
				(SELECT count(*) FROM "game_upload_part_claims") AS "legacyPartClaimRows",
				(SELECT count(*) FROM target_fence_candidates) AS "preFenceDirectSessions",
				(SELECT count(*) FROM target_fence_candidates WHERE "status" = 'PENDING') AS "preFenceDirectPending",
				(SELECT count(*) FROM target_fence_candidates WHERE "status" = 'COMPLETING') AS "preFenceDirectCompleting",
				(SELECT count(*) FROM target_fence_candidates WHERE "status" = 'VERIFYING') AS "preFenceDirectVerifying",
				(SELECT count(*) FROM target_fence_candidates
				 WHERE ("status" IN ('PENDING', 'COMPLETING')
						AND ("s3_key" IS NULL OR "s3_upload_id" IS NULL))
					OR ("status" = 'VERIFYING' AND (
						"s3_key" IS NULL OR "storage_key" IS NULL
						OR "s3_upload_id" IS NOT NULL OR "storage_key" <> "s3_key"
					))) AS "preFenceDirectMalformedLocators"
		`);
		if (!summary) throw new Error('Cutover audit summary query returned no row');

		const blockerRows = await tx.$queryRawUnsafe<BlockerRow[]>(`
			WITH candidates AS MATERIALIZED (
				SELECT "id", "project_id", "upload_kind", "status",
					NULLIF("s3_key", '') AS "s3_key",
					NULLIF("storage_key", '') AS "storage_key",
					NULLIF("s3_upload_id", '') AS "s3_upload_id"
				FROM "game_upload_sessions"
				WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
					AND "status" <> 'COMPLETED'
			), target_fence_candidates AS MATERIALIZED (
				SELECT "id", "project_id", "upload_kind", "status",
					NULLIF("s3_key", '') AS "s3_key",
					NULLIF("storage_key", '') AS "storage_key",
					NULLIF("s3_upload_id", '') AS "s3_upload_id"
				FROM "game_upload_sessions"
				WHERE "transport" = 'DIRECT_MULTIPART'::"GameUploadTransport"
					AND "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
			), cleanup_candidates AS MATERIALIZED (
				SELECT * FROM candidates
				UNION ALL
				SELECT * FROM target_fence_candidates
			), protected_targets AS MATERIALIZED (
				SELECT DISTINCT locator."storage_key"
				FROM cleanup_candidates AS candidate
				CROSS JOIN LATERAL (
					VALUES (candidate."s3_key"), (candidate."storage_key")
				) AS locator("storage_key")
				WHERE locator."storage_key" IS NOT NULL
			), public_targets AS MATERIALIZED (
				SELECT DISTINCT format(
					'webgl/%s/%s/site/', candidate."project_id", parsed."deployment_id"
				) AS "storage_key"
				FROM cleanup_candidates AS candidate
				CROSS JOIN LATERAL (
					VALUES (candidate."s3_key"), (candidate."storage_key")
				) AS locator("storage_key")
				CROSS JOIN LATERAL (
					SELECT (regexp_match(
						locator."storage_key",
						format(
							'^webgl/%s/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/source[.]zip$',
							candidate."project_id"
						), 'i'
					))[1] AS "deployment_id"
				) AS parsed
				WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
					AND locator."storage_key" IS NOT NULL
					AND parsed."deployment_id" IS NOT NULL
			), blocker_counts AS (
					SELECT 'UPLOAD_ID_WITHOUT_EXACT_KEY' AS "category", count(*) AS "count"
					FROM cleanup_candidates WHERE "s3_upload_id" IS NOT NULL AND "s3_key" IS NULL
					UNION ALL
					SELECT 'PRE_FENCE_ACTIVE_MULTIPART_INCOMPLETE_LOCATOR', count(*)
					FROM target_fence_candidates
					WHERE "status" IN ('PENDING', 'COMPLETING')
						AND ("s3_key" IS NULL OR "s3_upload_id" IS NULL)
					UNION ALL
					SELECT 'PRE_FENCE_VERIFYING_LOCATOR_MISMATCH', count(*)
					FROM target_fence_candidates
					WHERE "status" = 'VERIFYING' AND (
						"s3_key" IS NULL OR "storage_key" IS NULL
						OR "s3_upload_id" IS NOT NULL OR "storage_key" <> "s3_key"
					)
					UNION ALL
					SELECT 'PRE_FENCE_MALFORMED_WEBGL_SOURCE', count(*)
					FROM target_fence_candidates
					WHERE "upload_kind" = 'WEBGL'::"UploadKind"
						AND "s3_key" IS NOT NULL
						AND "s3_key" !~* format(
							'^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
							"project_id"
						)
					UNION ALL
					SELECT 'COMPLETED_LOCATOR_MISMATCH', count(*)
					FROM "game_upload_sessions"
					WHERE "transport" = 'API_CHUNK_PROXY'::"GameUploadTransport"
						AND "status" = 'COMPLETED'
						AND NULLIF("storage_key", '') IS NOT NULL
						AND NULLIF("s3_key", '') IS NOT NULL
						AND "storage_key" <> "s3_key"
					UNION ALL
				SELECT 'MALFORMED_WEBGL_GENERATION_KEY', count(DISTINCT candidate."id")
				FROM candidates AS candidate
				CROSS JOIN LATERAL (
					VALUES (candidate."s3_key"), (candidate."storage_key")
				) AS locator("storage_key")
				WHERE candidate."upload_kind" = 'WEBGL'::"UploadKind"
					AND locator."storage_key" IS NOT NULL
					AND locator."storage_key" !~* format(
						'^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
						candidate."project_id"
					)
				UNION ALL
				SELECT 'READY_ASSET_CLEANUP_COLLISION', count(DISTINCT asset."id")
				FROM "assets" AS asset
				WHERE asset."status" = 'READY'::"AssetStatus" AND (
					(NOT asset."is_public" AND EXISTS (
						SELECT 1 FROM protected_targets AS target
						WHERE target."storage_key" = asset."storage_key"
							OR target."storage_key" = asset."playback_storage_key"
					)) OR (asset."is_public" AND EXISTS (
						SELECT 1 FROM public_targets AS target
						WHERE asset."storage_key" LIKE target."storage_key" || '%'
							OR asset."playback_storage_key" LIKE target."storage_key" || '%'
					))
				)
				UNION ALL
				SELECT 'PRESERVED_SESSION_CLEANUP_COLLISION', count(DISTINCT session."id")
				FROM "game_upload_sessions" AS session
				JOIN protected_targets AS target
					ON target."storage_key" = session."s3_key"
						OR target."storage_key" = session."storage_key"
				WHERE NOT EXISTS (SELECT 1 FROM cleanup_candidates WHERE cleanup_candidates."id" = session."id")
				UNION ALL
				SELECT 'LIVE_UPLOAD_INTENT_CLEANUP_COLLISION', count(DISTINCT intent."id")
				FROM "upload_intents" AS intent
				WHERE intent."state" IN (
					'PREPARED'::"UploadIntentState",
					'UPLOADED'::"UploadIntentState",
					'COMMITTED'::"UploadIntentState"
				) AND (
					(intent."bucket" = '${CANONICAL_PROTECTED_BUCKET}' AND EXISTS (
						SELECT 1 FROM protected_targets AS target
						WHERE target."storage_key" = intent."storage_key"
					)) OR (intent."bucket" = '${CANONICAL_PUBLIC_BUCKET}' AND EXISTS (
						SELECT 1 FROM public_targets AS target
						WHERE intent."storage_key" LIKE target."storage_key" || '%'
					))
				)
				UNION ALL
				SELECT 'PROJECT_WEBGL_GENERATION_COLLISION', count(DISTINCT project."id")
				FROM "projects" AS project
				WHERE project."webgl_entry_key" <> '' AND EXISTS (
					SELECT 1 FROM public_targets AS target
					WHERE project."webgl_entry_key" LIKE target."storage_key" || '%'
				)
				UNION ALL
					SELECT 'MALFORMED_PROJECT_WEBGL_POINTER', count(*)
				FROM "projects" AS project
				WHERE EXISTS (SELECT 1 FROM public_targets)
					AND project."webgl_entry_key" <> ''
					AND project."webgl_entry_key" !~* format(
						'^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/site/index[.]html$',
							project."id"
						)
					UNION ALL
					SELECT 'MALFORMED_LIVE_DIRECT_WEBGL_POINTER', count(*)
					FROM "game_upload_sessions" AS session
					WHERE EXISTS (SELECT 1 FROM public_targets)
						AND session."transport" = 'DIRECT_MULTIPART'::"GameUploadTransport"
						AND session."upload_kind" = 'WEBGL'::"UploadKind"
						AND session."status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
						AND COALESCE(session."storage_key", session."s3_key", '') <> ''
						AND COALESCE(session."storage_key", session."s3_key") !~* format(
							'^webgl/%s/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/source[.]zip$',
							session."project_id"
						)
					UNION ALL
					SELECT 'ACTIVE_OUTBOX_TARGET_KIND_CONFLICT', count(*)
					FROM "orphan_objects" AS orphan
					WHERE orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
						AND orphan."claim_until" > clock_timestamp()
						AND (
							(orphan."bucket" = '${CANONICAL_PROTECTED_BUCKET}'
								AND orphan."target_kind" <> 'EXACT'::"OrphanTargetKind"
								AND EXISTS (SELECT 1 FROM protected_targets AS target
									WHERE target."storage_key" = orphan."storage_key"))
							OR
							(orphan."bucket" = '${CANONICAL_PUBLIC_BUCKET}'
								AND orphan."target_kind" <> 'PREFIX'::"OrphanTargetKind"
								AND EXISTS (SELECT 1 FROM public_targets AS target
									WHERE target."storage_key" = orphan."storage_key"))
						)
			)
			SELECT "category", "count" FROM blocker_counts WHERE "count" > 0
			ORDER BY "category"
			`);
			const collisionCategories = new Map([
				['READY_ASSET_CLEANUP_COLLISION', 'readyAssets'],
				['PROJECT_WEBGL_GENERATION_COLLISION', 'projects'],
				['PRESERVED_SESSION_CLEANUP_COLLISION', 'preservedSessions'],
				['LIVE_UPLOAD_INTENT_CLEANUP_COLLISION', 'liveUploadIntents'],
			] as const);
			const collisionCounts = {
				readyAssets: 0,
				projects: 0,
				preservedSessions: 0,
				liveUploadIntents: 0,
			};
			for (const row of blockerRows) {
				const key = collisionCategories.get(row.category as never);
				if (key) collisionCounts[key] = numberValue(row.count);
			}
			const blockers = blockerRows
				.filter((row) => !collisionCategories.has(row.category as never))
				.map((row) => ({ category: row.category, count: numberValue(row.count) }));

			return {
				safeToMigrate: blockers.length === 0,
			schemaState: 'LEGACY_PRESENT' as const,
			legacySessions: {
				total: numberValue(summary.legacySessions),
				byStatus: Object.fromEntries(statuses.map((row) => [row.status, numberValue(row.count)])),
				nonterminal: numberValue(summary.nonterminalLegacySessions),
					cleanupCandidates: numberValue(summary.cleanupCandidateSessions),
					activeSlots: numberValue(summary.legacyActiveSlots),
					terminalActiveSlots: numberValue(summary.terminalLegacyActiveSlots),
				},
			preFenceDirectSessions: {
				total: numberValue(summary.preFenceDirectSessions),
				byStatus: {
					pending: numberValue(summary.preFenceDirectPending),
					completing: numberValue(summary.preFenceDirectCompleting),
					verifying: numberValue(summary.preFenceDirectVerifying),
				},
				malformedLocators: numberValue(summary.preFenceDirectMalformedLocators),
			},
			residue: {
				s3KeyRows: numberValue(summary.s3KeyResidue),
				s3UploadIdRows: numberValue(summary.s3UploadIdResidue),
				storageKeyRows: numberValue(summary.storageKeyResidue),
				protectedExactTargets: numberValue(summary.protectedExactTargets),
					publicGenerationPrefixTargets: numberValue(summary.publicPrefixTargets),
				},
				collisions: collisionCounts,
			existingOutbox: {
				multipartAbortTasks: numberValue(summary.existingAbortTasks),
				matchingMultipartAbortTasks: numberValue(summary.existingMatchingAbortTasks),
				orphanDeletionTasks: numberValue(summary.existingOrphanTasks),
				matchingOrphanDeletionTasks: numberValue(summary.existingMatchingOrphanTasks),
			},
			legacyRowsRemoved: {
				gameUploadParts: catalog.hasParts ? numberValue(summary.legacyPartRows) : 0,
				gameUploadPartClaims: catalog.hasPartClaims ? numberValue(summary.legacyPartClaimRows) : 0,
			},
			namespace: {
				publicBucketMatchesCanonical: true,
				protectedBucketMatchesCanonical: true,
			},
				blockers,
		};
	}, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

	return addNamespaceBlockers(report, configured);
}
