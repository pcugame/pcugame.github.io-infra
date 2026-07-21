import type { Readable } from 'node:stream';
import type { UserRole } from '@pcu/contracts';

export interface Actor {
	id: number;
	role: UserRole;
	name?: string;
}

export interface MultipartFieldPart {
	type: 'field';
	fieldname: string;
	value: unknown;
}

export interface MultipartFilePart {
	type: 'file';
	fieldname: string;
	filename: string;
	file: Readable;
	mimetype?: string;
}

export type MultipartPart = MultipartFieldPart | MultipartFilePart;

export interface MultipartCommandInput {
	actor: Actor;
	parts: AsyncIterable<MultipartPart>;
}
