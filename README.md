# 서술형 피드백 웹앱

학생이 서술형 답안을 사진으로 제출 → Gemini가 채점·피드백 → 교사 검토·공개 → 학생이 자기 방에서 확인·복습. 과목·학년 무관하게 사용 가능. Classroom 없이 웹앱 하나로 통합, 카드 없이 무료(Firebase Spark + Gemini 무료 등급).

> **선생님이 이 저장소를 처음 가져오셨다면** 터미널 명령어 없이 Wrks 코딩 에이전트로 배포하는 [배포 가이드](https://claude.ai/artifact/RyU73DEMpdtvjCVgvqhq8h)를 따라가세요. 아래 내용은 직접 명령어로 배포할 때 참고하는 기술 문서입니다.

## 폴더 구조
```
public/            웹앱 (Firebase Hosting)
  index.html       로그인 + 라우팅
  config.js        ← firebaseConfig 입력 (콘솔에서 복사)
  css/styles.css
  js/              firebase-init / auth / compress / student / teacher / main
firestore.rules    보안 규칙
firestore.indexes.json
firebase.json      호스팅+규칙 설정
grade.py           채점 스크립트 (교사가 실행)
seed_import.py     시드 업로드 + 관리자 클레임 설정
seed/              roster.json / worksheets.json / admins.json
requirements.txt   파이썬 의존성
.env.example       → .env 로 복사해 Gemini 키 입력
docs/              상세 설계안 + 빌드 가이드
```

## 수동 배포 (참고용 — Windows/PowerShell 기준)
Wrks 에이전트 없이 직접 명령어로 배포할 때만 필요합니다.

**사전 설치**
- [Git for Windows](https://git-scm.com/download/win)
- [Node.js LTS](https://nodejs.org) 설치 후 `npm install -g firebase-tools`
- [Python](https://www.python.org/downloads/) 설치 시 **"Add python.exe to PATH" 체크 필수**

**단계**
1. **Firebase 프로젝트 생성**(무료 Spark) → Authentication에서 **Google 로그인** 켜기 → **Firestore** 생성.
2. `Copy-Item public/config.example.js public/config.js` 후 `firebaseConfig`, `ALLOWED_DOMAIN`, `GEMINI_API_KEY` 를 본인 값으로 입력.
3. 서비스 계정 키 발급 → `serviceAccountKey.json`(로컬, 커밋 금지).
4. `Copy-Item .env.example .env` 후 `GEMINI_API_KEY` 입력. `Copy-Item .firebaserc.example .firebaserc` 후 프로젝트 ID 입력. `Copy-Item seed/admins.example.json seed/admins.json` 후 관리자 계정 입력. `Copy-Item seed/roster.example.json seed/roster.json` 후 우리 반 학생 명단(이메일/학년/반/번호)으로 채우기.
5. `pip install -r requirements.txt` (실행 안 되면 `py -m pip install -r requirements.txt`)
6. 보안 규칙·시드 반영: `firebase deploy --only firestore:rules` → `python seed_import.py`
7. 배포: `firebase deploy --only hosting`
8. **관리자 설정**: `seed/admins.json`에 등록한 계정으로 웹에 1회 로그인 → `python seed_import.py` 재실행 → 재로그인.

## 운영 루틴
학생 제출 → GitHub Actions 가 10분마다 `grade.py` 실행(채점) → 문제없는 건은 바로 학생에게 공개,
"확인 필요" 건만 교사 화면에서 검토·공개 → 학생 확인. 교사 페이지를 열어 둘 필요가 없다.

## 자동 채점 (GitHub Actions) 설정
`.github/workflows/grade.yml` 이 10분마다 `grade.py` 를 돌린다. 한 번만 설정하면 된다.

1. **Firestore 전용 서비스 계정 만들기** — Google Cloud 콘솔 → IAM 및 관리자 → 서비스 계정 → 만들기.
   역할은 `Cloud Datastore 사용자` 하나만 준다(프로젝트 전체 권한인 기본 키를 쓰지 말 것).
   키 → 새 키 만들기(JSON) 로 내려받는다.
2. **저장소 Secrets 등록** — GitHub 저장소 Settings → Secrets and variables → Actions → New repository secret
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: 1번에서 받은 JSON 파일 내용 전체를 그대로 붙여 넣기
   - `GEMINI_API_KEY`: Google AI Studio 키
3. **(선택) Variables** — 같은 화면의 Variables 탭. 없으면 기본값을 쓴다.
   `GEMINI_MODEL`(기본 gemini-3.5-flash-lite), `AUTO_RELEASE`(`0` 이면 전부 교사 검토 대기), `THROTTLE_SEC`(기본 5)
4. **저장소 Actions 설정** — Settings → Actions → General: "Allow all actions" 그대로, Fork pull request workflows 는
   "Require approval for all outside collaborators" 로. 협업자는 본인 계정만 둔다.
5. Actions 탭 → grade → "Run workflow" 로 한 번 수동 실행해 초록불을 확인한다.

주의
- 공개 저장소의 Actions 로그는 누구나 볼 수 있다. `grade.py` 는 학생 이메일·점수·답안을 출력하지 않는다. 이 원칙을 지킬 것.
- 저장소에 60일간 커밋이 없으면 GitHub 이 예약 실행을 자동으로 끈다(방학 뒤 Actions 탭에서 다시 켜기).
- 예약 실행은 혼잡 시 지연될 수 있다. "제출 즉시"가 아니라 "10~20분 안에" 점수가 나온다고 안내할 것.
- 브라우저의 Gemini 키(`public/config.js`)는 학생용 "AI 서술형 채점기"와 참고자료 PDF 요약이 아직 쓴다.
  Google Cloud 콘솔에서 이 키에 HTTP 리퍼러 제한(배포 도메인만)과 API 제한(Generative Language API만)을 걸어 둘 것.

## 데이터 상태
`submitted`(제출·재채점 대기) → `released`(공개, 학생 열람). 확인이 필요한 건만 `graded`(채점됨, 학생 비공개)에 머문다.
채점 실패는 `error`(교사 화면에서 "다시 채점"). 채점 초안은 학생이 못 읽는 `reviews/` 에 저장되고, **공개 시에만** 확정본이 `submissions/` 로 복사됨.

자세한 내용은 `docs/SETUP_AND_BUILD_GUIDE.md` 참고.

## 주의
- `serviceAccountKey.json`, `.env`, `.firebaserc`, `public/config.js`, `seed/roster.json`, `seed/admins.json` 은 커밋 금지(`.gitignore` 반영). 각자 `*.example` 파일을 복사해 본인 값으로 채울 것.
- `seed/roster.json`은 예시 템플릿(`seed/roster.example.json`)만 제공됩니다 — 실제 학생 명단은 본인 학교 것으로 직접 작성해야 합니다.
- 무료 등급 모델/한도는 수시로 바뀌므로 `.env` 의 `GEMINI_MODEL` 을 현재 가용 모델로 맞출 것.
- 학습지 제목은 코드와 동일(`4-1-1` 등). 바꾸려면 `seed/worksheets.json` 의 `title` 수정 후 재시드.
