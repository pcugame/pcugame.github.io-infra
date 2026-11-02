import { listenControl } from '../infrastructure/runtime-control.js';
import { createWorkGate } from './work-gate.js';

export async function createWorkerControl() {
	const gate = createWorkGate();
	const close = await listenControl(command => {
		if (command === 'quiesce') gate.quiesce();
		if (command === 'resume') gate.resume();
		return { kind: 'worker', ...gate.status() };
	});
	return { gate, close };
}
