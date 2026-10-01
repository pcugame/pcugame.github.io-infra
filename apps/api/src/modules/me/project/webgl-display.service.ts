import { WebglDisplaySettingsSchema } from '@pcu/contracts';
import type { Actor } from '../../../application/http-input.js';
import { parseBody } from '../../../shared/validation.js';
import type { WebglDisplayRepository } from './webgl-display.repository.js';

export function createWebglDisplayService(repository: WebglDisplayRepository) {
	return {
		read: (actor: Actor, projectId: number) => repository.read(actor, projectId),
		write: (actor: Actor, projectId: number, body: unknown) =>
			repository.write(actor, projectId, parseBody(WebglDisplaySettingsSchema, body)),
	};
}
