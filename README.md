# 서술형 피드백 웹앱

학생이 서술형 답안을 사진으로 제출 → Gemini가 채점·피드백 → 교사 검토·공개 → 학생이 자기 방에서 확인·복습. 과목·학년 무관하게 사용 가능. Classroom 없이 웹앱 하나로 통합, 카드 없이 무료(Firebase Spark + Gemini 무료 등급).

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

## 빠른 시작
1. **Firebase 프로젝트 생성**(무료 Spark) → Authentication에서 **Google 로그인** 켜기 → **Firestore** 생성.
2. `cp public/config.example.js public/config.js` 후 `firebaseConfig`, `ALLOWED_DOMAIN`, `GEMINI_API_KEY` 를 본인 값으로 입력.
3. 서비스 계정 키 발급 → `serviceAccountKey.json`(로컬, 커밋 금지).
4. `cp .env.example .env` 후 `GEMINI_API_KEY` 입력. `cp .firebaserc.example .firebaserc` 후 프로젝트 ID 입력. `cp seed/admins.example.json seed/admins.json` 후 관리자 계정 입력.
5. `pip install -r requirements.txt`
6. 보안 규칙·시드 반영: `firebase deploy --only firestore:rules` → `python seed_import.py`
7. 배포: `firebase deploy --only hosting` (또는 GitHub Pages로 `public/` 서빙).
8. **관리자 설정**: 두 교사 계정으로 웹에 1회 로그인 → `python seed_import.py` 재실행 → 교사 계정 재로그인.

## 운영 루틴
학생 제출 → `python grade.py`(채점, 초안 저장) → 교사 화면에서 검토·공개 → 학생 확인.

## 데이터 상태
`submitted`(제출) → `graded`(채점됨, 학생 비공개) → `released`(공개, 학생 열람).
채점 초안은 학생이 못 읽는 `reviews/` 에 저장되고, **공개 시에만** 확정본이 `submissions/` 로 복사됨.

자세한 내용은 `docs/SETUP_AND_BUILD_GUIDE.md` 참고.

## 주의
- `serviceAccountKey.json`, `.env`, `.firebaserc`, `public/config.js`, `seed/roster.json`, `seed/admins.json` 은 커밋 금지(`.gitignore` 반영). 각자 `*.example` 파일을 복사해 본인 값으로 채울 것.
- 무료 등급 모델/한도는 수시로 바뀌므로 `.env` 의 `GEMINI_MODEL` 을 현재 가용 모델로 맞출 것.
- 학습지 제목은 코드와 동일(`4-1-1` 등). 바꾸려면 `seed/worksheets.json` 의 `title` 수정 후 재시드.
