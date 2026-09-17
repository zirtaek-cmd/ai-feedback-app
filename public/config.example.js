// 이 파일을 config.js 로 복사한 뒤 아래 값을 본인 것으로 채워주세요.
// (public/config.js 는 .gitignore 에 등록되어 있어 커밋되지 않습니다.)

// Firebase 콘솔 → 프로젝트 설정 → '내 앱'(웹)에서 복사한 값으로 교체하세요.
// 이 값들은 클라이언트 공개용이라 노출돼도 보안 문제가 아닙니다.
// (실제 접근 통제는 firestore.rules 가 담당합니다.)
export const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// 로그인 허용 학교 도메인 (학생용). 관리자는 도메인과 무관하게 클레임으로 통과.
export const ALLOWED_DOMAIN = "your-school-domain.example";

// 관리자 화면 "지금 채점하기" 버튼에서 브라우저가 직접 Gemini API를 호출할 때 사용.
// 주의: 이 키는 브라우저에 노출됩니다. Google AI Studio/Cloud Console에서
// 이 사이트 도메인으로 HTTP 리퍼러 제한을 걸어두는 걸 권장합니다.
export const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
export const GEMINI_MODEL = "gemini-2.5-flash";
