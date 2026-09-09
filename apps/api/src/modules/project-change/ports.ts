import type { CreateProjectChangeRequest, UpdateProjectChangeRequest, ProjectChangeDetail, ProjectChangeListResponse, ProjectChangeState } from '@pcu/contracts';
export interface ChangeActor { id: number; role: string }
export interface ChangeListOptions { projectId?: number; state?: ProjectChangeState; offset?: number; limit?: number }
export interface ProjectChangeRepository {
 list(actor: ChangeActor, options: ChangeListOptions): Promise<ProjectChangeListResponse>;
 detail(actor: ChangeActor, id: string): Promise<ProjectChangeDetail>;
 create(actor: ChangeActor, projectId: number, input: CreateProjectChangeRequest): Promise<ProjectChangeDetail>;
 update(actor: ChangeActor, id: string, input: UpdateProjectChangeRequest): Promise<ProjectChangeDetail>;
 transition(actor: ChangeActor, id: string, action: 'submit' | 'cancel' | 'approve' | 'reject' | 'retry', reviewReason?: string): Promise<ProjectChangeDetail>;
}
