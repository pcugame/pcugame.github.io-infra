import type { ObjectStorage } from '../../src/application/ports.js';

export function createController(storage: ObjectStorage) {
	return { storage };
}
