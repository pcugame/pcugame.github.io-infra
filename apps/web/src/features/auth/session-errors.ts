/** Frontend-only failures; these are not server API error codes. */
export class SessionNotEstablishedError extends Error {
  constructor() {
    super('로그인 상태를 유지하지 못했어요.');
    this.name = 'SessionNotEstablishedError';
  }
}

export class SessionVerificationError extends Error {
  constructor() {
    super('로그인 상태를 확인하지 못했어요. 네트워크 연결을 확인한 뒤 다시 시도해 주세요.');
    this.name = 'SessionVerificationError';
  }
}
