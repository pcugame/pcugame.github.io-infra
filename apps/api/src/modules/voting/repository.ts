import type { PrismaClient, Prisma } from '../../generated/prisma/client.js';
import { assertNoDeletionClaim, OBJECT_REFERENCE_CLAIM_LOCK_ID } from '../orphan/reference-resolver.js';
const candidateInclude = { poster: true } as const;
const ballotInclude = { selections: { include: { poster: true } }, investigation: true } as const;
const drawInclude = { receipt: true } as const;

function unit(tx: Prisma.TransactionClient, now: Date) {
	return {
		vote: (id: string) =>
			tx.exhibitionVote.findUnique({
				where: { id },
				include: { candidates: { include: candidateInclude }, _count: { select: { ballots: true } } },
			}),
		votes: () =>
			tx.exhibitionVote.findMany({
				orderBy: { createdAt: 'desc' },
				include: { candidates: { include: candidateInclude }, _count: { select: { ballots: true } } },
			}),
		createVote: (data: Prisma.ExhibitionVoteUncheckedCreateInput) => tx.exhibitionVote.create({ data }),
		updateVote: (id: string, data: Prisma.ExhibitionVoteUncheckedUpdateInput) =>
			tx.exhibitionVote.update({ where: { id }, data }),
		exhibition: (id: number) => tx.exhibition.findUnique({ where: { id } }),
		candidate: (id: string) => tx.voteCandidate.findUnique({ where: { id }, include: candidateInclude }),
		saveCandidate: (id: string | null, data: Prisma.VoteCandidateUncheckedCreateInput) =>
			id ? tx.voteCandidate.update({ where: { id }, data }) : tx.voteCandidate.create({ data }),
		async representation(id: string) {
			// Fence cleanup before reading the source, so a deleted key cannot be repinned.
			await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})::text`;
			return tx.assetRepresentation.findUnique({
				where: { id },
				include: { asset: { include: { project: { include: { exhibition: true } }, exhibition: true } } },
			});
		},
		posters: (voteId: string) =>
			tx.votePoster.findMany({ where: { voteId }, orderBy: { createdAt: 'desc' } }),
		retainedPoster: (id: string) => tx.votePoster.findUnique({ where: { id } }),
		sources: (exhibitionId: number) =>
			tx.project.findMany({
				where: {
					exhibitionId,
					visibility: 'PUBLIC',
					status: 'PUBLISHED',
					exhibition: { visibility: 'PUBLIC' },
				},
				include: { poster: { include: { representations: true } } },
			}),
		async poster(voteId: string, bucket: string, objectKey: string) {
			await assertNoDeletionClaim(tx, { bucket, key: objectKey });
			return tx.votePoster.create({ data: { voteId, bucket, objectKey } });
		},
		participant: (hash: string) =>
			tx.voteParticipant.upsert({ where: { hash }, create: { hash }, update: {} }),
		ballot: (voteId: string, participantHash: string) =>
			tx.voteBallot.findUnique({
				where: { voteId_participantHash: { voteId, participantHash } },
				include: ballotInclude,
			}),
		ballots: (voteId: string, skip: number, take: number) =>
			tx.voteBallot.findMany({
				where: { voteId },
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				skip,
				take,
				include: ballotInclude,
			}),
		countBallots: (voteId: string) => tx.voteBallot.count({ where: { voteId } }),
		totals: (voteId: string) =>
			tx.voteSelection.groupBy({ by: ['candidateId'], where: { ballot: { voteId } }, _count: true }),
		createBallot: (data: Prisma.VoteBallotUncheckedCreateInput) =>
			tx.voteBallot.create({ data, include: ballotInclude }),
		flag: (id: string, voteId: string, flagged: boolean, note: string) =>
			tx.voteBallot.update({ where: { id, voteId }, data: { flagged, note } }),
		change: (data: Prisma.VoteChangeUncheckedCreateInput) =>
			tx.voteChange.create({ data: { createdAt: now, ...data } }),
		changes: (voteId: string, skip: number, take: number) =>
			tx.voteChange.findMany({
				where: { voteId, kind: 'CANDIDATE' },
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
				skip,
				take,
			}),
		countChanges: (voteId: string) => tx.voteChange.count({ where: { voteId, kind: 'CANDIDATE' } }),
		event: (id: string) =>
			tx.votingDrawEvent.findUnique({
				where: { id },
				include: { items: true, _count: { select: { draws: true } } },
			}),
		events: () => tx.votingDrawEvent.findMany({ include: { items: true }, orderBy: { title: 'asc' } }),
		saveEvent: (id: string, data: { title: string; mode: string; paused: boolean; version: number }) =>
			tx.votingDrawEvent.upsert({ where: { id }, create: { id, ...data }, update: data }),
		saveItem: (id: string, data: Prisma.VotingDrawItemUncheckedCreateInput) =>
			tx.votingDrawItem.upsert({ where: { id }, create: { id, ...data }, update: data }),
		eventChange: (data: Prisma.VotingDrawChangeUncheckedCreateInput) =>
			tx.votingDrawChange.create({ data: { createdAt: now, ...data } }),
		draw: (eventId: string, participantHash: string) =>
			tx.voteDraw.findUnique({
				where: { eventId_participantHash: { eventId, participantHash } },
				include: drawInclude,
			}),
		eligibleVotes: (eventId: string, participantHash: string) =>
			tx.exhibitionVote.findMany({ where: { eventId, ballots: { some: { participantHash } } } }),
		decrement: (id: string) =>
			tx.votingDrawItem.update({ where: { id }, data: { remaining: { decrement: 1 } } }),
		createDraw: (data: Prisma.VoteDrawUncheckedCreateInput) =>
			tx.voteDraw.create({ data, include: drawInclude }),
		receive: (drawId: string) =>
			tx.voteReceipt.upsert({ where: { drawId }, create: { drawId, createdAt: now }, update: {} }),
		purge: () => tx.$executeRaw`DELETE FROM vote_investigations WHERE "expiresAt" <= clock_timestamp()`,
	};
}
export type VotingUnit = ReturnType<typeof unit>;
export function createVotingRepository(client: PrismaClient) {
	return {
		async transaction<T>(work: (db: VotingUnit, now: Date) => Promise<T>): Promise<T> {
			return client.$transaction(
				async (tx) => {
					// All voting readers/writers use the same lock, including operator inventory
					// edits. Acquire it before reading the database clock or any mutable state.
					await tx.$queryRaw`SELECT pg_advisory_xact_lock(728041903113::bigint)::text`;
					const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
					return work(unit(tx, clock!.now), clock!.now);
				},
				{ maxWait: 10000, timeout: 15000 },
			);
		},
		purge: () => client.$executeRaw`DELETE FROM vote_investigations WHERE "expiresAt" <= clock_timestamp()`,
	};
}
export interface VotingRepository {
	transaction<T>(work: (db: VotingUnit, now: Date) => Promise<T>): Promise<T>;
	purge(): Promise<number>;
}
