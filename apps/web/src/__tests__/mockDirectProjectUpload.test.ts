/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';

import type { AdminProjectDetail, PublicProjectDetailResponse } from '@pcu/contracts';
import { handleMockRequest } from '../lib/api/mock/handler';

describe('project direct upload mock', () => {
	afterEach(() => window.localStorage.removeItem('mock-role'));

	it('preserves submitted and updated requirements through admin and public reads', async () => {
		window.localStorage.setItem('mock-role', 'USER');
		const formData = new FormData();
		formData.set('payload', JSON.stringify({ exhibitionId: 1, title: '환경 테스트', members: [{ name: '학생', studentId: '123' }], platforms: ['WEB'], hardwareRequirements: 'VR 헤드셋', manifest: [] }));
		await handleMockRequest('/api/me/projects/submit', { method: 'POST', body: formData });
		const created = await handleMockRequest<AdminProjectDetail>('/api/admin/projects/999');
		expect(created).toMatchObject({ platforms: ['WEB'], hardwareRequirements: 'VR 헤드셋' });
		await handleMockRequest('/api/admin/projects/999', { method: 'PATCH', body: JSON.stringify({ title: '새 제목' }) });
		const preserved = await handleMockRequest<PublicProjectDetailResponse>('/api/public/projects/999');
		expect(preserved).toMatchObject({ platforms: ['WEB'], hardwareRequirements: 'VR 헤드셋' });
		await handleMockRequest('/api/admin/projects/999', { method: 'PATCH', body: JSON.stringify({ platforms: [], hardwareRequirements: '' }) });
		const cleared = await handleMockRequest<PublicProjectDetailResponse>('/api/public/projects/999');
		expect(cleared).toMatchObject({ platforms: [], hardwareRequirements: '' });
	});

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
