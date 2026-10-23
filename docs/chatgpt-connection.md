# ChatGPT 사용량 연결: 공식 지원 조건과 현재 앱의 상태

## 공식 문서로 확인한 내용

환경 재연결 후 아래 공식 문서를 실제 HTTP 200으로 열어 내용을 확인했습니다. 이전의 클라우드 프록시 접속 차단은 해소됐습니다.

- [Quickstart](https://developers.openai.com/siwc/quickstart): 적격 Plus·Pro 사용자는 참여 앱에서 ChatGPT plan usage를 사용할 수 있습니다. 일반 신원 로그인과 모델 호출 권한은 별개입니다.
- [Overview](https://developers.openai.com/siwc/token-sharing-open-source): 오픈소스·개인 실행용 흐름을 설명하며, 유료 또는 원격 호스팅 앱은 별도 interest form을 통한 조건 확인을 안내합니다.
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): 정상 로그인·동적 클라이언트 등록·동의·PKCE·nonce·state·ID 토큰 검증과 scope 확인을 요구합니다. 클라이언트 비밀 키나 일반 API 키는 필요하지 않은 공식 경로입니다.
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): 같은 계정 토큰으로 실제 모델 카탈로그를 조회하고 공개 Responses API에서 스트림의 response.completed까지 읽어야 합니다.
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): 선택 모델이 수용하면 이미지/파일 입력이 가능하지만 기능별 제약이 있습니다. store:false와 stream:true가 필수이고 max_output_tokens 등 일반 API와 다른 제한이 있습니다. 웹 검색은 모델·계정 정책에 따릅니다.
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms): 사용자 브라우저의 127.0.0.1 콜백은 원격 VM이 아니라 사용자 PC로 돌아갑니다. 동일한 개인/오픈소스 클라이언트에서 로컬 OAuth를 완료한 뒤 보호된 자격 증명을 SSH 같은 안전한 경로로 이전하는 절차를 설명합니다.

따라서 ‘Pro이면 일반 API 키 없이는 AI를 쓸 수 없다’고 단정하면 안 됩니다. 동시에 Pro 보유만으로 모든 원격 웹사이트가 자동 허용되는 것도 아닙니다.

## 현재 TRADIATIVE에 적용한 판단

- 서비스 주소는 GitHub Pages 정적 배포입니다. 이 주소에는 승인된 원격 SIWC 앱이나 인증·모델 호출 실행부가 연결돼 있지 않습니다.
- 공개 저장소는 확인했지만 저장소 자체의 오픈소스 라이선스는 지정돼 있지 않습니다. 공개만으로 적격 오픈소스 앱이라고 간주하지 않았으며 라이선스를 추가하거나 변경하지 않았습니다.
- 실제 사용자 로그인·워크스페이스 동의·모델 목록 조회·이미지 요청 완료를 하지 않았습니다. 사용자 계정이 거부됐다고 판단한 것이 아니라 이 앱에서 아직 검증하지 않은 상태입니다.
- 이 클라우드의 127.0.0.1 주소를 사용자 브라우저의 정상 콜백인 것처럼 제공하지 않습니다. 기존 ChatGPT/Codex 쿠키나 세션 토큰을 복사하라고 요청하지 않습니다.
- 사용자에게 별도 API 과금·결제·충전을 요청하거나 몰래 전환하지 않았습니다.

현재 원격 서비스에서 구독 사용량을 활성화하려면 적절한 원격 앱 승인과 안전한 인증 실행부가 필요합니다. 개인 실행/자체 VM 경로를 선택하는 경우에는 오픈소스·앱 자격과 사용자 PC의 공식 OAuth 절차를 먼저 확인해야 합니다. 라이선스 변경은 사용자의 별도 결정 대상입니다.

## 코드와 실제 검증의 경계

- `GET /api/ai/status`는 현재 미연결과 앱 승인·모델 권한 미검증을 반환합니다. 계정 모델 목록이나 남은 사용량을 꾸미지 않습니다.
- `POST /api/ai/login`과 `chatgpt-plan` 생성 요청은 이 앱의 인증이 준비되지 않았다는 구체적인 상태로 종료합니다. 다른 유료 경로로 전환하지 않습니다.
- 브라우저 이미지 추정은 별도 구현이며 외부 AI 요청 0회입니다. 실제 생성형 AI 검증으로 보고하지 않습니다.
- 별도 API 경로는 기본 OFF입니다. 명시적 서버 허용·서버 키·요청별 과금 동의·동일 기기 실행을 모두 요구합니다. 현재 웹 UI에서는 활성화하지 않습니다.
- 별도 API의 완료 JSON 검증 코드는 SIWC의 스트리밍 계약을 구현했다고 간주하지 않습니다. 향후 SIWC 어댑터는 response.completed, response.failed, response.incomplete, 스트림 중 한도 오류를 별도 처리해야 합니다.

현재 테스트의 AI 완료/거부/응답 중단 검사는 모의 응답입니다. 실제 ChatGPT 로그인·모델 호출의 증거가 아닙니다. 실제 연결을 완료하기 전에는 ‘ChatGPT 사용량으로 연결됨’이라고 표시하지 않습니다.
