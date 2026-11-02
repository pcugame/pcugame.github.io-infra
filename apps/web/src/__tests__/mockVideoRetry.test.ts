import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoRetryResponseSchema } from '@pcu/contracts';
import { adminProjectApi } from '../lib/api/admin';
import { forgetMockCacheForTests, getMockSnapshot, resetMockState, selectMockUser, setMockControls, updateMockState } from '../lib/api/mock/transport';

beforeEach(async () => { vi.stubEnv('VITE_MOCK', 'true'); await resetMockState(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('persisted mock administrator video retry', () => {
	it('enforces staff access, persists the pending retry, and completes through the actual client', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const project = Object.values((await getMockSnapshot()).projects).find(project => project.videos.length > 0)!;
		const assetId = project.videos[0].assetId;
		await updateMockState(state => {
			const video = state.projects[project.id].videos[0];
			video.playbackStatus = 'FAILED'; delete video.url; video.playbackError = 'Mock conversion failed';
		});
		await selectMockUser('owner');
		await expect(adminProjectApi.retryVideo(project.id, assetId)).rejects.toMatchObject({ status: 403 });
		await selectMockUser('OPERATOR'); await setMockControls({ worker: 'paused' });
		expect(VideoRetryResponseSchema.parse(await adminProjectApi.retryVideo(project.id, assetId))).toEqual({ assetId, playbackStatus: 'PENDING' });
		await expect(adminProjectApi.retryVideo(project.id, assetId)).rejects.toMatchObject({ status: 409 });
		await forgetMockCacheForTests();
		expect((await adminProjectApi.getDetail(project.id)).videos[0].playbackStatus).toBe('PENDING');
		await setMockControls({ worker: 'auto' }); vi.setSystemTime(Date.now() + 2000);
		expect((await adminProjectApi.getDetail(project.id)).videos[0].playbackStatus).toBe('READY');
	});
});
