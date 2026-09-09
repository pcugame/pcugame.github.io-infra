import { CreateProjectChangeSchema, UpdateProjectChangeSchema, RejectProjectChangeSchema } from '@pcu/contracts';
import { parseBody } from '../../shared/validation.js';
import type { ChangeActor, ChangeListOptions, ProjectChangeRepository } from './ports.js';
export function createProjectChangeService(repository: ProjectChangeRepository) {
 return {
 list:(actor:ChangeActor,options:ChangeListOptions={})=>repository.list(actor,options),
 detail:(actor:ChangeActor,id:string)=>repository.detail(actor,id),
 create:(actor:ChangeActor,projectId:number,input:unknown)=>repository.create(actor,projectId,parseBody(CreateProjectChangeSchema,input)),
 update:(actor:ChangeActor,id:string,input:unknown)=>repository.update(actor,id,parseBody(UpdateProjectChangeSchema,input)),
 submit:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'submit'),
 cancel:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'cancel'),
 approve:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'approve'),
 reject:(actor:ChangeActor,id:string,reviewReason:unknown)=>repository.transition(actor,id,'reject',parseBody(RejectProjectChangeSchema,{reason:reviewReason}).reason),
 retry:(actor:ChangeActor,id:string)=>repository.transition(actor,id,'retry'),
 };
}
