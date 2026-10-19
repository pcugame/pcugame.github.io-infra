import type { Prisma } from '../../../generated/prisma/client.js';
import type { Actor } from '../../../application/http-input.js';
import type { PublicationCommand } from '@pcu/contracts';
import { assertPublication, assertPublicationVersion } from '../../../shared/publication-policy.js';
import { conflict } from '../../../shared/errors.js';

export const publicationSnapshotInclude = {
 members: true, poster: { include: { representations: true } },
 assets: { where: { status: 'READY' as const }, include: { representations: true } },
 assetUploads: { orderBy: { createdAt: 'desc' as const } },
} as const;

/** Caller owns the project lock and has rechecked write permission. */
export async function changePublication(tx: Prisma.TransactionClient, id: number, command: PublicationCommand, actor: Actor) {
 const project = await tx.project.findUniqueOrThrow({ where: { id }, include: publicationSnapshotInclude });
 assertPublicationVersion(project.version, command);
 if (command.status === 'PRIVATE') {
  await tx.project.update({ where: { id }, data: {
   publicationStatus: 'PRIVATE', publicationRequested: false, legacyPublication: false,
   publicationExceptionReason: null, publicationActorId: null,
  } });
  return;
 }
 const readiness = assertPublication(project, actor.role, command.exceptionReason);
 const submission = await tx.projectSubmission.findUnique({ where: { projectId: id } });
 if (submission && ['PENDING', 'FINALIZING'].includes(submission.state)) {
  // Object promotion is a separate operation; this request alone never exposes staging bytes.
  await tx.project.update({ where: { id }, data: {
   publicationRequested: true, publicationRequestedVersion: project.version + 1, publicationExceptionReason: command.exceptionReason ?? null, publicationActorId: actor.id,
  } });
 } else {
  if (submission?.state === 'CANCELLED') throw conflict('중단한 제출을 다시 준비한 뒤 공개하세요.');
  await tx.project.update({ where: { id }, data: { publicationStatus: 'PUBLIC', publicationRequested: false, legacyPublication: false } });
 }
 if (command.exceptionReason) await tx.publicationException.create({ data: {
  projectId: id, actorId: actor.id, reason: command.exceptionReason, kind: 'ADMIN', projectVersion: project.version + 1,
  waivedItems: readiness.blockers,
 } });
}
