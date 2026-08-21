import { describe, expect, it } from 'vitest';
import type { ExportSnapshot } from '../modules/admin/export/ports.js';
import { planExport } from '../modules/admin/export/worker.js';

describe('canonical WebGL export planning', () => {
	it('exports the immutable WebGL source representation, never an entry URL prefix', () => {
		const snapshot: ExportSnapshot = {
			version: 1,
			jobId: 'job-1',
			year: 2026,
			createdAt: '2026-08-21T00:00:00.000Z',
			projects: [{
				id: 17,
				title: 'WebGL',
				exhibition: { year: 2026, title: 'Show' },
				currentWebglDeploymentId: 'deployment-1',
				members: [],
				objects: [{
					id: 'representation-1', assetId: 5, kind: 'WEBGL', role: 'WEBGL_SOURCE',
					bucket: 'pcu-protected', objectKey: 'protected/assets/5/webgl-source/generation.zip',
					mimeType: 'application/zip', sizeBytes: 100, etag: 'etag',
					representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'source.zip', source: 'canonical',
				}],
			}],
		};

		const plan = planExport(snapshot);
		expect(plan).toHaveLength(1);
		expect(plan[0]?.relativePath).toBe('2026_Show/WebGL/webgl/webgl.zip');
		expect(plan[0]?.object.objectKey).toContain('/webgl-source/');
		expect(plan[0]?.object.objectKey).not.toContain('/index.html');
	});
});
