import type { PrismaClient } from '../../generated/prisma/client.js';
const project = { include: { exhibition: true, members: true, changeRequestDraft: { include: { project: { include: { members: true } } } } } } as const;
import type { FileAccessRepository } from './ports.js';
export function createFileAccessRepository(client: PrismaClient): FileAccessRepository {
 return {
  votePoster: async (bucket: string, objectKey: string) => client.votePoster.findFirst({ where: { bucket, objectKey } }),
  purgeExpired: async (at: Date) => client.fileAccessToken.deleteMany({where:{expiresAt:{lte:at}}}),
  reusable: async (sessionId:string|null,bucket:string,objectKey:string,deploymentId:string|null,at:Date)=>client.fileAccessToken.findFirst({where:{sessionId,bucket,objectKey,deploymentId,expiresAt:{gt:at}}}),
  activeCount: async (sessionId:string|null, at:Date)=>client.fileAccessToken.count({where:{sessionId,expiresAt:{gt:at}}}),
  findRepresentation: async (bucket: string, objectKey: string) => client.assetRepresentation.findFirst({ where: { state: 'READY', OR: [{bucket, objectKey}, {publicationBucket: bucket, publicationObjectKey: objectKey}] }, include: { asset: { include: { project, exhibition: true } } } }),
  findDeployment: async (bucket: string, objectKey: string) => client.webglDeployment.findFirst({ where: { state: 'READY', OR: [{publicBucket:bucket,entryObjectKey: objectKey}, {publicBucket:bucket,publicPrefix: objectKey.split('/').slice(0, 4).join('/')+'/'}, {stagingBucket:bucket,stagingEntryObjectKey:objectKey}] }, include: { project, sourceRepresentation:true } }),
  deployment: async (id: string) => client.webglDeployment.findUnique({ where: {id}, include: {project,sourceRepresentation:true} }),
  token: async (id: string) => client.fileAccessToken.findUnique({where: {id}}),
  createToken: async (data: {id: string; sessionId: string|null; bucket: string; objectKey: string; deploymentId: string|null; expiresAt: Date}) => client.fileAccessToken.create({data}),
  renew: async (id: string, expiresAt: Date) => client.fileAccessToken.update({where:{id},data:{expiresAt}}),
  session: async (id: string) => client.authSession.findUnique({where:{id}, include:{user:true}}),
 };
}

export function createUnavailableFileAccessRepository(): FileAccessRepository {
 const fail = async (): Promise<never> => { throw new Error('File access persistence unavailable'); };
 return {votePoster:fail,purgeExpired:fail,reusable:fail,activeCount:fail,findRepresentation:fail,findDeployment:fail,deployment:fail,token:fail,createToken:fail,renew:fail,session:fail};
}
