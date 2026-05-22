import { useContext } from 'react';
import { UploadManagerContext } from './context';
import type { UploadManager } from './context';

export function useUploadManager(): UploadManager {
	const manager = useContext(UploadManagerContext);
	if (!manager) {
		throw new Error('useUploadManager must be used inside UploadProvider');
	}
	return manager;
}
