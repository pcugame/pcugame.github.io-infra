/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';

import { handleMockRequest } from '../lib/api/mock/handler';

describe('project direct upload mock', () => {
	afterEach(() => window.localStorage.removeItem('mock-role'));

	it('allows a USER submission to create, upload, complete, and read its project session', async () => {
		window.localStorage.setItem('mock-role', 'USER');
		const session = await handleMockRequest<{ sessionId: string; generation: number }>(
			'/api/admin/projects/999/direct-game-upload-sessions',
			{ method: 'POST', body: JSON.stringify({ originalName: 'game.zip', totalBytes: 4, sourceIdentity: 'a'.repeat(64) }) },
		);
		const signed = await handleMockRequest<{ parts: Array<{ url: string }> }>(
			`/api/admin/direct-asset-upload-sessions/${session.sessionId}/part-urls`,
			{ method: 'POST', body: JSON.stringify({ generation: session.generation, parts: [{ partNumber: 1 }] }) },
		);
		const uploaded = await handleMockRequest<{ etag: string }>(signed.parts[0]!.url, {
			method: 'PUT', body: new Blob(['game']),
		});
		await handleMockRequest(
			`/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`,
			{ method: 'POST', body: JSON.stringify({ generation: session.generation, parts: [{ partNumber: 1, etag: uploaded.etag, sizeBytes: 4 }] }) },
		);
		const status = await handleMockRequest<{ state: string }>(
			`/api/admin/direct-asset-upload-sessions/${session.sessionId}`,
		);

		expect(status.state).toBe('READY');
	});
});
