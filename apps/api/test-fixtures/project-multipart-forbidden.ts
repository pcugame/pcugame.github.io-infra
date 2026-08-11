import { promises as fileSystem } from 'node:fs';

// Mutation-control fixture for the ticket-011 dependency edge guard.
export const forbiddenProjectMultipartDependency = fileSystem;
