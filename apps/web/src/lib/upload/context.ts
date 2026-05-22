import { createContext } from 'react';
import type { failUpload, finishUpload, startUpload, updateUpload } from './store';

export type UploadManager = {
	startUpload: typeof startUpload;
	updateUpload: typeof updateUpload;
	finishUpload: typeof finishUpload;
	failUpload: typeof failUpload;
};

export const UploadManagerContext = createContext<UploadManager | null>(null);
