import { createContext } from 'react';
export const LinearUploadContext = createContext(false);

export type UploadByteProgress = { loaded: number; total?: number; count: number; percent: number };
export const UploadProgressReporter = createContext<((id: string, value: UploadByteProgress | null) => void) | null>(null);
