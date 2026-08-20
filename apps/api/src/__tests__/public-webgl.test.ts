import { describe, expect, it } from 'vitest';
import { createWebglDeploymentKeys, parseWebglEntryKey, webglUrl } from '../modules/webgl/paths.js';

describe('immutable public WebGL origin URL', () => {
	it('serializes the exact deployment generation entry key outside the API host', () => {
		const deployment = createWebglDeploymentKeys(
			7,
			'123e4567-e89b-42d3-a456-426614174000',
		);
		const url = webglUrl('https://assets.example.test/public/', deployment.entryKey);

		expect(parseWebglEntryKey(7, deployment.entryKey)).toEqual(deployment);
		expect(url).toBe(
			'https://assets.example.test/public/webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
		);
		expect(url).not.toContain('/api/public/webgl');
	});

	it('does not manufacture a mutable URL from an invalid entry pointer', () => {
		expect(() => webglUrl('https://assets.example.test', 'webgl/7/current/index.html'))
			.toThrow('malformed WebGL entry key');
	});
});
