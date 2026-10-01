import { enrichExternalLinks } from '../external-links/resolver.js';
import { CreateProjectChangeSchema, UpdateProjectChangeSchema, RejectProjectChangeSchema } from '@pcu/contracts';
import { forbidden, conflict } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import type { ChangeActor, ChangeListOptions, ProjectChangeRepository } from './ports.js';
export function createProjectChangeService(repository: ProjectChangeRepository, resolveLinks = enrichExternalLinks) {
 return {
 list:(actor:ChangeActor,options:ChangeListOptions={})=>repository.list(actor,options),
 detail:(actor:ChangeActor,id:string)=>repository.detail(actor,id),
 create:(actor:ChangeActor,projectId:number,input:unknown)=>repository.create(actor,projectId,parseBody(CreateProjectChangeSchema,input)),
 async update(actor:ChangeActor,id:string,input:unknown) {
  const parsed = parseBody(UpdateProjectChangeSchema,input);
  if (parsed.changes?.externalLinks !== undefined) {
   const detail = await repository.detail(actor,id);
   if(detail.actorId!==actor.id)throw forbidden('Only the request author may edit a draft');
   if(detail.state!=='DRAFT')throw conflict('Only a draft request may be edited');
   parsed.changes.externalLinks = await resolveLinks(parsed.changes.externalLinks);
  }
  return repository.update(actor,id,parsed);
 },
 submit:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'submit'),
 cancel:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'cancel'),
 approve:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'approve'),
 reject:(actor:ChangeActor,id:string,reviewReason:unknown)=>repository.transition(actor,id,'reject',parseBody(RejectProjectChangeSchema,{reason:reviewReason}).reason),
 retry:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'retry'),
 };
}
