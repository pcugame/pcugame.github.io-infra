import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type ProjectChangeRequest } from '../../generated/prisma/client.js';
import type { ProjectChangeDetail, ProjectChangeSummary, ProjectChangeValues, ProjectChangeManifestItem } from '@pcu/contracts';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import type { ChangeActor, ProjectChangeRepository } from './ports.js';
import { applyProjectChange, deleteProjectInTransaction, isOperator, isOwner, lockProject, validateChanges, validateSource } from './transaction.js';
import { rebuildProjectPublicationPlan } from '../project-publication/plan-builder.js';

const activeStates=['DRAFT','PENDING','APPLYING','FAILED'] as const;
function summary(row:ProjectChangeRequest):ProjectChangeSummary {
 return {id:row.id,projectId:row.projectId,originalProjectId:row.originalProjectId,projectTitle:row.projectTitle,actorId:row.actorId,kind:row.kind,state:row.state,baseVersion:row.baseVersion,reason:row.reason,reviewReason:row.reviewReason,reviewerId:row.reviewerId,error:row.error,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),submittedAt:row.submittedAt?.toISOString()??null,reviewedAt:row.reviewedAt?.toISOString()??null,completedAt:row.completedAt?.toISOString()??null};
}
function validateManifest(items:ProjectChangeManifestItem[]){
 if(new Set(items.map(item=>item.slot)).size!==items.length||new Set(items.map(item=>item.clientToken)).size!==items.length)throw conflict('Manifest slots and client tokens must be unique');
 for(const kind of ['GAME','WEBGL','POSTER'] as const)if(items.filter(item=>item.kind===kind).length>1)throw conflict(`Only one ${kind} upload is permitted per request`);
 for(const kind of ['GAME','WEBGL','POSTER'] as const)if(items.some(item=>item.kind===kind&&item.slot!==kind.toLowerCase()))throw conflict('Upload slot does not match its kind');
 const images=items.filter(item=>item.kind==='IMAGE');if(images.some((item,index)=>item.slot!==`image:${index}`))throw conflict('Image slots must be consecutive from zero');
 for(const kind of ['VIDEO','DOCUMENT','ATTACHMENT'] as const){const matches=items.filter(item=>item.kind===kind);if(matches.length>5||matches.some((item,index)=>item.slot!==`${kind.toLowerCase()}:${index}`))throw conflict(`${kind} slots must be consecutive from zero`);}
 if(items.filter(item=>item.kind==='DOCUMENT'||item.kind==='ATTACHMENT').length>5)throw conflict('At most five materials are supported');
}
async function readDetail(tx:Prisma.TransactionClient,actor:ChangeActor,id:string):Promise<ProjectChangeDetail>{
 const row=await tx.projectChangeRequest.findUnique({where:{id},include:{project:{include:{members:true}},stagingProject:{include:{submission:{include:{items:{include:{uploadSession:true}}}},assets:{where:{status:'READY'}}}}}});
 if(!row)throw notFound('Change request not found');
 if(!isOperator(actor)&&row.actorId!==actor.id&&(!row.project||!isOwner(row.project,actor.id)))throw forbidden();
 const stage=row.stagingProject;
 const storedFiles=(Array.isArray(row.fileSnapshot)?row.fileSnapshot:[]) as Array<{id:number;kind:string;originalName:string}>;
 const visibleFiles=stage?.assets.length?stage.assets:storedFiles;
 return {...summary(row),before:row.before as unknown as ProjectChangeDetail['before'],changes:row.changes as ProjectChangeValues,stagingProjectId:row.stagingProjectId,submissionId:stage?.submission?.id??null,items:stage?.submission?.items.map(item=>({id:item.id,kind:item.kind,slot:item.slot,clientToken:item.clientToken,required:true,state:item.state,...(item.uploadSession?{sessionId:item.uploadSession.id,generation:item.uploadSession.generation}:{}),...(item.failureReason?{failureReason:item.failureReason}:{}),...(item.playbackState!=='NONE'?{playbackState:item.playbackState}:{}),...(item.playbackError?{playbackError:item.playbackError}:{})}))??[],stagedAssets:visibleFiles.map(asset=>({id:asset.id,kind:asset.kind,originalName:asset.originalName,previewUrl:['REJECTED','CANCELLED','CONFLICT'].includes(row.state)?'':`/api/assets/${asset.id}/download`}))};
}
async function lockedRequest(tx:Prisma.TransactionClient,id:string){
 // Always lock original before staging/request; direct mutations share the original lock.
 const initial=await tx.projectChangeRequest.findUnique({where:{id}});if(!initial)throw notFound('Change request not found');
 if(initial.projectId!==null)await lockProject(tx,initial.projectId);
 if(initial.stagingProjectId!==null)await lockProject(tx,initial.stagingProjectId);
 await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "project_change_requests" WHERE "id"=${id} FOR UPDATE`);
 return tx.projectChangeRequest.findUniqueOrThrow({where:{id}});
}
async function discardStage(tx:Prisma.TransactionClient,row:ProjectChangeRequest){if(row.stagingProjectId!==null)await deleteProjectInTransaction(tx,row.stagingProjectId);}
async function ready(tx:Prisma.TransactionClient,row:ProjectChangeRequest){
 await validateChanges(tx,row);
 if(row.stagingProjectId===null)return;
 const submission=await tx.projectSubmission.findUniqueOrThrow({where:{projectId:row.stagingProjectId},include:{items:{include:{uploadSession:true}}}});
 if(submission.items.some(item=>item.state!=='READY'||item.uploadSession?.state!=='READY'||item.boundGeneration!==item.uploadSession.generation||item.kind==='VIDEO'&&item.playbackState==='NONE'))throw conflict('Every selected file must finish processing before submission');
 // Rebuilding checks generation, result ownership, representations and WebGL manifests.
 await rebuildProjectPublicationPlan(tx,{projectId:row.stagingProjectId,submissionId:submission.id});
}
async function startApplication(tx:Prisma.TransactionClient,row:ProjectChangeRequest,reviewerId:number){
 if(!await validateSource(tx,row)){
  await discardStage(tx,row);await tx.projectChangeRequest.update({where:{id:row.id},data:{state:'CONFLICT',error:'Project changed or requester no longer has access'}});return;
 }
 await ready(tx,row);
 if(row.stagingProjectId===null){await applyProjectChange(tx,row);await tx.projectChangeRequest.update({where:{id:row.id},data:{reviewerId,reviewedAt:new Date()}});return;}
 const submission=await tx.projectSubmission.findUniqueOrThrow({where:{projectId:row.stagingProjectId}});
 const plan=await rebuildProjectPublicationPlan(tx,{projectId:row.stagingProjectId,submissionId:submission.id});
 await tx.projectPublicationJob.upsert({where:{projectId:row.stagingProjectId},create:{projectId:row.stagingProjectId,submissionId:submission.id,plan:plan as unknown as Prisma.InputJsonValue},update:{state:'PENDING',plan:plan as unknown as Prisma.InputJsonValue,claimToken:null,claimUntil:null,lastError:null}});
 await tx.projectSubmission.update({where:{id:submission.id},data:{state:'FINALIZING'}});
 await tx.projectChangeRequest.update({where:{id:row.id},data:{state:'APPLYING',reviewerId,reviewedAt:row.reviewedAt??new Date(),error:null}});
}
export function createProjectChangeRepository(client:PrismaClient):ProjectChangeRepository {
 const transaction=<T>(run:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>=>withAssetMutationTransaction(client,run);

 return {
  async list(actor,options){
   const where:Prisma.ProjectChangeRequestWhereInput={...(options.projectId?{originalProjectId:options.projectId}:{}),...(options.state?{state:options.state}:{}),...(!isOperator(actor)?{OR:[{actorId:actor.id},{project:{OR:[{creatorId:actor.id},{members:{some:{userId:actor.id}}}]}}]}:{})};
   if(options.projectId&&!isOperator(actor)){const project=await client.project.findUnique({where:{id:options.projectId},include:{members:true}});if(project&&!isOwner(project,actor.id))throw forbidden();}
   const [rows,total]=await Promise.all([client.projectChangeRequest.findMany({where,orderBy:{createdAt:'desc'},skip:Math.max(0,options.offset??0),take:Math.min(100,Math.max(1,options.limit??50))}),client.projectChangeRequest.count({where})]);return {items:rows.map(summary),total};
  },
  detail:(actor,id)=>readDetail(client,actor,id),
  async create(actor,projectId,input){
   return transaction(async tx=>{
    const project=await lockProject(tx,projectId);if(!project||project.changeRequestDraft)throw notFound('Project not found');
    if(!isOwner(project,actor.id))throw forbidden('Only the creator or linked team members may request changes');
    if(project.exhibition.isModificationEnabled)throw conflict('This exhibition allows direct changes');
    if(project.status==='DRAFT')throw conflict('Initial submissions cannot request changes');
    if(await tx.projectChangeRequest.findFirst({where:{projectId,state:{in:[...activeStates]}}}))throw conflict('This project already has an active change request');
    const assets=await tx.asset.findMany({where:{projectId,status:'READY'},select:{id:true,kind:true,originalName:true}});
    const before={title:project.title,summary:project.summary,description:project.description,githubUrl:project.githubUrl,platforms:project.platforms,members:project.members.map(member=>({name:member.name,studentId:member.studentId})),posterAssetId:project.posterAssetId,assets,currentWebglDeploymentId:project.currentWebglDeploymentId};
    const row=await tx.projectChangeRequest.create({data:{projectId,originalProjectId:projectId,projectTitle:project.title,actorId:actor.id,kind:input.kind,baseVersion:project.version,before:before,changes:{},reason:input.reason}});
    return readDetail(tx,actor,row.id);
   });
  },
  async update(actor,id,input){return transaction(async tx=>{
   let row=await lockedRequest(tx,id);if(row.actorId!==actor.id)throw forbidden('Only the request author may edit a draft');if(row.state!=='DRAFT')throw conflict('Only a draft request may be edited');
   if(!await validateSource(tx,row))throw conflict('Project changed or requester no longer has access');
   if(row.kind==='DELETE'&&(input.changes||input.manifest))throw conflict('A deletion request cannot contain edits');
   if(input.manifest){
    validateManifest(input.manifest);
    if(row.stagingProjectId!==null)await discardStage(tx,row);
    if(input.manifest.length){
     const source=await tx.project.findUniqueOrThrow({where:{id:row.projectId!}});
     const stage=await tx.project.create({data:{exhibitionId:source.exhibitionId,slug:`change-${randomUUID()}`,title:source.title,status:'DRAFT',creatorId:actor.id,submission:{create:{actorId:actor.id,items:{create:input.manifest}}}}});
     row=await tx.projectChangeRequest.update({where:{id},data:{stagingProjectId:stage.id}});
    }
   }
   await tx.projectChangeRequest.update({where:{id},data:{...(input.manifest?{fileSnapshot:[]}:{}),...(input.reason!==undefined?{reason:input.reason}:{}),...(input.changes?{changes:input.changes as Prisma.InputJsonValue}:{})}});
   return readDetail(tx,actor,id);
  });},
  async transition(actor,id,action,reviewReason){return transaction(async tx=>{
   const row=await lockedRequest(tx,id);
   if(['approve','reject','retry'].includes(action)){if(!isOperator(actor))throw forbidden('Operator approval is required');}else if(row.actorId!==actor.id)throw forbidden('Only the request author may submit or cancel');
   if(action==='submit'){
    if(row.state!=='DRAFT')throw conflict('Only a draft request can be submitted');
    if(!await validateSource(tx,row))throw conflict('Project changed or requester no longer has access');
    await ready(tx,row);
    const files=row.stagingProjectId===null?[]:await tx.asset.findMany({where:{projectId:row.stagingProjectId,status:'READY'},select:{id:true,kind:true,originalName:true}});
    await tx.projectChangeRequest.update({where:{id},data:{state:'PENDING',submittedAt:new Date(),fileSnapshot:files}});
   }else if(action==='cancel'||action==='reject'){
    if(!(action==='cancel'?['DRAFT','PENDING']:['PENDING']).includes(row.state))throw conflict('Request can no longer be cancelled or rejected');
    await discardStage(tx,row);
    await tx.projectChangeRequest.update({where:{id},data:{state:action==='cancel'?'CANCELLED':'REJECTED',...(action==='reject'?{reviewerId:actor.id,reviewReason,reviewedAt:new Date()}:{})}});
   }else{
    if(action==='approve'&&row.state==='COMPLETED')return readDetail(tx,actor,id);
    if(row.state!==(action==='retry'?'FAILED':'PENDING'))throw conflict('Request is not awaiting this action');
    await startApplication(tx,row,action==='retry'?row.reviewerId??actor.id:actor.id);
   }
   return readDetail(tx,actor,id);
  });},
 };
}
