import { AppError } from '../../shared/errors.js';
import type { ProjectChangeRepository } from './ports.js';
import { createProjectChangeService } from './service.js';

/** Keep injected route graphs complete without fabricating persistence. */
export function createUnavailableProjectChangeService() {
	const unavailable = async (): Promise<never> => {
		throw new AppError(503, 'Project change persistence is unavailable');
	};
	const repository: ProjectChangeRepository = {
		list: unavailable, detail: unavailable, create: unavailable, update: unavailable, transition: unavailable,
	};
	return createProjectChangeService(repository);
}
