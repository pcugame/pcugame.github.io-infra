/** Stable, actionable copy for current validation limits; does not widen codec support. */
export function videoErrorMessage(message: string): string {
 if (/stream layout|audio.*stream|multiple.*audio/i.test(message)) return '지원하지 않는 영상·오디오 트랙 구성입니다. 영상 트랙 1개와 오디오 트랙 최대 1개로 다시 내보낸 파일을 선택하세요.';
 if (/codec|CODEC_UNSUPPORTED/i.test(message)) return '지원하지 않는 영상 또는 오디오 코덱입니다. H.264 영상·AAC 오디오의 MP4 파일로 변환한 뒤 교체하세요.';
 if (/dimensions|duration|frame rate|bitrate|RESOURCE_LIMIT/i.test(message)) return '영상의 해상도·길이·프레임률 또는 비트레이트가 처리 한도를 넘었습니다. 파일을 줄여 다시 선택하세요.';
 if (/magic|container|CONTAINER_INVALID/i.test(message)) return '영상 파일 형식을 확인하지 못했습니다. 파일 확장자만 바꾸지 말고 원본 편집 도구에서 MP4로 다시 내보내세요.';
 if (/timeout|timed out/i.test(message)) return '영상 처리 시간이 초과되었습니다. 다시 시도하거나 크기를 줄인 파일로 교체하세요.';
 if (/decode|corrupt|invalid data/i.test(message)) return '영상 파일을 읽지 못했습니다. 로컬에서 재생되는지 확인하고 다시 내보낸 파일로 교체하세요.';
 return message;
}
