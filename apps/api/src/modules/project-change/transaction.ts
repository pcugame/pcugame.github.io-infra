import { Prisma, type ProjectChangeRequest } from '../../generated/prisma/client.js';
import type { ProjectChangeValues } from '@pcu/contracts';
import { conflict, forbidden } from '../../shared/errors.js';
import { queueDurableDeletions, type DurableDeletionTarget } from '../orphan/outbox.js';
import { queueMultipartAbortTask } from '../multipart-abort/repository.js';
import { rewriteProjectVideoOrder } from '../assets/video-order.js';

export async function lockProject(tx: Prisma.TransactionClient, id: number) {
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "projects" WHERE "id" = ${id} FOR UPDATE`);
 return tx.project.findUnique({where:{id},include:{members:true,exhibition:true,changeRequestDraft:true}});
}
export function isOperator(actor:{role:string}) { return actor.role==='ADMIN'||actor.role==='OPERATOR'; }
export function isOwner(project:{creatorId:number;members:Array<{userId:number|null}>}, actorId:number) {return project.creatorId===actorId||project.members.some(member=>member.userId===actorId);}
export async function validateSource(tx:Prisma.TransactionClient, request:ProjectChangeRequest) {
 const project=request.projectId===null?null:await lockProject(tx,request.projectId);
 if(!project||project.version!==request.baseVersion||!isOwner(project,request.actorId))return null;
 return project;
}
async function removeAssets(tx:Prisma.TransactionClient,ids:number[],reason:string){
 if(!ids.length)return;
 const assets=await tx.asset.findMany({where:{id:{in:ids}},include:{representations:true}});
 const targets:DurableDeletionTarget[]=assets.flatMap(asset=>asset.representations.flatMap(rep=>[
 {bucket:rep.bucket,storageKey:rep.objectKey,reason},
 ...(rep.publicationBucket&&rep.publicationObjectKey?[{bucket:rep.publicationBucket,storageKey:rep.publicationObjectKey,reason}]:[]),
 ]));
 const deployments=await tx.webglDeployment.findMany({where:{sourceRepresentation:{assetId:{in:ids}}}});
 for(const deployment of deployments){targets.push({bucket:deployment.publicBucket,storageKey:deployment.publicPrefix,reason,targetKind:'PREFIX'});if(deployment.stagingBucket&&deployment.stagingPrefix)targets.push({bucket:deployment.stagingBucket,storageKey:deployment.stagingPrefix,reason,targetKind:'PREFIX'});}
 await queueDurableDeletions(tx,targets);
 await tx.webglDeployment.deleteMany({where:{id:{in:deployments.map(row=>row.id)}}});
 await tx.asset.deleteMany({where:{id:{in:ids}}});
}
export async function cleanupSourceChangeRequests(tx:Prisma.TransactionClient,projectId:number){
 const requests=await tx.projectChangeRequest.findMany({where:{projectId},orderBy:{stagingProjectId:'asc'}});
 for(const request of requests){
  if(request.stagingProjectId!==null)await deleteProjectInTransaction(tx,request.stagingProjectId);
  if(['DRAFT','PENDING','APPLYING','FAILED'].includes(request.state))await tx.projectChangeRequest.update({where:{id:request.id},data:{state:'CONFLICT',error:'Source project was deleted'}});
 }
}
export async function deleteProjectInTransaction(tx:Prisma.TransactionClient, projectId:number){
 await lockProject(tx,projectId);
 await cleanupSourceChangeRequests(tx,projectId);
 const stageRequest=await tx.projectChangeRequest.findUnique({where:{stagingProjectId:projectId}});
 if(stageRequest){const files=await tx.asset.findMany({where:{projectId,status:'READY'},select:{id:true,kind:true,originalName:true}});if(files.length)await tx.projectChangeRequest.update({where:{id:stageRequest.id},data:{fileSnapshot:files}});}
 const sessions=await tx.assetUploadSession.findMany({where:{projectId}});
 for(const session of sessions){
  if(session.uploadId&&session.state!=='READY')await queueMultipartAbortTask(tx,{bucket:session.bucket,storageKey:session.objectKey,uploadId:session.uploadId,reason:'change-request-delete',uploadSessionId:session.id});
 }
 await queueDurableDeletions(tx,sessions.map(session=>({bucket:session.bucket,storageKey:session.objectKey,reason:'change-request-delete-upload'})));
 const job=await tx.projectPublicationJob.findUnique({where:{projectId}});
 if(job){
  const {parseProjectPublicationPlan,publicationCleanupTargets}=await import('../project-publication/plan.js');
  await queueDurableDeletions(tx,publicationCleanupTargets(parseProjectPublicationPlan(job.plan)));
 }
 await tx.project.update({where:{id:projectId},data:{posterAssetId:null,currentWebglDeploymentId:null}});
 await tx.assetUploadSession.deleteMany({where:{projectId}});
 await removeAssets(tx,(await tx.asset.findMany({where:{projectId},select:{id:true}})).map(row=>row.id),'change-request-delete');
 await tx.project.delete({where:{id:projectId}});
}

export async function validateChanges(tx:Prisma.TransactionClient,request:ProjectChangeRequest){
 if(request.projectId===null)throw conflict('Project no longer exists');
 const changes=request.changes as ProjectChangeValues;
 const assets=await tx.asset.findMany({where:{projectId:request.projectId,status:'READY'}});
 const staged=request.stagingProjectId===null?[]:await tx.asset.findMany({where:{projectId:request.stagingProjectId,status:'READY'}});
 const remove=new Set(changes.removeAssetIds??[]);
 if([...remove].some(id=>!assets.some(asset=>asset.id===id)))throw forbidden('Removed asset must belong to this project');
 for(const kind of ['GAME','POSTER','WEBGL'] as const)if(staged.some(asset=>asset.kind===kind))for(const asset of assets.filter(asset=>asset.kind===kind))remove.add(asset.id);
 if(changes.removeWebgl)for(const asset of assets.filter(asset=>asset.kind==='WEBGL'))remove.add(asset.id);
 const remaining=[...assets.filter(asset=>!remove.has(asset.id)),...staged];
 if(remaining.filter(asset=>asset.kind==='VIDEO').length>5||remaining.filter(asset=>asset.kind==='DOCUMENT'||asset.kind==='ATTACHMENT').length>5)throw conflict('A project supports at most five videos and five materials');
 if(changes.posterAssetId!==undefined&&changes.posterAssetId!==null&&!remaining.some(asset=>asset.id===changes.posterAssetId&&(asset.kind==='POSTER'||asset.kind==='IMAGE')))throw forbidden('Poster must be an image belonging to this project');
 if(changes.videoAssetIds){const videos=remaining.filter(asset=>asset.kind==='VIDEO');if(changes.videoAssetIds.length!==videos.length||new Set(changes.videoAssetIds).size!==videos.length||changes.videoAssetIds.some(id=>!videos.some(asset=>asset.id===id)))throw conflict('Video order must contain every retained video exactly once');}
 return {changes,assets,staged,remove};
}
/** Called inside the publication commit: original references and request state move atomically. */
export async function applyProjectChange(tx:Prisma.TransactionClient,request:ProjectChangeRequest){
 const source=await validateSource(tx,request);if(!source)throw conflict('Source project changed or requester lost access');
 if(request.kind==='DELETE'){
  await deleteProjectInTransaction(tx,source.id);
 }else{
  const {changes,staged,remove}=await validateChanges(tx,request);
  const stage=request.stagingProjectId===null?null:await tx.project.findUnique({where:{id:request.stagingProjectId}});
  const newPoster=staged.find(asset=>asset.kind==='POSTER')?.id;
  const poster=changes.posterAssetId!==undefined?changes.posterAssetId:newPoster??(source.posterAssetId!==null&&remove.has(source.posterAssetId)?null:source.posterAssetId);
  if(stage)await tx.project.update({where:{id:stage.id},data:{posterAssetId:null,currentWebglDeploymentId:null}});
  await tx.project.update({where:{id:source.id},data:{posterAssetId:null,...(changes.removeWebgl||stage?.currentWebglDeploymentId?{currentWebglDeploymentId:null}:{})}});
  await removeAssets(tx,[...remove],'change-request-replaced');
  if(stage){await tx.asset.updateMany({where:{projectId:stage.id},data:{projectId:source.id,videoSortOrder:null}});await tx.webglDeployment.updateMany({where:{projectId:stage.id},data:{projectId:source.id}});}
  if(changes.members){
   const users=await tx.user.findMany({where:{studentId:{in:changes.members.map(member=>member.studentId).filter(Boolean)}},select:{id:true,studentId:true}});
   await tx.projectMember.deleteMany({where:{projectId:source.id}});
   await tx.projectMember.createMany({data:changes.members.map((member,sortOrder)=>({...member,sortOrder,projectId:source.id,userId:users.find(user=>user.studentId===member.studentId)?.id??null}))});
  }
  await tx.project.update({where:{id:source.id},data:{
   ...(changes.title!==undefined?{title:changes.title}:{}),...(changes.summary!==undefined?{summary:changes.summary}:{}),...(changes.description!==undefined?{description:changes.description}:{}),...(changes.githubUrl!==undefined?{githubUrl:changes.githubUrl}:{}),...(changes.platforms?{platforms:changes.platforms}:{}),posterAssetId:poster,
   ...(stage?.currentWebglDeploymentId?{currentWebglDeploymentId:stage.currentWebglDeploymentId}:{}),version:{increment:1},
  }});
  const videos=await tx.asset.findMany({where:{projectId:source.id,kind:'VIDEO',status:'READY'},orderBy:[{videoSortOrder:{sort:'asc',nulls:'last'}},{id:'asc'}],select:{id:true}});
  await rewriteProjectVideoOrder(tx,source.id,changes.videoAssetIds??videos.map(video=>video.id));
 }
 await tx.projectChangeRequest.update({where:{id:request.id},data:{state:'COMPLETED',completedAt:new Date(),error:null}});
}
