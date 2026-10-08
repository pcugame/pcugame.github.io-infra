import { createContext } from 'react';
export const LinearUploadContext = createContext(false);

export const UploadProgressReporter = createContext<((id: string, value: number | null) => void) | null>(null);
