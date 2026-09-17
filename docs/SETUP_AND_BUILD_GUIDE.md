# 빌드 가이드 (Claude Code용) — AI 서술형 피드백 웹앱

이 문서는 **선생님 PC의 Claude Code**가 이 프로젝트를 만들고 배포하는 데 쓰는 실행 가이드입니다.
배경·설계 근거는 `AI서술형피드백_웹앱_1단계_설계안.md` 를 함께 참고하세요.

## 스택 (확정)
- 프론트: **바닐라 HTML/CSS/JS + Firebase JS SDK (v10 모듈, CDN)** — 빌드 과정 없음
- 폰트: **Pretendard**, 깔끔한 한글 레이아웃
- 백엔드 채점: **Python** (`firebase-admin` + `google-genai`) = `grade.py`
- 저장: **Cloud Firestore** (이미지 포함 전부, 무료 Spark)
- 호스팅: **Firebase Hosting** (또는 GitHub Pages)
- 카드/유료 서비스 사용 안 함 (Cloud Functions·Storage 미사용)

## 동봉 파일
```
firestore.rules        # 보안 규칙 (그대로 배포)
grade.py               # 채점 스크립트 (교사가 실행)
seed_import.py         # 시드 업로드 + 관리자 클레임 설정
requirements.txt       # 파이썬 의존성
.gitignore
seed/
  roster.json          # 학생 107명 (이메일→학년/반/번호)
  worksheets.json      # 학습지 9개 (4-1-1 … 5-1-3)
  admins.json          # 관리자 2명
```
> `roster.json / worksheets.json / admins.json` 을 `seed/` 폴더에 넣으세요.

## 최종 파일 구조 (목표)
```
project/
  public/
    index.html         # 로그인 + 라우팅(학생/교사 분기)
    student.html       # 학생 화면 (SPA로 통합해도 됨)
    teacher.html       # 교사 검토 화면
    config.js          # firebaseConfig (콘솔에서 복사)
    app.js, auth.js, compress.js, styles.css 등
  firestore.rules
  firestore.indexes.json
  grade.py
  seed_import.py
  seed/ ...
  requirements.txt
  .env               # GEMINI_API_KEY (gitignore)
  serviceAccountKey.json  # (gitignore)
```

---

## A. 셋업 체크리스트 (한 번만)

1. **Firebase 프로젝트 생성** — [console.firebase.google.com](https://console.firebase.google.com) → 프로젝트 추가 (무료 Spark 유지, 카드 불필요).
2. **Authentication → Google 로그인 사용 설정.**
3. **Firestore Database 생성** (프로덕션 모드).
4. **웹 앱 등록** → `firebaseConfig` 복사 → `public/config.js` 에 저장. (이 값은 공개용이라 노출돼도 무방)
5. **서비스 계정 키 발급** — 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성 → `serviceAccountKey.json` 로 저장(로컬, **절대 커밋 금지**).
6. **Gemini 무료 API 키** — [aistudio.google.com](https://aistudio.google.com) → API key → `.env` 에 `GEMINI_API_KEY=...`.
7. `pip install -r requirements.txt`
8. **보안 규칙 배포** — `firestore.rules` 를 `firebase deploy --only firestore:rules` (또는 콘솔에 붙여넣기).
9. **시드 넣기** — `python seed_import.py` (roster·worksheets 등록. 관리자 클레임은 아래 10번 이후 재실행).
10. **관리자 최초 로그인** — `seed/admins.json`에 등록한 교사 계정(예: `teacher1@example.com`, `teacher2@example.com`)으로 웹에 1회 로그인 → 다시 `python seed_import.py` 실행하면 admin 클레임 부여됨 → 교사 계정 재로그인.
11. **배포** — `firebase deploy` (hosting + rules) 또는 GitHub Pages.

## B. 운영 루틴 (반복)
1. 학생들이 웹에서 제출.
2. 교사가 `python grade.py` 실행 → 밀린 제출물 채점(초안은 `reviews/`), 요약·"확인 필요" 건수 출력.
3. 교사가 웹 교사 화면에서 검토·수정 → **공개**.
4. 학생이 자기 방에서 점수·피드백 확인 / 과거 회차 복습.

---

## C. 로그인·입장 규칙 (auth.js에서 구현)
로그인 성공 후 다음을 만족해야 입장:
- **학생**: 이메일이 `config.js`의 `ALLOWED_DOMAIN` **이고** `roster/{email}` 문서가 존재.
- **관리자**: 토큰 클레임 `admin == true` (도메인 무관 — `seed/admins.json`에 등록된 계정이 여기 해당).
- 둘 다 아니면 "등록되지 않은 계정" 안내 후 로그아웃.
- 관리자면 교사 화면, 아니면 학생 화면으로 라우팅.

## D. 학생 화면 스펙 (student.html)
와이어프레임 기반. **가운데·오른쪽 배치는 가시성 위주로 자유롭게** 구성.

- **왼쪽 사이드바**: `worksheets` 를 `unit`→`order` 로 묶어 표시(단원 헤더 + 학습지 목록). 각 학습지 옆 상태 배지:
  - `미제출` / `⏳ 채점·검토 중`(submitted·graded) / `✅ 완료`(released)
  - 상태는 로그인 학생의 `submissions`(본인 것)에서 해당 worksheetId 최신 회차로 판단.
- **메인 영역** (선택한 학습지 기준):
  - **미제출**: 업로드 영역 크게 — 사진 선택/촬영(여러 장), 미리보기, [제출] 버튼.
  - **제출~공개 전**: 업로드한 이미지 표시 + "채점 검토 중" 안내. **점수·피드백은 표시하지 않음**(데이터에도 아직 없음).
  - **공개 후**: 위=업로드 이미지(클릭 확대), 아래=채점 카드(총점 + 항목별 점수 4개 + 피드백 전문).
- **재제출**: 공개 전까지 가능하되 **최대 3회(최초+재제출 2회)**. 초과 시 버튼 비활성 + 안내. (아래 F 참고)
- **복습 동선**: 과거 학습지를 사이드바에서 눌러 사진·점수·피드백 재열람.

## E. 교사 화면 스펙 (teacher.html)
- **검토 대기 목록**: `submissions.status == "graded"` 조회. 각 항목의 초안은 `reviews/{id}` 에서 읽음.
  **`reviewFlag == true`(확인 필요) 건을 맨 위로 정렬.**
- **개별 검토**: 학생 이미지(pages) + 초안(총점·항목별·피드백)을 나란히. 점수·피드백 **수정 가능**.
- **공개 처리**(핵심): 확정된 `grade`·`feedback` 을 `submissions/{id}` 에 기록하고
  `status = "released"`, `releasedAt` 설정. (이때부터 학생이 읽을 수 있음)
  - 개별 공개 + 선택 일괄 공개 둘 다 지원.
- 반/학습지 필터가 있으면 편함(선택).

## F. 데이터 상태 흐름
```
[학생 제출] status=submitted            (pages에 이미지, grade/feedback 없음)
   ↓ grade.py
[채점됨]   status=graded               (reviews/{id}에 초안, 학생은 못 봄)
   ↓ 교사 '공개'
[공개됨]   status=released             (submissions/{id}에 grade·feedback 복사 → 학생 열람)
```
- **공개 전 점수 은닉**은 데이터 위치로 보장: 초안은 학생이 못 읽는 `reviews/`, 공개 시에만 `submissions/` 로 확정본 복사.

## G. 재제출 2회 제한 처리
- 제출 시 `attempt` 필드 기록(1,2,3). 같은 (학생,worksheet)에서 최대 3회.
- **1차 방어(앱)**: 제출 전 본인 `submissions`에서 해당 worksheet 회차 수를 세어 3회 이상이면 차단.
- 보안 규칙에서는 교차사용자 격리를 강제하고 있고, 회차 상한은 본인 방 안의 일이라 앱단 통제로 충분(하드 상한이 꼭 필요하면 `attempts/{uid}_{worksheetId}` 카운터 문서 + 규칙으로 확장 — 2단계).

## H. 이미지 압축 스펙 (compress.js)
- 제출 전 브라우저 `<canvas>` 로 리사이즈+JPEG 압축 → **장당 300~500KB** 목표(글씨 판독 가능).
- dataURL(base64)로 인코딩 → `submissions/{id}/pages/{pageId}` 에 `{ imageBase64, order, studentUid }` 로 1장=1문서 저장(각 1MiB 미만 유지).

## I. 데이터 모델 요약 (필드)
```
roster/{email}                : { grade, class, number }
worksheets/{code}             : { unit, code, title, order, active }
submissions/{id}              : { studentUid, studentEmail, worksheetId, status,
                                  attempt, submittedAt, gradedAt, releasedAt,
                                  grade?, feedback? }        # grade/feedback은 공개 시에만
submissions/{id}/pages/{pid}  : { imageBase64, order, studentUid }
reviews/{id}(=submission id)  : { total, concept, logic, evidence, expression,
                                  feedback, reviewFlag, reviewReason }
```
채점 항목별 배점: concept 40 / logic 25 / evidence 20 / expression 15 (합 100).

## J. Claude Code 프론트엔드 빌드 순서(권장)
1. `config.js` + Firebase 초기화 + Google 로그인 + 입장 규칙(C) + 라우팅.
2. 학생 화면: 사이드바(worksheets) → 업로드/압축(H)/제출(상태 submitted, pages 저장).
3. `grade.py` 로 채점 → `reviews` 채워지는지 확인.
4. 교사 화면(E): 검토 목록 → 수정 → 공개(status=released, 확정본 복사).
5. 학생 화면 공개 표시 + 과거 회차 복습.
6. `firestore.rules` 배포 후 학생 계정으로 **남의 문서 접근이 막히는지** 반드시 확인.

## K. 주의
- `serviceAccountKey.json`, `.env`, `seed/roster.json` 은 커밋 금지(`.gitignore` 반영됨).
- 무료 등급 모델/한도는 변동됨 → `grade.py` 의 `GEMINI_MODEL` 을 현재 무료 가용 모델로 지정, `THROTTLE_SEC` 로 분당 한도(RPM 10~15) 대응.
- 학습지 제목은 현재 코드와 동일(예: `4-1-1`). 추후 `worksheets.title` 만 바꾸면 됨.
