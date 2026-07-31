import {
	processUploadLimiter as limiter,
} from '../../../src/infrastructure/production-ports.js';

export const acquire = limiter.acquire;
