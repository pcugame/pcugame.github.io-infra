import { computeFileIdentityCore } from './file-identity-core';

interface ComputeIdentityMessage {
	type: 'compute';
	file: File;
}

const workerScope = self as unknown as {
	onmessage: ((event: MessageEvent<ComputeIdentityMessage>) => void) | null;
	postMessage: (message: unknown) => void;
};

workerScope.onmessage = (event) => {
	if (event.data.type !== 'compute') return;
	void computeFileIdentityCore(event.data.file)
		.then((identity) => workerScope.postMessage({ type: 'success', identity }))
		.catch((error: unknown) => workerScope.postMessage({
			type: 'error',
			message: error instanceof Error ? error.message : '파일 identity 계산에 실패했습니다.',
		}));
};
