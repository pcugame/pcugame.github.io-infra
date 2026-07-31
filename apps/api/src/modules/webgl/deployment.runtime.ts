import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fileSystem } from 'node:fs';
import { tmpdir } from 'node:os';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as storage from '../../lib/storage.js';
import {
	deleteDurablyQueuedObject,
	deleteDurablyQueuedPrefix,
	safeDeleteObject,
	safeDeletePrefix,
} from '../../object-deletion.js';
import { createWebglDeployment } from './deployment.js';

type Deployment = ReturnType<typeof createWebglDeployment>;

let productionDeployment: Deployment | undefined;

function deployment(): Deployment {
	if (productionDeployment) return productionDeployment;
	const config = env();
	productionDeployment = createWebglDeployment({
		config: {
			publicBucket: config.S3_BUCKET_PUBLIC,
			protectedBucket: config.S3_BUCKET_PROTECTED,
		},
		storage: {
			readRange: storage.readObjectRange,
			stream: storage.getObjectStream,
			upload: storage.uploadFile,
		},
		fileSystem: {
			temporaryDirectory: tmpdir,
			createWriteStream,
			remove: (path) => fileSystem.unlink(path),
		},
		ids: { next: randomUUID },
		deletion: {
			deleteOrQueue: safeDeleteObject,
			deletePrefixOrQueue: safeDeletePrefix,
			deleteDurablyQueued: deleteDurablyQueuedObject,
			deleteDurablyQueuedPrefix,
		},
		logger: logger(),
	});
	return productionDeployment;
}

export const deployWebglSource: Deployment['deploySource'] = (...args) => (
	deployment().deploySource(...args)
);
export const rollbackWebglPublicDeployment: Deployment['rollbackPublicDeployment'] = (...args) => (
	deployment().rollbackPublicDeployment(...args)
);
export const deleteWebglProtectedSource: Deployment['deleteProtectedSource'] = (...args) => (
	deployment().deleteProtectedSource(...args)
);
export const deleteWebglDeployment: Deployment['deleteDeployment'] = (...args) => (
	deployment().deleteDeployment(...args)
);
export const deleteWebglDeploymentByEntry: Deployment['deleteDeploymentByEntry'] = (...args) => (
	deployment().deleteDeploymentByEntry(...args)
);
export const deleteDurablyQueuedWebglDeployment:
Deployment['deleteDurablyQueuedDeployment'] = (...args) => (
	deployment().deleteDurablyQueuedDeployment(...args)
);
export const deleteDurablyQueuedWebglDeploymentByEntry:
Deployment['deleteDurablyQueuedDeploymentByEntry'] = (...args) => (
	deployment().deleteDurablyQueuedDeploymentByEntry(...args)
);
