import { prisma } from '../../lib/prisma.js';
import type { UserRole } from '../../generated/prisma/client.js';

/** Resolve a cookie session and its actor in one query. */
export function findSessionWithUser(id: string) {
	return prisma.authSession.findUnique({
		where: { id },
		include: { user: true },
	});
}

/** Upsert a user by Google subject ID, updating profile on each login */
export function upsertUserByGoogleSub(data: {
	googleSub: string;
	email: string;
	name: string;
	picture: string;
	studentId?: string;
}) {
	return prisma.user.upsert({
		where: { googleSub: data.googleSub },
		create: data,
		update: {
			email: data.email,
			name: data.name,
			picture: data.picture,
			...(data.studentId ? { studentId: data.studentId } : {}),
		},
	});
}

/** Upsert a fixed dev/test user with an explicit role. */
export function upsertDevUser(data: {
	googleSub: string;
	email: string;
	name: string;
	role: UserRole;
	studentId?: string | null;
}) {
	return prisma.user.upsert({
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
}

/** Create a new auth session */
export function createSession(data: { id: string; userId: number; expiresAt: Date }) {
	return prisma.authSession.create({ data });
}

/** Bump lastSeenAt — called by the auth plugin when the value is stale enough to be worth a write. */
export function touchSession(id: string, lastSeenAt: Date) {
	return prisma.authSession.update({
		where: { id },
		data: { lastSeenAt },
	});
}

/** Delete sessions by ID (used for logout) */
export function deleteSession(id: string) {
	return prisma.authSession.deleteMany({ where: { id } });
}
