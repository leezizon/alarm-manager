# 알람 관리 (Alarm Manager)

시스템 운영 알람을 내부망에서 여러 사람이 함께 관리하는 웹 애플리케이션입니다.
**Node.js 14 내장 모듈만 사용**하며 npm 패키지나 별도 DB 설치가 필요 없습니다.

## 실행

```bash
node server.js
# 포트/데이터 위치 변경
PORT=8080 DATA_DIR=/srv/alarm-data node server.js
```

브라우저에서 `http://<서버 IP>:3000` 으로 접속합니다. 다른 PC에서 접속하려면 방화벽에서 포트를 열어야 합니다.

```bash
sudo ufw allow from 192.168.0.0/24 to any port 3000 proto tcp
```

## 기능

- **현황판**: 미처리 알람 목록, 인지 → 조치 시작 → 종료 처리, 처리자 기록
- **알람 정의**: 알람명 · 시스템 · 등급 · 임계치 · 담당자 · 조치 매뉴얼 관리
- **처리 완료 이력**: 처리시간, 단계별 이력
- **실시간 반영**: Server-Sent Events 로 모든 접속자 화면에 즉시 반영
- **중복 억제**: 같은 알람이 처리 중이면 새로 만들지 않고 발생 횟수만 증가

## 외부 시스템에서 알람 보내기

```bash
curl -X POST http://<서버 IP>:3000/api/events -H 'Content-Type: application/json' \
  -d '{"name":"CPU 사용률 높음","system":"결제 API","message":"CPU 95%"}'
```

## API

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/definitions` | 알람 정의 목록 |
| POST | `/api/definitions` | 정의 추가 |
| PUT | `/api/definitions/:id` | 정의 수정 (`version` 필수) |
| DELETE | `/api/definitions/:id?version=N` | 정의 삭제 |
| GET | `/api/events?status=active\|resolved\|all` | 알람 목록 |
| POST | `/api/events` | 알람 발생 (`definitionId` 또는 `name`) |
| POST | `/api/events/:id/transition` | 상태 변경 (`status`, `version`, `note`) |
| GET | `/api/stats` | 통계 |
| GET | `/api/stream` | 실시간 변경 알림 (SSE) |

처리자 이름은 `X-User` 헤더(URL 인코딩)로 전달합니다.

## 저장 구조와 동시쓰기

- 서버 프로세스 하나만 데이터를 쓰기 때문에(단일 writer) 동시 요청이 섞이지 않습니다.
- 변경은 `data/changes.log` 에 먼저 기록(fsync)한 뒤 메모리에 반영합니다.
- 1000건마다, 그리고 정상 종료 시 `data/snapshot.json` 으로 전체를 저장하고 로그를 비웁니다.
- 레코드마다 `version` 이 있어 동시에 같은 항목을 수정하면 한 명만 성공하고 나머지는 409 응답을 받습니다.
- 백업은 `data/` 폴더를 복사하면 됩니다.

## 테스트

```bash
node test/run-tests.js
```

동시 발생 200건, 동시 생성 100건, 동시 수정 충돌, 강제 종료 후 복구, 잘린 로그 복구를 검증합니다.
