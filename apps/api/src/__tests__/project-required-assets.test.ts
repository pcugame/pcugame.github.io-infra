import { describe, expect, it } from 'vitest';
import { projectRequiredAssets, type RequiredAssetsSource } from '../shared/project-required-assets.js';

const empty: RequiredAssetsSource = { id: 1, assets: [], poster: null };
const original = { role: 'ORIGINAL', state: 'READY' };

describe('required project assets', () => {
	it('does not infer completeness from project metadata or unrelated images', () => {
		expect(projectRequiredAssets({ ...empty, assets: [{ kind: 'IMAGE', representations: [original] }] }))
			.toMatchObject({ readyCount: 0, totalCount: 4, complete: false, poster: { ready: false, processing: false } });
	});
	it('keeps existing readiness while uploading a replacement', () => {
		expect(projectRequiredAssets({ ...empty,
			assets: [{ kind: 'GAME', representations: [original] }],
			assetUploads: [{ kind: 'GAME', state: 'UPLOADING' }, { kind: 'POSTER', state: 'VERIFYING' }],
		})).toMatchObject({ nativeBuild: { ready: true, processing: true }, poster: { ready: false, processing: true } });
	});
	it.each(['CANCELLED', 'EXPIRED', 'REJECTED', 'READY'])('does not report terminal %s uploads as processing', (state) => {
		expect(projectRequiredAssets({ ...empty, assetUploads: [{ kind: 'WEBGL', state }] }).webBuild)
			.toEqual({ ready: false, processing: false, failed: state === 'REJECTED' });
	});
	it('requires playable video and stops processing when conversion fails', () => {
		for (const state of ['PENDING', 'VERIFYING', 'FAILED', 'READY']) {
			const summary = projectRequiredAssets({ ...empty, assets: [{ kind: 'VIDEO', representations: [original, { role: 'PLAYBACK', state }] }] });
			expect(summary.video).toEqual({ ready: state === 'READY', processing: state === 'PENDING' || state === 'VERIFYING', failed: state === 'FAILED' });
		}
	});
	it('forgets rejected attempts after a newer successful or cancelled upload', () => {
		for (const state of ['READY', 'CANCELLED']) {
			expect(projectRequiredAssets({ ...empty, assetUploads: [{ kind: 'GAME', state }, { kind: 'GAME', state: 'REJECTED' }] }).nativeBuild.failed).toBe(false);
		}
	});
	it('reports failed replacement uploads even when an old asset is still ready', () => {
		expect(projectRequiredAssets({ ...empty, assets: [{ kind: 'GAME', representations: [original] }], assetUploads: [{ kind: 'GAME', state: 'REJECTED' }] }).nativeBuild)
			.toEqual({ ready: true, processing: false, failed: true });
	});
	it('counts a selected image as the poster and only the current valid web deployment', () => {
		const project: RequiredAssetsSource = { ...empty,
			assets: [{ kind: 'GAME', representations: [original] }, { kind: 'VIDEO', representations: [original, { role: 'PLAYBACK', state: 'READY' }] }],
			poster: { kind: 'IMAGE', status: 'READY', representations: [original] },
			currentWebglDeploymentId: 'current',
			currentWebglDeployment: { id: 'current', projectId: 1, state: 'READY', publicBucket: 'public', publicPrefix: 'webgl/1/', entryObjectKey: 'webgl/1/index.html' },
		};
		expect(projectRequiredAssets(project, 'public')).toMatchObject({ readyCount: 4, complete: true });
		expect(projectRequiredAssets({ ...project, currentWebglDeploymentId: 'old' }, 'public').webBuild.ready).toBe(false);
		expect(projectRequiredAssets(project, 'other').webBuild.ready).toBe(false);
	});
	it('shows publication as processing until its worker finishes, but not after failure', () => {
		for (const state of ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
			const summary = projectRequiredAssets({ ...empty, publicationJob: {
				state, submission: { items: [{ kind: 'WEBGL', state: 'READY' }, { kind: 'POSTER', state: 'READY' }] },
			} });
			expect(summary.webBuild.processing).toBe(state === 'PENDING' || state === 'PROCESSING');
			expect(summary.poster.processing).toBe(summary.webBuild.processing);
		}
	});
});
