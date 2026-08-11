import type { PrismaClient, UserRole } from '../../generated/prisma/client.js';

/**
 * Build the complete auth persistence adapter from the Prisma client owned by
 * one BackendContext. Login, request authentication, sliding touch, expiry,
 * and logout all receive this same object.
 */
export function createAuthRepository(client: PrismaClient) {
	return {
		/** Resolve a cookie session and its actor in one query. */
		find(id: string) {
			return client.authSession.findUnique({
				where: { id },
				include: { user: true },
			});
		},

		/** Upsert a user by Google subject ID, updating profile on each login. */
		upsertUserByGoogleSub(data: {
			googleSub: string;
			email: string;
			name: string;
			picture: string;
			studentId?: string;
		}) {
			return client.user.upsert({
				where: { googleSub: data.googleSub },
				create: data,
				update: {
					email: data.email,
					name: data.name,
					picture: data.picture,
					...(data.studentId ? { studentId: data.studentId } : {}),
				},
			});
		},

		/** Upsert a fixed dev/test user with an explicit role. */
		upsertDevUser(data: {
			googleSub: string;
			email: string;
			name: string;
			role: UserRole;
			studentId?: string | null;
		}) {
			return client.user.upsert({
				where: { googleSub: data.googleSub },
				create: {
					googleSub: data.googleSub,
					email: data.email,
					name: data.name,
					picture: '',
					role: data.role,
					...(data.studentId ? { studentId: data.studentId } : {}),
				},
				update: {
					email: data.email,
					name: data.name,
					picture: '',
					role: data.role,
					studentId: data.studentId ?? null,
				},
			});
		},

		/** Create a new auth session. */
		createSession(data: { id: string; userId: number; expiresAt: Date }) {
			return client.authSession.create({ data });
		},

		/** Bump lastSeenAt when the auth plugin performs a sliding refresh. */
		touch(id: string, lastSeenAt: Date) {
			return client.authSession.update({
				where: { id },
				data: { lastSeenAt },
			});
		},

		/** Delete by ID for expiry and logout. */
		delete(id: string) {
			return client.authSession.deleteMany({ where: { id } });
		},

		/** Remove sessions that passed their absolute expiry. */
		async purgeExpired(before: Date) {
			const { count } = await client.authSession.deleteMany({
				where: { expiresAt: { lt: before } },
			});
			return count;
		},
	};
}

export type AuthRepositoryAdapter = ReturnType<typeof createAuthRepository>;
