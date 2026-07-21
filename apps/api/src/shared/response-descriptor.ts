import type { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';

export interface HttpResponseDescriptor {
	status: number;
	headers?: Record<string, string>;
	removeHeaders?: string[];
	body?: unknown | Readable;
	location?: string;
}

export function applyResponseDescriptor(
	reply: FastifyReply,
	descriptor: HttpResponseDescriptor,
) {
	for (const name of descriptor.removeHeaders ?? []) reply.removeHeader(name);
	for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
		reply.header(name, value);
	}
	if (descriptor.location) return reply.redirect(descriptor.location, descriptor.status);
	return reply.status(descriptor.status).send(descriptor.body);
}

export function applyDescriptorHeaders(
	reply: FastifyReply,
	descriptor: Pick<HttpResponseDescriptor, 'headers' | 'removeHeaders'>,
): void {
	for (const name of descriptor.removeHeaders ?? []) reply.removeHeader(name);
	for (const [name, value] of Object.entries(descriptor.headers ?? {})) {
		reply.header(name, value);
	}
}
