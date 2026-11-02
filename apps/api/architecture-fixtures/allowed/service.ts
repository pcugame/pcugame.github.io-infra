import type { ObjectStorage } from '../../src/application/ports.js';
import { authorizeAssetDelivery } from '../../src/modules/assets/delivery-policy.js';

export function createService(storage: Pick<ObjectStorage, 'head'>) {
 return { storage, authorizeAssetDelivery };
}
