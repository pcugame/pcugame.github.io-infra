import type { UploadPhase, UploadTask } from './types';

type UploadStartInput = {
	title: string;
	phase?: UploadPhase;
	loadedBytes?: number;
	totalBytes?: number;
	percent?: number;
	processingMessage?: string;
};

type UploadUpdateInput = Partial<
	Pick<UploadTask, 'phase' | 'loadedBytes' | 'totalBytes' | 'percent' | 'processingMessage' | 'errorMessage'>
>;

type Listener = () => void;

const listeners = new Set<Listener>();
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>();
let tasks: UploadTask[] = [];
let nextId = 1;

function clampPercent(percent: number): number {
	if (!Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(100, Math.round(percent)));
}

function emit() {
	for (const listener of listeners) listener();
}

function replaceTask(id: string, update: (task: UploadTask) => UploadTask) {
	tasks = tasks.map((task) => (task.id === id ? update(task) : task));
	emit();
}

function removeTask(id: string) {
	const timer = removalTimers.get(id);
	if (timer) {
		clearTimeout(timer);
		removalTimers.delete(id);
	}
	tasks = tasks.filter((task) => task.id !== id);
	emit();
}

function scheduleRemoval(id: string, delayMs: number) {
	const previous = removalTimers.get(id);
	if (previous) clearTimeout(previous);
	removalTimers.set(id, setTimeout(() => removeTask(id), delayMs));
}

export function subscribeToUploads(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getUploadSnapshot(): UploadTask[] {
	return tasks;
}

export function startUpload(input: UploadStartInput): string {
	const id = `upload-${nextId++}`;
	const task: UploadTask = {
		id,
		title: input.title,
		phase: input.phase ?? 'preparing',
		loadedBytes: input.loadedBytes ?? 0,
		totalBytes: input.totalBytes ?? 0,
		percent: clampPercent(input.percent ?? 0),
		status: 'active',
		processingMessage: input.processingMessage,
	};
	tasks = [...tasks, task];
	emit();
	return id;
}

export function updateUpload(id: string, input: UploadUpdateInput): void {
	replaceTask(id, (task) => ({
		...task,
		...input,
		percent: input.percent === undefined ? task.percent : clampPercent(input.percent),
	}));
}

export function finishUpload(id: string): void {
	replaceTask(id, (task) => ({
		...task,
		phase: 'done',
		status: 'done',
		loadedBytes: task.totalBytes > 0 ? task.totalBytes : task.loadedBytes,
		percent: 100,
	}));
	scheduleRemoval(id, 450);
}

export function failUpload(id: string, errorMessage?: string): void {
	replaceTask(id, (task) => ({
		...task,
		phase: 'error',
		status: 'error',
		errorMessage,
	}));
	scheduleRemoval(id, 900);
}

export function clearUpload(id: string): void {
	removeTask(id);
}

export function getVisibleUploadTask(): UploadTask | null {
	const activeTasks = tasks.filter((task) => task.status === 'active' || task.status === 'error');
	return activeTasks.at(-1) ?? null;
}
