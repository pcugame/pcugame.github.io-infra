import { loadEnv } from '../../src/config/env.js';
import { createUploadLimiter } from '../../src/shared/upload-limits.js';
import { createSystemClock } from '../../src/infrastructure/production-ports.js';
import { createStorageAdapter } from './index.js';
import { service } from './src/modules/beta/runtime.js';

export function compose() {
 return { config: loadEnv(), limiter: createUploadLimiter(() => 2), clock: createSystemClock(),
  createStorageAdapter, service };
}
