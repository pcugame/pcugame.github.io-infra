import { expect, it } from 'vitest';
import { WebglPlayCreateDataSchema } from './webgl-play.js';

const session = { id: '12345678-1234-4234-8234-123456789abc', controlSecret: 'secret', iframeUrl: 'https://assets.test/runtime/entry', projectTitle: 'Game', expiresAt: 'later', absoluteExpiresAt: 'later' };
it('keeps existing play session consumers compatible and validates optional display dimensions', () => {
	expect(WebglPlayCreateDataSchema.safeParse(session).success).toBe(true);
	for (const size of [null, 1, 8192]) {
		expect(WebglPlayCreateDataSchema.safeParse({ ...session, webglDisplayWidth: size, webglDisplayHeight: size }).success).toBe(true);
	}
	for (const size of [0, -1, 1.5, 8193, '1280']) {
		expect(WebglPlayCreateDataSchema.safeParse({ ...session, webglDisplayWidth: size, webglDisplayHeight: 720 }).success).toBe(false);
	}
});
