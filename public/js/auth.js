import { auth, db } from "./firebase-init.js";
import {
  GoogleAuthProvider, signInWithPopup, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { ALLOWED_DOMAIN } from "../config.js";

export function login() {
  const provider = new GoogleAuthProvider();
  return signInWithPopup(auth, provider);
}

export function logout() {
  return signOut(auth);
}

// 로그인한 사용자의 접근 권한 판정.
// return: { role: "admin" | "student" | null, email, uid, profile? }
export async function resolveAccess(user) {
  const email = user.email || "";
  const token = await user.getIdTokenResult();

  // 관리자: admin 커스텀 클레임 (도메인 무관)
  if (token.claims.admin === true) {
    return { role: "admin", email, uid: user.uid };
  }

  // 학생: 학교 도메인 + 명단(roster) 등록
  if (email.endsWith("@" + ALLOWED_DOMAIN)) {
    const snap = await getDoc(doc(db, "roster", email));
    if (snap.exists()) {
      return { role: "student", email, uid: user.uid, profile: snap.data() };
    }
  }

  return { role: null, email, uid: user.uid };
}
