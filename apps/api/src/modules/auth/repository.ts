import { prisma } from '../../lib/prisma.js';

/** Upsert a user by Google subject ID, updating profile on each login */
export function upsertUserByGoogleSub(data: {
	googleSub: string;
	email: string;
	name: string;
	picture: string;
}) {
	return prisma.user.upsert({
		where: { googleSub: data.googleSub },
		create: data,
		update: { email: data.email, name: data.name, picture: data.picture },
	});
}

/** Create a new auth session */
export function createSession(data: { id: string; userId: number; expiresAt: Date }) {
	return prisma.authSession.create({ data });
}

/** Delete sessions by ID (used for logout) */
export function deleteSession(id: string) {
	return prisma.authSession.deleteMany({ where: { id } });
}
