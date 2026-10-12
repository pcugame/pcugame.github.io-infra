/** Guidance only. Every selected, editable rule follows the ordinary approval workflow. */
export interface ConnectionProfile {
 readonly id: string;
 readonly title: string;
 readonly guide: string;
 readonly documentation: string;
 readonly examples: readonly string[];
}
export const CONNECTION_PROFILES: readonly ConnectionProfile[] = Object.freeze([
 { id: 'photon', title: 'Photon PUN / Fusion',
  guide: '네임서버 이후 매칭·게임 서버가 바뀔 수 있습니다. SDK에서 사용하는 호스트와 포트를 확인하고 필요한 항목만 선택하세요. Fusion의 Web 지원과 게임 모드도 확인하세요.',
  documentation: 'https://doc.photonengine.com/fusion/v2/manual/network-project-config',
  examples: ['wss://*.photonengine.io', 'wss://*.photonengine.io:19090', 'wss://*.photonengine.io:19091', 'wss://*.photonengine.io:19093'] },
 { id: 'relay', title: 'Unity Netcode + Relay',
  guide: '인증·할당 HTTPS와 실제 Relay WSS를 각각 신청하세요. 아래 예시를 실제 SDK 연결 주소로 바꾸고 Unity Transport의 UseWebSockets와 wss 설정을 확인하세요.',
  documentation: 'https://docs.unity.com/en-us/mps-sdk/tutorials/relay-and-ngo',
  examples: ['https://authentication.example.com', 'https://allocation.example.com', 'wss://relay.example.com'] },
 { id: 'socket', title: 'Mirror / 자체 WSS',
  guide: '예시를 실제 공개 WSS 주소·포트로 바꾸세요. 인증서, WebSocket handshake의 Origin 검사와 서비스 인증을 확인하세요.',
  documentation: 'https://mirror-networking.gitbook.io/docs/manual/transports/websockets-transport',
  examples: ['wss://game.example.com:8443'] },
 { id: 'https', title: 'HTTP API / Addressables',
  guide: '예시를 실제 HTTPS 주소로 바꾸세요. API·카탈로그·번들·리디렉션 목적지를 각각 확인하고 외부 서버에서 게임 origin의 CORS를 허용하세요.',
  documentation: 'https://docs.unity3d.com/6000.0/Documentation/Manual/webgl-networking.html',
  examples: ['https://api.example.com', 'https://assets.example.com'] },
].map(profile => Object.freeze({ ...profile, examples: Object.freeze(profile.examples) })));
