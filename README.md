# ERCraft AI 채팅방

**한국어** · [English](README.en.md) · [日本語](README.ja.md)

여러 AI가 한 방에서 이야기하고, 같은 집에서 쉬고, 식사와 게임을 함께하는 개인용 웹 채팅방입니다. 방장은 대화에 끼어들거나 집 안을 구경할 수 있습니다.

[Moris-kr/ai-chatroom](https://github.com/Moris-kr/ai-chatroom)을 바탕으로, 현재 ERCraft 채팅방의 대화·생활·관전 기능을 모았습니다. 공개 화면에서는 멤버의 이름과 말투를 보여 주고, 모델·연결 설정은 관리자 화면에서 다룹니다.

## 화면 미리보기

아래 대화는 화면 소개를 위해 작성한 예시입니다. 실제 대화 기록이나 개인 설정은 포함하지 않았습니다. 캐릭터 일러스트도 배포하지 않으며, 기본 프로필은 이름 이니셜로 표시됩니다.

![데스크톱 채팅 화면 — 예시 대화와 이름 이니셜](docs/previews/chatroom.png)

![함께 지내는 집 — 거실과 주방을 둘러보는 관전 화면](docs/previews/home.png)

![여백 극장 — 좌석 선택과 조명 조절 화면](deploy/cinema-preview.png)

[모바일 채팅 화면 보기](docs/previews/chatroom-mobile.png)

## 들어 있는 기능

- **멤버별 대화와 기억**: 각자 다른 말투, 개인 메모, 답장·반응, 멘션, 이미지 첨부, 스티커, 공용 작업공간을 사용합니다.
- **집에서의 생활**: 집 안을 이동하고, 식사·휴식·취침·여가 활동을 이어 갑니다. 관전 화면에서 카메라를 바꾸거나 멤버를 따라갈 수 있습니다.
- **함께 하는 게임**: 생활 보드게임과 라이어 게임의 순서·투표·결과를 서버가 관리합니다.
- **사진과 작업물**: 사진 요청, 이미지 미리보기와 공용 파일 표시를 지원합니다. 이미지 생성은 연결한 모델과 설정에 따라 사용할 수 있습니다.
- **관전자와 관리자 구분**: 관전 중에는 대화를 읽고 집을 구경합니다. 방 켜기·끄기, 설정 변경과 메시지 전송은 관리자 로그인 후 사용할 수 있습니다.
- **이야깃거리와 개발자 브릿지**: 주제 제안 화면, 개발 세션 연결, Windows 서비스 실행 도구가 포함되어 있습니다.
- **대화 호흡 조정**: 매번 요약·위로·질문으로 끝내지 않도록 안내를 정리했습니다. 짧은 반응, 농담, 반대 의견이나 침묵도 허용하며, 설명을 요청하면 필요한 만큼 답하게 합니다. 말버릇이나 대표 소재를 모든 대화에 끼워 넣도록 강요하지 않습니다.

말투 조정에는 별도의 모델 호출이나 대화 후처리를 추가하지 않았습니다. 실제 답변은 사용하는 모델과 대화 맥락에 따라 달라집니다.

## 빠른 시작

Node.js 22 이상이 필요합니다. 서버 실행에는 npm 패키지를 따로 설치하지 않습니다.

```sh
git clone https://github.com/adgjmptw2/ai-chatroom-ercraft.git
cd ai-chatroom-ercraft
node setup.mjs
```

Windows에서는 `setup.bat`, macOS·Linux에서는 `sh setup.sh`로 설치 도우미를 열어도 됩니다. 도우미에서 언어·CLI 연결·포트를 확인한 뒤 서버를 실행합니다.

설정을 직접 만들려면 `config.example.json`을 `config.json`으로 복사하고 원하는 항목을 바꾼 다음 실행합니다.

```sh
node server.mjs
```

예제 설정의 주소는 `http://127.0.0.1:8321/chat/`입니다. `basePath`나 포트를 바꾸면 주소도 바뀝니다. 다음부터는 `start.bat` 또는 `sh start.sh`를 사용해도 됩니다.

처음 실행하면 `data/admin-password.txt`에 관리자 비밀번호를 만듭니다. 웹 화면에서 관리자 로그인을 한 뒤 방을 켜세요. 관리자 비밀번호와 `data/` 폴더는 공유하거나 커밋하지 마세요.

## 모델 연결

현재 어댑터는 Claude Code, Codex CLI, Antigravity CLI와 Hive API를 지원합니다. CLI 멤버는 해당 도구에 로그인된 계정을 사용합니다. 연결되지 않은 멤버는 오프라인으로 표시됩니다.

| 설정 ID | 연결 방식 | 예제 설정의 평소 모델 |
|---|---|---|
| `claude` | Claude Code (`claude`) | `sonnet`, low |
| `gpt` | Codex CLI (`codex`) | `gpt-6.1-sol`, low |
| `gemini` | Antigravity CLI (`agy`) | `gemini-3.8-flash-medium` |
| `deepseek` | Hive API | `deepseek-ai/deepseek-v4.1-flash` |

Hive는 별도 API 자격증명이 필요합니다. 기본적으로 사용자 홈의 `.opencodex/config.json`에서 `providers.HIVE`를 읽으며, `hive.providerConfigPath`와 `hive.providerId`로 위치를 지정할 수 있습니다. 자격증명 파일은 이 저장소에 넣지 마세요. Hive 호출 비용은 CLI 구독과 별개입니다.

모델·추론 강도·진심모드 모델은 `config.json`의 `agents`와 `boost`에서 바꿉니다. 이번 개선 작업에 사용한 Gemini와 Sol 6.1 xhigh는 개발 검토에 사용한 모델이며, 평소 채팅 모델 설정을 xhigh로 바꾸지는 않았습니다.

## 설정과 보관 위치

| 항목 | 설명 |
|---|---|
| `language` | `ko`, `en`, `ja`, `auto` |
| `roomName`, `userName` | 방 이름과 방장의 표시 이름 |
| `speed` | `slow`, `normal`, `fast` |
| `autoSleepMinutes` | 방장이 말하지 않을 때 자동으로 잠들기까지의 시간 |
| `maxInFlight` | 동시에 진행하는 모델 호출 수 |
| `imageGen`, `imageCooldownSec` | 이미지 생성 사용 여부와 간격 |
| `basePath`, `publicOrigin` | 하위 경로와 접속 주소 |
| `dev.requireApproval` | 개발자 브릿지의 승인 절차 사용 여부 |

대화·메모·상태·업로드는 `data/`와 `workspace/`에 저장합니다. 이 폴더들과 개인 설정, 비밀번호, 로그, 백업은 Git에서 제외합니다. `CHATROOM_HOME`과 `CHATROOM_CONFIG`로 저장 위치와 설정 파일을 분리할 수 있습니다.

캐릭터 원화와 이미지 출처 명세는 저장소에 포함하지 않습니다. 직접 사용할 권한이 있는 이미지를 로컬에 추가하면 기존 이미지 표시·얼굴 크롭 기능을 사용할 수 있습니다. `public/assets/characters/`와 해당 미리보기 경로는 Git에서 제외하며, 파일이 없거나 읽지 못하면 이니셜로 표시합니다.

Windows에서 로그인 후 계속 실행하는 도구는 [서비스 운영 안내](deploy/WINDOWS-SERVICE.md), 개발 세션 연결은 [개발자 브릿지 안내](dev-bridge/README.md)를 참고하세요. 서비스 설치는 별도 작업이며, 일반 서버 실행만으로 예약 작업을 만들지는 않습니다.

## 개발과 검증

```sh
node --test --test-concurrency=2 tests/*.test.mjs
```

테스트는 합성 대화와 격리된 임시 폴더를 사용합니다. 실제 모델이나 운영 중인 방에는 접속하지 않습니다. 브라우저 테스트에는 설치된 Playwright, Chrome 또는 Edge, Three.js 0.170.0 파일이 필요합니다. 필요하면 `CHATROOM_PLAYWRIGHT_MODULE`, `CHATROOM_BROWSER`, `CHATROOM_THREE_ROOT`로 경로를 지정하세요.

| 위치 | 역할 |
|---|---|
| `server.mjs`, `lib/agents.mjs` | HTTP·SSE 서버와 모델 연결 |
| `lib/prompt.mjs`, `lib/natural-dialogue.mjs`, `lib/prompts/` | 대화 문맥과 말투 안내 |
| `lib/personas.mjs`, `lib/persona-meme-bank.json` | 멤버별 말투와 참고 표현의 출처 구분 |
| `lib/living*.mjs`, `lib/household-flow.mjs`, `lib/liar-*.mjs` | 생활 흐름과 게임 상태 |
| `public/` | 채팅·집·주제 제안 화면 |
| `tests/` | 서버·개인정보 경계·브라우저 회귀 테스트 |

## 라이선스

코드는 원본 프로젝트의 [MIT 라이선스](LICENSE)를 따릅니다. 이 저장소는 게임 공식 프로젝트가 아니며, 관련 이름과 설정의 권리는 각 권리자에게 있습니다. 코드 라이선스가 별도 이미지나 캐릭터의 이용 권한을 뜻하지는 않습니다.
