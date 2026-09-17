import { auth } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { login, logout, resolveAccess } from "./auth.js";
import { renderStudent } from "./student.js";
import { renderTeacher } from "./teacher.js";

const views = {
  login: document.getElementById("view-login"),
  loading: document.getElementById("view-loading"),
  app: document.getElementById("view-app"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
}

function showError(msg) {
  const box = document.getElementById("login-error");
  box.textContent = msg || "";
  box.classList.toggle("hidden", !msg);
}

document.getElementById("loginBtn").addEventListener("click", () => {
  showError("");
  login().catch((e) => showError("로그인에 실패했습니다: " + e.message));
});

document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "logoutBtn") logout();
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { showView("login"); return; }
  showView("loading");
  try {
    const access = await resolveAccess(user);
    if (access.role === "admin") {
      setHeader(access.email, "교사");
      showView("app");
      await renderTeacher(access);
    } else if (access.role === "student") {
      const p = access.profile || {};
      setHeader(`${p.class}-${p.number} · ${access.email}`, "학생");
      showView("app");
      await renderStudent(access);
    } else {
      await logout();
      showView("login");
      showError("등록되지 않은 계정입니다. 담당 선생님께 문의하세요.");
    }
  } catch (e) {
    await logout();
    showView("login");
    showError("접근 확인 중 오류가 발생했습니다: " + e.message);
  }
});

function setHeader(who, role) {
  document.getElementById("who").textContent = who;
  document.getElementById("role").textContent = role;
}
