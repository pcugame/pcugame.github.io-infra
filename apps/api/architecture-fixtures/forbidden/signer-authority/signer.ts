export interface BrowserUploadSigner {
	presignUploadPart(partNumber: number): Promise<string>;
	completeMultipart(): Promise<void>;
	deleteObject(): Promise<void>;
}
