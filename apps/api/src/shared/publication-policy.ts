import { publicationReadiness, type PublicationCommand, type PublicationSource } from '@pcu/contracts';
import { conflict, forbidden } from './errors.js';

export function assertPublication(source: PublicationSource, role: string, reason?: string) {
 const readiness = publicationReadiness(source, role);
 if (reason !== undefined && (role !== 'ADMIN' || !reason.trim())) throw forbidden('관리자만 사유를 기록하고 예외 공개할 수 있습니다.');
 if (!readiness.ready && !reason) throw conflict(`공개 조건을 확인하세요: ${readiness.blockers.join(', ')}`);
 return readiness;
}
export function assertPublicationVersion(actual: number, command: PublicationCommand) {
 if (actual !== command.expectedVersion) throw conflict('작품이 변경되었습니다. 최신 정보를 불러온 뒤 다시 제출하세요.');
}
export function assertPublicationNotWorsened(before: PublicationSource, after: PublicationSource) {
 const previous = publicationReadiness(before);
 const next = publicationReadiness(after);
 const lost = previous.requirements.filter(r => r.state === 'READY' && next.blockers.includes(r.key));
 if (lost.length) throw conflict('공개 중인 작품의 필수 자료를 제거할 수 없습니다. 교체 자료 처리를 완료하거나 먼저 비공개로 전환하세요.');
}
