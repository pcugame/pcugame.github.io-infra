import {
	VotePublicSchema,
	VoteBallotSchema,
	VoteDrawSchema,
	VoteRecordsSchema,
	VoteAdminSchema,
	DrawAdminSchema,
	VoteSourceSchema,
	VotePosterSchema,
	VoteAdminRecordsSchema,
} from '@pcu/contracts';
import type { VoteSettings, VoteAdmin, DrawSettings } from '@pcu/contracts';
import { z } from 'zod';
import { api } from '../../lib/api/client';
import { votingHeaders } from './participant';
const base = (id: string) => `/api/votes/${encodeURIComponent(id)}`;
export const votingApi = {
	view: async (id: string) =>
		VotePublicSchema.parse(await api.get(base(id), { headers: await votingHeaders() })),
	submit: async (id: string, version: number, candidateIds: string[]) =>
		VoteBallotSchema.parse(
			await api.post(base(id) + '/ballots', { version, candidateIds }, { headers: await votingHeaders() }),
		),
	draw: async (id: string) =>
		VoteDrawSchema.parse(await api.post(base(id) + '/draw', undefined, { headers: await votingHeaders() })),
	receive: async (id: string) =>
		VoteDrawSchema.parse(
			await api.post(base(id) + '/receive', undefined, { headers: await votingHeaders() }),
		),
	records: async (id: string, page: number) =>
		VoteRecordsSchema.parse(await api.get(base(id) + `/records?page=${page}`)),
	list: async () => z.array(VoteAdminSchema).parse(await api.get('/api/admin/votes')),
	events: async () => z.array(DrawAdminSchema).parse(await api.get('/api/admin/draw-events')),
	create: async (settings: VoteSettings) =>
		VoteAdminSchema.parse(await api.post('/api/admin/votes', settings)),
	update: async (vote: VoteAdmin, settings: VoteSettings, reason: string) =>
		VoteAdminSchema.parse(
			await api.put(`/api/admin/votes/${vote.id}`, { settings, version: vote.version, reason }),
		),
	candidate: async (
		vote: VoteAdmin,
		id: string | null,
		input: {
			title: string;
			representationId?: string;
			posterId?: string;
			sourceProjectId: number | null;
			active: boolean;
			reason: string;
		},
	) =>
		VoteAdminSchema.parse(
			await (id
				? api.put(`/api/admin/votes/${vote.id}/candidates/${id}`, { ...input, version: vote.version })
				: api.post(`/api/admin/votes/${vote.id}/candidates`, { ...input, version: vote.version })),
		),
	posters: async (id: string) =>
		z.array(VotePosterSchema).parse(await api.get(`/api/admin/votes/${id}/posters`)),
	sources: async (id: string) =>
		z.array(VoteSourceSchema).parse(await api.get(`/api/admin/votes/${id}/sources`)),
	adminRecords: async (id: string, page: number) =>
		VoteAdminRecordsSchema.parse(await api.get(`/api/admin/votes/${id}/records?page=${page}`)),
	flag: (id: string, ballotId: string, flagged: boolean, note: string) =>
		api.put(`/api/admin/votes/${id}/records/${ballotId}`, { flagged, note, reason: '운영 검토' }),
	saveEvent: async (id: string | null, version: number, settings: DrawSettings, reason: string) =>
		DrawAdminSchema.parse(
			await (id
				? api.put(`/api/admin/draw-events/${id}`, { version, settings, reason })
				: api.post('/api/admin/draw-events', { version, settings, reason })),
		),
};
