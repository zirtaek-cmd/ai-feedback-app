import { db } from "./firebase-init.js";
import {
  collection, doc, query, where, orderBy, getDocs, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { gradeImages, gradeText, summarizeReference } from "./grade.js";
import { wireLightboxImages } from "./lightbox.js";

const THROTTLE_MS = 4000; // 무료 등급 RPM 대응

// 서버(GitHub Actions, grade.py)가 채점하는 시간대. grade.py 의 ACTIVE_WINDOW / ACTIVE_WINDOW_WEEKEND
// 와 같은 값이어야 한다. 이 시간에는 교사 화면을 열어 둬도 브라우저가 스스로 채점을 시작하지
// 않는다(서버와 같은 건을 두 번 채점하거나, 서버가 공개한 걸 되돌리는 일을 막기 위해).
// "지금 채점하기" 버튼은 시간과 무관하게 언제나 동작한다.
const SERVER_WINDOW_WEEKDAY = [[16, 30], [2, 0]]; // 월~금 16:30 ~ 다음 날 02:00
const SERVER_WINDOW_WEEKEND = [[9, 0], [2, 0]];   // 토·일 09:00 ~ 다음 날 02:00

function inServerWindow(now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes();
  const win = (d) => (d.getDay() === 0 || d.getDay() === 6) ? SERVER_WINDOW_WEEKEND : SERVER_WINDOW_WEEKDAY;
  const mins = ([h, m]) => h * 60 + m;
  const [s1, e1] = win(now).map(mins);                           // 오늘 구간
  if (s1 <= e1 ? (t >= s1 && t < e1) : t >= s1) return true;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const [s2, e2] = win(yesterday).map(mins);                     // 어제 구간이 자정을 넘긴 꼬리
  return s2 > e2 && t < e2;
}

// 채점 초안(reviews) 문서 키. 제출물 ID로 키를 잡으면 학생이 재제출할 때마다
// (새 제출물 = 새 ID) 이전 초안이 짝을 잃고 영구히 남는다. 학생+학습지로 키를 잡으면
// 재제출해도 같은 문서를 덮어쓰므로 문서 수가 (학생 수 x 학습지 수)로 고정된다.
function reviewKey(sub) {
  return `${sub.studentUid}_${sub.worksheetId}`;
}

let state = { items: [], selected: null, tab: "review" };
let unsubscribeItems = null;
let isGrading = false;
let rosterMap = {};        // studentEmail -> { class, number, excluded? }
let worksheetOrderMap = {}; // worksheetId  -> order
let worksheetTitleMap = {}; // worksheetId  -> title (목록의 학습지 그룹 제목)
// 목록에서 교사가 펼쳐 둔 학습지 그룹("반|학습지코드"). 기본은 접힘이고, 스냅샷이 올 때마다
// 목록을 다시 그리므로 DOM 의 open 상태 대신 여기에 기억해 둔다.
const expandedGroups = new Set();
// 반 구역은 기본으로 펼쳐 두고, 교사가 접은 반("1", "2", "미확인")만 여기에 기억한다.
const collapsedClasses = new Set();
// 반 안의 단원 구역("반|단원번호")도 기본은 접힘이고, 교사가 펼친 것만 기억한다.
const expandedChapters = new Set();

// 학습지 코드 앞 숫자가 단원이다("4-1-1" → "4", "5-2-3" → "5"). 숫자로 안 시작하면 "기타".
function unitOf(wsId) {
  const m = /^(\d+)/.exec(String(wsId));
  return m ? m[1] : "기타";
}

// 목록 정렬·그룹핑(반별 구역, 학습지 번호순)에 쓸 명단/학습지 순서를 불러온다.
// 명단 107명 + 학습지 9개라 탭을 옮길 때마다 다시 읽으면 116회씩 읽기가 쌓인다.
// 그래서 짧게 캐시하되, 결과가 비어 있으면(실패·권한 문제 등) 캐시하지 않고 다음에
// 다시 시도한다 — 한 번 실패하면 영영 빈 채로 굳던 예전 방식의 재발 방지.
const ROSTER_TTL_MS = 5 * 60 * 1000;
let rosterLoadedAt = 0;

async function loadRosterAndWorksheets() {
  const fresh = rosterLoadedAt && (Date.now() - rosterLoadedAt) < ROSTER_TTL_MS;
  if (fresh && Object.keys(rosterMap).length && Object.keys(worksheetOrderMap).length) return;

  const [rosterSnap, wsSnap] = await Promise.all([
    getDocs(collection(db, "roster")),
    getDocs(collection(db, "worksheets")),
  ]);
  rosterMap = {};
  rosterSnap.docs.forEach((d) => { rosterMap[d.id] = d.data(); });
  worksheetOrderMap = {};
  worksheetTitleMap = {};
  wsSnap.docs.forEach((d) => {
    worksheetOrderMap[d.id] = d.data().order ?? 0;
    worksheetTitleMap[d.id] = d.data().title || "";
  });
  rosterLoadedAt = (rosterSnap.size && wsSnap.size) ? Date.now() : 0;
}

export async function renderTeacher(access) {
  const root = document.getElementById("app-root");
  root.innerHTML = `
    <div class="tabs">
      <button class="tab active" id="tabReview">제출물 검토</button>
      <button class="tab" id="tabWorksheets">학습지 문제 관리</button>
      <button class="tab" id="tabRoster">학생 명단</button>
    </div>
    <div id="t-body"></div>`;
  document.getElementById("tabReview").addEventListener("click", () => switchTab("review"));
  document.getElementById("tabWorksheets").addEventListener("click", () => switchTab("worksheets"));
  document.getElementById("tabRoster").addEventListener("click", () => switchTab("roster"));
  await switchTab("review");
}

async function switchTab(tab) {
  document.getElementById("tabReview").classList.toggle("active", tab === "review");
  document.getElementById("tabWorksheets").classList.toggle("active", tab === "worksheets");
  document.getElementById("tabRoster").classList.toggle("active", tab === "roster");
  const body = document.getElementById("t-body");
  state.tab = tab;
  state.selected = null;
  if (tab === "review") {
    body.innerHTML = `
      <div class="grade-bar">
        <button class="btn primary" id="gradeBtn">지금 채점하기</button>
        <span class="muted small" id="gradeStatus"></span>
        <span class="muted small">평일 16:30~02:00, 주말 09:00~02:00에는 서버가 5분마다 자동으로 채점을 완료합니다(확인 필요 건은 검토 대기).</span>
      </div>
      <div class="layout">
        <aside class="sidebar" id="t-list"></aside>
        <main class="main" id="t-main"><p class="muted center">왼쪽에서 검토할 제출물을 선택하세요.</p></main>
      </div>`;
    document.getElementById("gradeBtn").addEventListener("click", runGrading);
    // 이미 구독 중이면 끊었다 다시 붙이지 않는다(재구독은 목록 전체를 다시 읽어올 수 있어 비싸다).
    if (unsubscribeItems) renderList();
    else startListening();
  } else if (tab === "worksheets") {
    stopListening();
    await renderWorksheetAdmin(body);
  } else {
    stopListening();
    await renderRosterAdmin(body);
  }
}

function stopListening() {
  if (unsubscribeItems) { unsubscribeItems(); unsubscribeItems = null; }
}

// 제출물 목록을 실시간 구독한다 — 학생이 제출/취소하거나 채점 상태가 바뀌면
// 새로고침 없이 자동으로 목록에 반영된다.
function startListening() {
  stopListening();
  // 명단/학습지 로딩과 제출물 구독을 동시에 시작한다(순서대로 기다리지 않아 더 빠름).
  // 명단 로딩이 실패해도 목록 자체는 떠야 하므로 실패를 여기서 삼킨다.
  const rosterReady = loadRosterAndWorksheets().catch((e) => {
    console.error("[명단/학습지 순서 로드 실패]", e);
  });
  unsubscribeItems = onSnapshot(collection(db, "submissions"), async (snap) => {
    await rosterReady;
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => !s.archived);

    // (학생,학습지)별 최신 회차만 남김
    const latest = {};
    items.forEach((s) => {
      const k = s.studentEmail + "|" + s.worksheetId;
      if (!latest[k] || (s.attempt || 0) > (latest[k].attempt || 0)) latest[k] = s;
    });
    items = Object.values(latest);

    // 채점 초안(reviews)은 여기서 읽지 않는다. 예전에는 목록을 그릴 때마다 전 항목의
    // reviews 를 한 건씩 조회했는데(N+1), 제출물이 늘면 스냅샷이 한 번 올 때마다
    // 그 수만큼 읽기가 발생해 무료 등급 하루 한도를 수업 한 타임에 소진한다.
    // 목록에 필요한 "확인 필요" 배지는 submissions.reviewFlag 로 대신하고,
    // 초안 원본은 항목을 선택했을 때 한 건만 읽는다(selectItem).
    // 반별 구역으로 묶고, 구역 안에서는 학습지 번호순 → 학생 번호순으로 정렬한다.
    items.sort((a, b) => {
      const ca = rosterMap[a.studentEmail]?.class ?? 999;
      const cb = rosterMap[b.studentEmail]?.class ?? 999;
      if (ca !== cb) return ca - cb;
      const oa = worksheetOrderMap[a.worksheetId] ?? 999;
      const ob = worksheetOrderMap[b.worksheetId] ?? 999;
      if (oa !== ob) return oa - ob;
      const na = rosterMap[a.studentEmail]?.number ?? 999;
      const nb = rosterMap[b.studentEmail]?.number ?? 999;
      return na - nb;
    });
    state.items = items;
    renderList();

    if (isGrading) return;

    // 새로 제출된(=아직 채점 전인) 건이 있으면 버튼을 누른 것처럼 자동 채점한다.
    // 관리자 화면이 열려 있는 동안만, 그리고 서버가 채점하지 않는 시간에만 동작한다.
    if (inServerWindow()) return;
    if (items.some((it) => it.status === "submitted")) runGrading();
  });
}

async function renderWorksheetAdmin(root) {
  const snap = await getDocs(query(collection(db, "worksheets"), orderBy("order")));
  const worksheets = snap.docs.map((d) => d.data());

  root.innerHTML = `<div class="ws-admin">
      <h2>학습지 문제 관리</h2>
      <p class="muted small">여기 입력한 문제 내용은 학생 화면에 표시되고, 텍스트 답안 채점에 사용됩니다.</p>

      <section class="card">
        <h3>AI 서술형 채점기 관리</h3>
        <p class="muted small">학생들이 "AI 서술형 채점기"에 올린 사진과 채점 결과를 한 번에 정리합니다
          (평소엔 10분 후 자동 삭제되지만, 지금 바로 전부 지우고 싶을 때 사용하세요).</p>
        <button class="btn ghost" id="deleteFreeformBtn">AI 서술형 채점기 자료 전체 삭제</button>
      </section>

      <section class="card">
        <h3>남은 채점 기록 정리</h3>
        <p class="muted small">학생이 재제출하거나 제출을 취소하면 그 제출물의 채점 기록만 남습니다.
          지워진 제출물의 채점 기록을 찾아서 정리합니다(현재 제출물에는 영향 없음).</p>
        <button class="btn ghost" id="cleanupReviewsBtn">남은 채점 기록 정리</button>
      </section>

      <div class="ws-grid">
      ${worksheets.map((w) => `
        <section class="card">
          <h3>${escapeHtml(String(w.unit))}단원 · ${escapeHtml(w.title || w.code)}</h3>

          <label class="fb-label">문제</label>
          <textarea data-code="${w.code}" data-field="problem" rows="6" placeholder="문제 내용을 입력하세요">${escapeHtml(w.problem || "")}</textarea>
          <button class="btn primary" data-save="${w.code}" data-field="problem">저장</button>

          <label class="fb-label" style="margin-top:16px">참고자료 (채점 기준 — 교과서 핵심 개념 요약)</label>
          <p class="muted small">교과서 PDF를 올리면 Gemini가 핵심 개념을 한 번 요약해서 저장해두고,
            이후 채점부터는 이 요약 텍스트를 기준으로 판단합니다(PDF는 매번 다시 보내지 않음).</p>
          <textarea data-code="${w.code}" data-field="referenceMaterial" rows="8" placeholder="PDF를 올려 요약을 생성하거나, 직접 입력하세요">${escapeHtml(w.referenceMaterial || "")}</textarea>
          <div class="ref-actions">
            <button class="btn primary" data-save="${w.code}" data-field="referenceMaterial">저장</button>
            <button class="btn ghost" data-upload="${w.code}">PDF로 요약 생성</button>
            <input type="file" accept="application/pdf" data-pdf="${w.code}" hidden>
            <span class="muted small" data-status="${w.code}"></span>
          </div>
        </section>`).join("")}
      </div>
    </div>`;

  root.querySelectorAll("[data-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { save: code, field } = btn.dataset;
      const textarea = root.querySelector(`textarea[data-code="${code}"][data-field="${field}"]`);
      btn.disabled = true;
      btn.textContent = "저장 중…";
      try {
        await updateDoc(doc(db, "worksheets", code), { [field]: textarea.value });
        btn.textContent = "저장됨";
        setTimeout(() => { btn.textContent = "저장"; btn.disabled = false; }, 1200);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "저장";
        alert("저장에 실패했습니다: " + e.message);
      }
    });
  });

  root.querySelectorAll("[data-upload]").forEach((btn) => {
    const code = btn.dataset.upload;
    const fileInput = root.querySelector(`input[data-pdf="${code}"]`);
    const statusEl = root.querySelector(`[data-status="${code}"]`);
    btn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;
      btn.disabled = true;
      statusEl.textContent = "PDF 요약 생성 중… (시간이 좀 걸릴 수 있어요)";
      try {
        const base64 = await fileToBase64(file);
        const summary = await summarizeReference(base64);
        await updateDoc(doc(db, "worksheets", code), { referenceMaterial: summary });
        const textarea = root.querySelector(`textarea[data-code="${code}"][data-field="referenceMaterial"]`);
        textarea.value = summary;
        statusEl.textContent = "요약 생성 완료, 저장했습니다.";
      } catch (e) {
        statusEl.textContent = "요약 생성 실패: " + e.message;
      } finally {
        btn.disabled = false;
        fileInput.value = "";
      }
    });
  });

  document.getElementById("deleteFreeformBtn").addEventListener("click", deleteAllFreeform);
  document.getElementById("cleanupReviewsBtn").addEventListener("click", cleanupOrphanReviews);
}

// 대응하는 제출물이 없는 채점 기록(reviews)을 찾아 정리한다.
// 키를 학생+학습지로 바꾼 뒤로는 재제출해도 기록이 쌓이지 않으므로, 이제는 제출물을
// 완전히 지운 경우(학생의 제출 취소, 교사의 삭제)에만 가끔 남는다.
async function cleanupOrphanReviews() {
  const btn = document.getElementById("cleanupReviewsBtn");
  btn.disabled = true;
  btn.textContent = "확인 중…";
  try {
    const [revSnap, subSnap] = await Promise.all([
      getDocs(collection(db, "reviews")),
      getDocs(collection(db, "submissions")),
    ]);
    // 현재 제출물이 쓰는 키(학생+학습지) 집합과 비교한다. 예전 방식(제출물 ID)으로
    // 남아있는 기록도 여기서 같이 걸러진다.
    const liveKeys = new Set(subSnap.docs.map((d) => reviewKey(d.data())));
    const orphans = revSnap.docs.filter((d) => !liveKeys.has(d.id));
    if (!orphans.length) {
      btn.textContent = "정리할 기록 없음";
      setTimeout(() => { btn.textContent = "남은 채점 기록 정리"; btn.disabled = false; }, 2000);
      return;
    }
    if (!confirm(`지워진 제출물의 채점 기록 ${orphans.length}건을 정리할까요?\n현재 제출물의 채점 결과는 그대로 유지됩니다.`)) {
      btn.textContent = "남은 채점 기록 정리";
      btn.disabled = false;
      return;
    }
    btn.textContent = "정리 중…";
    for (const d of orphans) await deleteDoc(doc(db, "reviews", d.id));
    btn.textContent = `정리 완료 (${orphans.length}건)`;
    setTimeout(() => { btn.textContent = "남은 채점 기록 정리"; btn.disabled = false; }, 2500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "남은 채점 기록 정리";
    alert("정리에 실패했습니다: " + e.message);
  }
}

async function deleteAllFreeform() {
  if (!confirm(`"AI 서술형 채점기"에 학생들이 올린 모든 사진과 채점 결과를 전부 삭제할까요?\n되돌릴 수 없습니다.`)) return;
  const btn = document.getElementById("deleteFreeformBtn");
  btn.disabled = true;
  btn.textContent = "삭제 중…";
  try {
    const snap = await getDocs(collection(db, "freeformSubmissions"));
    for (const d of snap.docs) {
      const pagesSnap = await getDocs(collection(db, "freeformSubmissions", d.id, "pages"));
      for (const p of pagesSnap.docs) {
        await deleteDoc(doc(db, "freeformSubmissions", d.id, "pages", p.id));
      }
      await deleteDoc(doc(db, "freeformSubmissions", d.id));
    }
    btn.textContent = `삭제 완료 (${snap.size}건)`;
    setTimeout(() => {
      btn.textContent = "AI 서술형 채점기 자료 전체 삭제";
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "AI 서술형 채점기 자료 전체 삭제";
    alert("삭제에 실패했습니다: " + e.message);
  }
}

// 학생 명단: 반마다 세로 기둥을 세워 번호순으로 학생을 나열한다.
// 관리자는 모든 반/학생 데이터를 열람할 수 있다(firestore.rules: isAdmin() 무조건 허용).
async function renderRosterAdmin(root) {
  root.innerHTML = `<p class="muted center">명단을 불러오는 중…</p>`;
  const snap = await getDocs(collection(db, "roster"));
  const students = snap.docs
    .map((d) => ({ email: d.id, ...d.data() }))
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  renderRosterList(root, students);
}

function renderRosterList(root, students) {
  const byClass = {};
  students.forEach((s) => (byClass[s.class] ||= []).push(s));
  const classes = Object.keys(byClass).map(Number).sort((a, b) => a - b);

  root.innerHTML = `
    <div class="roster-admin">
      <h2>학생 명단</h2>
      <p class="muted small">번호·아이디를 클릭하면 그 학생의 페이지가 열립니다.</p>
      <div class="roster-grid">
        ${classes.map((c) => `
          <div class="roster-col">
            <h3>${c}반</h3>
            <div class="roster-list">
              ${byClass[c].map((s) => `
                <button class="roster-item" data-email="${s.email}">
                  <span class="roster-num">${s.number}번</span>
                  <span class="roster-id">${escapeHtml(s.email.split("@")[0])}</span>
                </button>`).join("")}
            </div>
          </div>`).join("")}
      </div>
    </div>`;

  root.querySelectorAll(".roster-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const s = students.find((x) => x.email === btn.dataset.email);
      openStudentPage(root, s, students);
    });
  });
}

// 학생 한 명의 "학생 페이지"를 관리자 화면에서 그대로 재현한다 — 전체 학습지
// 카탈로그를 단원별로 보여주고, 제출 여부와 무관하게 클릭해서 확인할 수 있다.
async function openStudentPage(root, student, allStudents) {
  root.innerHTML = `<p class="muted center">불러오는 중…</p>`;

  const [wsSnap, subSnap] = await Promise.all([
    getDocs(query(collection(db, "worksheets"), orderBy("order"))),
    getDocs(query(collection(db, "submissions"), where("studentEmail", "==", student.email))),
  ]);
  const worksheets = wsSnap.docs.map((d) => d.data()).filter((w) => w.active !== false);

  const subsByWs = {};
  subSnap.docs.forEach((d) => {
    const s = { id: d.id, ...d.data() };
    if (!subsByWs[s.worksheetId] || (s.attempt || 0) > (subsByWs[s.worksheetId].attempt || 0)) subsByWs[s.worksheetId] = s;
  });

  const pageState = { worksheets, subsByWs, selected: null };

  root.innerHTML = `
    <div class="roster-page">
      <div class="roster-page-head">
        <button class="btn ghost" id="rosterBackBtn">← 명단으로</button>
        <h2>${student.class}반 ${student.number}번 · ${escapeHtml(student.email)}</h2>
      </div>
      <div class="layout">
        <aside class="sidebar" id="roster-sidebar"></aside>
        <main class="main" id="roster-main"><p class="muted center">왼쪽에서 학습지를 선택하세요.</p></main>
      </div>
    </div>`;

  document.getElementById("rosterBackBtn").addEventListener("click", () => renderRosterList(root, allStudents));
  renderRosterSidebar(pageState);
}

function renderRosterSidebar(pageState) {
  const byUnit = {};
  pageState.worksheets.forEach((w) => (byUnit[w.unit] ||= []).push(w));
  const units = Object.keys(byUnit).sort((a, b) => a - b);

  const html = units.map((u) => {
    const items = byUnit[u].map((w) => {
      const sub = pageState.subsByWs[w.code];
      const label = sub ? (STATUS_LABEL[sub.status] || sub.status) : "미제출";
      const cls = sub ? (STATUS_CLS[sub.status] || "s-none") : "s-none";
      const active = pageState.selected === w.code ? "active" : "";
      return `<button class="ws-item ${active}" data-code="${w.code}">
          <span class="ws-code">${escapeHtml(w.title || w.code)}</span>
          <span class="badge ${cls}">${label}</span>
        </button>`;
    }).join("");
    return `<div class="unit"><div class="unit-title">${u}단원</div>${items}</div>`;
  }).join("");

  const sb = document.getElementById("roster-sidebar");
  sb.innerHTML = html;
  sb.querySelectorAll(".ws-item").forEach((b) =>
    b.addEventListener("click", () => selectRosterWorksheet(pageState, b.dataset.code))
  );
}

// 선택한 학습지에 대해 그 학생이 제출한 내용을 읽기 전용으로 보여준다
// (수정·재채점 등은 "제출물 검토" 탭에서 처리).
async function selectRosterWorksheet(pageState, code) {
  pageState.selected = code;
  renderRosterSidebar(pageState);
  const ws = pageState.worksheets.find((w) => w.code === code);
  const sub = pageState.subsByWs[code];
  const main = document.getElementById("roster-main");

  let body = `<header class="main-head"><h2>${escapeHtml(ws.title || ws.code)}</h2></header>`;
  if (ws.problem) {
    body += `<section class="card"><h3>문제</h3><p class="feedback">${escapeHtml(ws.problem)}</p></section>`;
  }

  if (!sub) {
    body += `<section class="card"><p class="muted center">아직 제출하지 않았습니다.</p></section>`;
    main.innerHTML = body;
    return;
  }

  const imgs = sub.answerType === "text"
    ? `<p class="feedback">${escapeHtml(sub.answerText || "")}</p>`
    : await pagesHtml(sub.id);

  if (sub.status === "released") {
    const g = sub.grade || {};
    const rows = [
      ["핵심 개념 이해", g.concept, 40], ["논리적 연결", g.logic, 25],
      ["근거·예시", g.evidence, 20], ["완성된 문장형식으로 작성", g.expression, 15],
    ].map(([label, val, max]) =>
      `<div class="crit"><span>${label}</span><b>${val ?? "-"} / ${max}</b></div>`
    ).join("");
    const recognizedText = sub.recognizedText || "";
    body += `
      <section class="card">
        <div class="two">
          <div><h3>제출 답안</h3>${imgs}
            ${recognizedText ? `<div class="recognized"><h4>사진으로 인식한 문장</h4><p class="feedback">${escapeHtml(recognizedText)}</p></div>` : ""}
          </div>
          <div>
            <div class="score"><span>${g.total ?? "-"}</span><small>/ 100</small></div>
            <div class="crits">${rows}</div>
            <h4>피드백</h4>
            <p class="feedback">${escapeHtml(sub.feedback || "")}</p>
          </div>
        </div>
      </section>`;
  } else {
    const note = sub.status === "submitted" ? "아직 채점 전입니다."
      : sub.status === "rejected" ? `채점 불가${sub.rejectReason ? ` — ${escapeHtml(sub.rejectReason)}` : ""}`
      : "검토 대기 중입니다.";
    body += `
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="muted" style="margin-top:12px">${note}</p>
      </section>`;
  }

  main.innerHTML = body;
  wireLightboxImages(main);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",", 2)[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 제출 이미지는 한 번 올라오면 바뀌지 않으므로(규칙상 학생은 생성·삭제만 가능)
// 제출물 단위로 캐시한다 — 같은 항목을 다시 열 때 읽기·대역폭을 다시 쓰지 않는다.
const pagesCache = new Map(); // submissionId -> dataURL[]
const PAGES_CACHE_MAX = 30;   // 이미지가 장당 수백 KB라 탭 메모리를 위해 개수를 제한한다

async function loadPageImages(subId) {
  if (pagesCache.has(subId)) return pagesCache.get(subId);
  const snap = await getDocs(query(collection(db, "submissions", subId, "pages"), orderBy("order")));
  // 학생이 써넣는 값이므로 실제 이미지 데이터 URL만 통과시킨다(HTML 주입 차단).
  const imgs = snap.docs
    .map((d) => d.data().imageBase64)
    .filter((s) => typeof s === "string" && s.startsWith("data:image/"));
  if (pagesCache.size >= PAGES_CACHE_MAX) pagesCache.delete(pagesCache.keys().next().value);
  pagesCache.set(subId, imgs);
  return imgs;
}

// 항목별 점수 입력칸 하나. score는 순수 숫자(공개된 채점 결과)이거나 {score, note}
// 형태(AI 채점 초안)일 수 있어 둘 다 받는다.
function critEditRow(label, max, key, score, note) {
  const val = (score && typeof score === "object") ? score.score : score;
  return `
    <div class="crit-edit">
      <label>${label} <small>/ ${max}</small></label>
      <input type="number" min="0" max="${max}" value="${val ?? 0}" data-k="${key}">
      ${note ? `<p class="muted small">${escapeHtml(note)}</p>` : ""}
    </div>`;
}

function toFlatGrade(g) {
  return {
    total: g.total,
    concept: g.concept?.score ?? 0,
    logic: g.logic?.score ?? 0,
    evidence: g.evidence?.score ?? 0,
    expression: g.expression?.score ?? 0,
  };
}

// 실제 재채점 로직만 수행한다(DOM 조작 없음) — 버튼 클릭과 자동 재채점 양쪽에서 공용으로 쓴다.
// source: "text" = 저장된 판독 문장으로 채점(기본, 토큰 절약)
//         "photo" = 사진을 다시 읽어서 채점(학생이 문장을 고쳤을 때 원본 확인용)
async function performRegrade(it, source = "text") {
  const wsSnap = await getDoc(doc(db, "worksheets", it.worksheetId));
  const wsData = wsSnap.exists() ? wsSnap.data() : {};
  let g;
  if (it.answerType === "text") {
    g = await gradeText(wsData.problem, it.answerText || "", wsData.referenceMaterial);
  } else if (source === "text" && it.recognizedText) {
    // 이미 인식된 문장이 있으면 이미지를 다시 보내지 않고 텍스트로 재채점(토큰 절약).
    g = await gradeText(wsData.problem, it.recognizedText, wsData.referenceMaterial);
  } else {
    // 사진 재판독 요청이거나, 인식된 문장이 없는(이 기능 이전에 채점된) 예전 항목.
    const imgs = await loadPageImages(it.id);
    if (!imgs.length) throw new Error("이미지 없음");
    g = await gradeImages(imgs, wsData.referenceMaterial, wsData.problem);
  }
  await setDoc(doc(db, "reviews", reviewKey(it)), g);
  const flat = toFlatGrade(g);
  await updateDoc(doc(db, "submissions", it.id), {
    grade: flat, feedback: g.feedback, recognizedText: g.recognizedText,
    gradedAt: serverTimestamp(), reviewFlag: !!g.reviewFlag, gradeError: null,
    recognizedEditedBy: null,
  });
  it.grade = flat;
  it.feedback = g.feedback;
  it.recognizedText = g.recognizedText;
  it.reviewFlag = !!g.reviewFlag;
  it.review = g;
}

// 채점 실패(error)한 건을 다시 채점 대기(submitted)로 되돌린다 — 채점 큐가 다시 집어간다.
async function retryGrading(it) {
  const btn = document.getElementById("retryBtn");
  btn.disabled = true; btn.textContent = "대기열에 넣는 중…";
  try {
    await updateDoc(doc(db, "submissions", it.id), { status: "submitted", gradeError: null });
    it.status = "submitted";
    it.gradeError = null;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "다시 채점";
    alert("처리에 실패했습니다: " + e.message);
  }
}

// "재채점" 버튼 클릭 핸들러: 확인창 + 버튼 로딩 상태 표시 후 performRegrade 실행.
async function regradeItem(it, source = "text", btnId = "regradeBtn") {
  const what = source === "photo" ? "사진을 다시 읽어서" : "저장된 문장으로";
  if (!confirm(`${it.worksheetId} · ${it.studentEmail} 항목을 ${what} 다시 채점할까요?\n기존 점수·피드백이 새 결과로 덮어써집니다.`)) return;
  const btn = document.getElementById(btnId);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "재채점 중…";
  try {
    await performRegrade(it, source);
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    alert("재채점에 실패했습니다: " + e.message);
  }
}

async function runGrading() {
  if (isGrading) return; // 이미 채점 중이면(자동/수동 무관) 중복 실행 방지
  isGrading = true;
  // 채점 버튼/상태 표시는 "제출물 검토" 탭에만 있다. 완료 탭이나 다른 탭에 있는 동안
  // 자동 채점이 돌 수 있으므로 없을 때를 대비한다.
  const btn = document.getElementById("gradeBtn");
  const statusEl = document.getElementById("gradeStatus");
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  if (btn) btn.disabled = true;
  try {
    const snap = await getDocs(query(collection(db, "submissions"), where("status", "==", "submitted")));
    const subs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!subs.length) {
      setStatus("채점할 새 제출물이 없습니다.");
      return;
    }
    let done = 0, flagged = 0, errors = 0;
    for (const s of subs) {
      setStatus(`채점 중… (${done + errors + 1}/${subs.length})`);
      try {
        const wsSnap = await getDoc(doc(db, "worksheets", s.worksheetId));
        const wsData = wsSnap.exists() ? wsSnap.data() : {};
        let g;
        if (s.answerType === "text") {
          if (!s.answerText) throw new Error("답안 텍스트 없음");
          g = await gradeText(wsData.problem, s.answerText, wsData.referenceMaterial);
        } else {
          const imgs = await loadPageImages(s.id);
          if (!imgs.length) throw new Error("이미지 없음");
          g = await gradeImages(imgs, wsData.referenceMaterial, wsData.problem);
        }
        await setDoc(doc(db, "reviews", reviewKey(s)), g);

        // 채점 결과는 항상 교사 검토 대기(graded)로 둔다 — 채점 모델이 틀릴 수 있으므로
        // 교사가 확인하고 공개해야 학생에게 점수가 보인다(grade.py와 동일한 정책).
        // reviewFlag는 목록 배지에 쓰려고 제출물에도 복사해둔다(점수는 공개 전까지 복사 안 함).
        await updateDoc(doc(db, "submissions", s.id), {
          status: "graded",
          gradedAt: serverTimestamp(),
          reviewFlag: !!g.reviewFlag,
          gradeError: null,
        });
        if (g.reviewFlag) flagged++;
        done++;
      } catch (e) {
        errors++;
        console.error(`[채점 오류] ${s.id}:`, e);
        // 실패한 건을 submitted로 두면 아래 재시도에서 무한히 다시 채점하게 된다.
        // error 상태로 표시해 큐에서 빼고, 교사가 화면에서 사유를 보고 재시도하게 한다.
        try {
          await updateDoc(doc(db, "submissions", s.id), {
            status: "error", gradeError: String(e.message || e).slice(0, 300),
          });
        } catch (_) { /* 상태 기록 실패는 무시 */ }
      }
      if (subs.indexOf(s) < subs.length - 1) {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }
    setStatus(`채점 완료: ${done}건 (확인 필요 ${flagged}건, 오류 ${errors}건)`);
    // 목록은 실시간 구독(onSnapshot)이 자동으로 갱신한다.
  } catch (e) {
    setStatus("채점 실패: " + e.message);
  } finally {
    if (btn) btn.disabled = false;
    isGrading = false;
  }

  // 채점 도중 새로 제출된 건이 있으면(자동 트리거가 "채점 중"이라 건너뛰었을 수 있음) 이어서 채점한다.
  // 실패한 건은 error 상태라 이 쿼리에 안 잡히므로 무한 반복되지 않는다.
  const stillPending = await getDocs(query(collection(db, "submissions"), where("status", "==", "submitted")));
  if (!stillPending.empty && !inServerWindow()) runGrading();
}

const STATUS_LABEL = { submitted: "채점 대기", graded: "검토 대기", released: "채점됨", rejected: "채점 불가", error: "채점 실패" };
const STATUS_CLS   = { submitted: "s-none",   graded: "s-pending",  released: "s-done", rejected: "s-rejected", error: "s-flag" };

// "NEW" 배지: 채점이 끝났는데 교사가 아직 열어 보지 않은 제출. 항목을 누르면 submissions.teacherSeenAt 에
// 시각을 남기고, 채점 시각(gradedAt)이 그보다 늦으면(재채점·재제출) 다시 NEW 가 된다.
// 이 기능을 넣기 전에 이미 채점된 건은 NEW 로 띄우지 않는다(기준 시각 이전 채점분은 제외).
const NEW_BADGE_SINCE_MS = 1789796139000;
const seenThisSession = new Map(); // id → 방금 확인 처리한 gradedAt(ms). 서버 반영 전 깜빡임 방지

function tsMs(t) {
  return t?.toMillis ? t.toMillis() : 0;
}

function isNewItem(it) {
  if (it.status !== "graded" && it.status !== "released") return false;
  const graded = tsMs(it.gradedAt);
  if (!graded || graded <= NEW_BADGE_SINCE_MS) return false;
  if ((seenThisSession.get(it.id) || 0) >= graded) return false;
  return tsMs(it.teacherSeenAt) < graded;
}

// 교사 화면 제목 아래에 표시할 제출 시각(KST). 재제출이면 몇 번째 제출인지도 붙인다.
function submittedAtLine(it) {
  const t = it.submittedAt;
  const d = t?.toDate ? t.toDate() : (t?.seconds ? new Date(t.seconds * 1000) : null);
  if (!d || isNaN(d)) return "";
  const when = d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric",
    weekday: "short", hour: "numeric", minute: "2-digit", hour12: false,
  });
  const nth = it.attempt > 1 ? ` · ${it.attempt}번째 제출` : "";
  return `<div class="muted small" style="margin-top:4px">제출 ${escapeHtml(when)}${nth}</div>`;
}

// 교사가 "과제 완료"를 누른 건은 원래 상태 대신 "완료"로 표시한다(별도 탭 없음).
function statusBadge(it) {
  if (it.completed) return `<span class="badge s-complete">완료</span>`;
  return `<span class="badge ${STATUS_CLS[it.status] || "s-none"}">${STATUS_LABEL[it.status] || escapeHtml(it.status)}</span>`;
}

function renderList() {
  const list = document.getElementById("t-list");
  if (!list) return; // 다른 탭으로 옮긴 뒤 뒤늦게 도착한 스냅샷

  // 제출물 유무와 상관없이 명단의 모든 반 → 모든 학습지 → 반 학생 전원을 그린다.
  // 제출물이 없는 학생은 "미제출" 행(비활성)으로 채운다.
  const subMap = {}; // "email|worksheetId" -> submission
  state.items.forEach((it) => { subMap[`${it.studentEmail}|${it.worksheetId}`] = it; });

  // excluded(열외: 도움반 등)인 학생은 행은 그대로 그리되 "제출/전체" 집계에서만 뺀다.
  // 학생도 교사 화면을 보므로 열외 표시는 화면에 따로 내지 않는다.
  const byClassRoster = {}; // class -> [{ email, number, excluded }]
  Object.entries(rosterMap).forEach(([email, r]) => {
    (byClassRoster[r.class] ||= []).push({ email, number: r.number ?? 999, excluded: r.excluded === true });
  });
  Object.values(byClassRoster).forEach((arr) => arr.sort((a, b) => a.number - b.number));
  const classes = Object.keys(byClassRoster).map(Number).sort((a, b) => a - b);
  const wsIds = Object.keys(worksheetOrderMap).sort((a, b) => worksheetOrderMap[a] - worksheetOrderMap[b]);

  // 명단에 없는 이메일의 제출물은 따로 "미확인" 구역에 모은다(예전과 동일).
  const unknown = state.items.filter((it) => !rosterMap[it.studentEmail]);

  if (!classes.length && !unknown.length) {
    list.innerHTML = `<p class="muted center">제출물이 없습니다.</p>`;
    return;
  }

  const renderItem = (it) => {
    const flag = it.reviewFlag ? `<span class="badge s-flag">확인 필요</span>` : "";
    const edited = it.recognizedEditedBy === "student" ? `<span class="badge s-flag">문장 수정됨</span>` : "";
    const active = state.selected === it.id ? "active" : "";
    // 공개 전 점수는 목록에도 띄우지 않는다(초안은 항목을 열었을 때만 조회).
    const score = it.status === "released" ? it.grade?.total : null;
    const num = rosterMap[it.studentEmail]?.number;
    const who = num ? `${num}번 ${escapeHtml(it.studentEmail)}` : escapeHtml(it.studentEmail);
    return `<button class="ws-item ${active}" data-id="${escapeHtml(it.id)}">
        <span class="ws-code">${who}${isNewItem(it) ? ' <span class="badge s-new">NEW</span>' : ""}</span>
        <span>${score ?? "-"}점
          ${statusBadge(it)}
          ${flag}${edited}
        </span>
      </button>`;
  };
  const renderMissing = (st) =>
    `<button class="ws-item missing" disabled>
        <span class="ws-code">${st.number}번 ${escapeHtml(st.email)}</span>
        <span><span class="badge s-none">미제출</span></span>
      </button>`;

  const wsTitle = (wsId) => {
    // 이 앱의 학습지는 title 이 code 와 같은 값으로 등록돼 있어(예: "4-2-2") 그냥 붙이면
    // "4-2-2 · 4-2-2" 처럼 중복 표시된다. title 이 code 와 다를 때만 같이 보여준다.
    const t = worksheetTitleMap[wsId];
    return (t && t !== wsId) ? `${escapeHtml(wsId)} · ${escapeHtml(t)}` : escapeHtml(wsId);
  };
  // 아래에 안 열어 본 채점 완료 제출(NEW)이 하나라도 있으면 그룹 제목에도 NEW 를 붙인다.
  const groupNew = (n) => (n > 0 ? ' <span class="badge s-new">NEW</span>' : "");
  const renderGroup = (cls, wsId, rows, count, newCount = 0) => {
    const key = `${cls}|${wsId}`;
    const open = expandedGroups.has(key) ? " open" : "";
    return `<details class="ws-group" data-key="${escapeHtml(key)}"${open}>
        <summary class="ws-group-title"><span class="ws-group-title-row">
          <span>${wsTitle(wsId)}${groupNew(newCount)}</span><span class="muted small">${count}</span>
        </span></summary>
        ${rows}
      </details>`;
  };

  const renderUnit = (key, label, groups, newCount = 0) => {
    const open = collapsedClasses.has(key) ? "" : " open";
    return `<details class="unit" data-class="${escapeHtml(key)}"${open}>
        <summary class="unit-title"><span class="unit-title-row">${escapeHtml(label)}${groupNew(newCount)}</span></summary>
        ${groups}
      </details>`;
  };
  // 반 안에서 학습지 그룹을 단원별("4단원", "5단원")로 한 번 더 묶는다.
  const renderChapter = (cls, unit, groups, newCount = 0) => {
    const key = `${cls}|${unit}`;
    const open = expandedChapters.has(key) ? " open" : "";
    const label = unit === "기타" ? "기타" : `${unit}단원`;
    return `<details class="chapter" data-key="${escapeHtml(key)}"${open}>
        <summary class="chapter-title"><span class="chapter-title-row">${escapeHtml(label)}${groupNew(newCount)}</span></summary>
        ${groups}
      </details>`;
  };
  // 학습지 순서를 유지한 채 단원별로 나눈다: [["4", ["4-1-1", ...]], ["5", [...]]]
  const groupByUnit = (ids) => {
    const byUnit = {};
    const order = [];
    ids.forEach((id) => {
      const u = unitOf(id);
      if (!byUnit[u]) { byUnit[u] = []; order.push(u); }
      byUnit[u].push(id);
    });
    return order.map((u) => [u, byUnit[u]]);
  };
  const unitsOfAll = groupByUnit(wsIds);

  let html = classes.map((cls) => {
    const students = byClassRoster[cls];
    let classNew = 0;
    const chapters = unitsOfAll.map(([unit, ids]) => {
      const counted = students.filter((st) => !st.excluded).length;
      let unitNew = 0;
      const groups = ids.map((wsId) => {
        let submitted = 0;
        let newCount = 0;
        const rows = students.map((st) => {
          const it = subMap[`${st.email}|${wsId}`];
          if (it && !st.excluded) submitted += 1;
          if (it && isNewItem(it)) newCount += 1;
          return it ? renderItem(it) : renderMissing(st);
        }).join("");
        unitNew += newCount;
        return renderGroup(cls, wsId, rows, `${submitted}/${counted}`, newCount);
      }).join("");
      classNew += unitNew;
      return renderChapter(String(cls), unit, groups, unitNew);
    }).join("");
    return renderUnit(String(cls), `${cls}반`, chapters, classNew);
  }).join("");

  if (unknown.length) {
    const byWs = {};
    unknown.forEach((it) => (byWs[it.worksheetId] ||= []).push(it));
    const unknownIds = Object.keys(byWs)
      .sort((a, b) => (worksheetOrderMap[a] ?? 999) - (worksheetOrderMap[b] ?? 999));
    let unknownNew = 0;
    const chapters = groupByUnit(unknownIds).map(([unit, ids]) => {
      let unitNew = 0;
      const groups = ids
        .map((wsId) => {
          const newCount = byWs[wsId].filter(isNewItem).length;
          unitNew += newCount;
          return renderGroup("미확인", wsId, byWs[wsId].map(renderItem).join(""), byWs[wsId].length, newCount);
        })
        .join("");
      unknownNew += unitNew;
      return renderChapter("미확인", unit, groups, unitNew);
    }).join("");
    html += renderUnit("미확인", "미확인", chapters, unknownNew);
  }

  list.innerHTML = html;
  list.querySelectorAll(".ws-item[data-id]").forEach((b) =>
    b.addEventListener("click", () => selectItem(b.dataset.id))
  );
  list.querySelectorAll(".ws-group").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) expandedGroups.add(d.dataset.key);
      else expandedGroups.delete(d.dataset.key);
    })
  );
  list.querySelectorAll(".unit").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) collapsedClasses.delete(d.dataset.class);
      else collapsedClasses.add(d.dataset.class);
    })
  );
  list.querySelectorAll(".chapter").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (d.open) expandedChapters.add(d.dataset.key);
      else expandedChapters.delete(d.dataset.key);
    })
  );
}

async function selectItem(id) {
  state.selected = id;
  const it = state.items.find((x) => x.id === id);
  if (it && isNewItem(it)) {
    seenThisSession.set(it.id, tsMs(it.gradedAt));
    updateDoc(doc(db, "submissions", it.id), { teacherSeenAt: serverTimestamp() }).catch(() => {});
  }
  // 선택한 항목이 든 그룹은 펼쳐 둔다(접힌 채로 선택 표시만 남지 않도록).
  if (it) {
    const cls = String(rosterMap[it.studentEmail]?.class ?? "미확인");
    expandedGroups.add(`${cls}|${it.worksheetId}`);
    collapsedClasses.delete(cls);
    expandedChapters.add(`${cls}|${unitOf(it.worksheetId)}`);
  }
  renderList();
  const main = document.getElementById("t-main");
  if (!it || !main) return; // 클릭 직전에 목록에서 사라졌거나(학생 취소 등) 탭이 바뀐 경우

  // 채점 초안은 목록에서 미리 읽지 않고, 항목을 연 이 시점에 한 건만 읽는다.
  if (it.review === undefined) {
    const r = await getDoc(doc(db, "reviews", reviewKey(it)));
    it.review = r.exists() ? r.data() : null;
  }

  const imgs = it.answerType === "text"
    ? `<p class="feedback">${escapeHtml(it.answerText || "")}</p>`
    : await pagesHtml(it.id);

  // 공개된 건은 submissions.recognizedText(학생도 읽을 수 있는 사본), 그 전엔
  // reviews.recognizedText(초안)를 사용한다.
  const recognizedText = it.recognizedText ?? it.review?.recognizedText ?? "";

  const header = `
    <header class="main-head">
      <div>
        <h2>${escapeHtml(it.worksheetId)} · ${escapeHtml(it.studentEmail)}</h2>
        ${submittedAtLine(it)}
      </div>
      ${statusBadge(it)}
      <button class="btn ghost" id="completeBtn" style="margin-left:auto">${it.completed ? "완료 취소" : "과제 완료"}</button>
      <button class="btn ghost" id="deleteBtn">삭제</button>
    </header>`;

  if (it.status === "submitted") {
    main.innerHTML = `${header}
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="muted" style="margin-top:12px">아직 채점 전입니다. 위의 "지금 채점하기" 버튼을 눌러 채점하세요.</p>
      </section>`;
  } else if (it.status === "error") {
    main.innerHTML = `${header}
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="badge s-flag" style="margin:12px 0 0">채점 실패: ${escapeHtml(it.gradeError || "사유 미기록")}</p>
        <p class="muted" style="margin-top:12px">원인을 확인한 뒤 아래 버튼으로 다시 채점할 수 있습니다.</p>
        <button class="btn primary" id="retryBtn" style="margin-top:12px">다시 채점</button>
      </section>`;
    document.getElementById("retryBtn").addEventListener("click", () => retryGrading(it));
  } else if (it.status === "released") {
    const g = it.grade || {};
    const rows = [
      ["핵심 개념 이해", g.concept, 40], ["논리적 연결", g.logic, 25],
      ["근거·예시", g.evidence, 20], ["완성된 문장형식으로 작성", g.expression, 15],
    ].map(([label, val, max]) =>
      `<div class="crit"><span>${label}</span><b>${val ?? "-"} / ${max}</b></div>`
    ).join("");
    // 학생이 판독 문장을 고친 경우: 무엇이 바뀌었는지 원문과 나란히 보여주고,
    // 재채점 기준(고친 문장 / 사진 재판독)을 교사가 직접 고르게 한다.
    // 사진 제출물이라도 재채점은 기본적으로 문장으로만 하기 때문에(토큰 절약),
    // 고른 기준에 따라 점수가 달라질 수 있다.
    const studentEdited = it.recognizedEditedBy === "student";
    const recognizedSection = it.answerType !== "text" ? (studentEdited ? `
      <div class="recognized">
        <h4>사진으로 인식한 문장</h4>
        <p class="badge s-flag" style="margin:0 0 10px">학생이 이 문장을 고쳤습니다 — 사진과 대조해 어느 쪽으로 채점할지 골라주세요.</p>
        <label class="fb-label">AI가 사진에서 읽은 문장</label>
        <p class="feedback">${escapeHtml(it.review?.recognizedText || "(기록 없음)")}</p>
        <label class="fb-label" style="margin-top:10px">학생이 고친 문장</label>
        <div id="recognizedView"><p class="feedback">${escapeHtml(recognizedText)}</p></div>
        <div class="review-actions" style="margin-top:12px">
          <button class="btn primary" id="regradeTextBtn">수정된 문장으로 재채점</button>
          <button class="btn ghost" id="regradePhotoBtn">사진 다시 읽어서 재채점</button>
        </div>
        <button class="btn ghost" id="editRecognizedBtn" style="margin-top:6px">문장 직접 고치기</button>
      </div>` : `
      <div class="recognized">
        <div class="fb-head"><h4>사진으로 인식한 문장</h4><button class="btn ghost" id="editRecognizedBtn">수정</button></div>
        <div id="recognizedView"><p class="feedback">${escapeHtml(recognizedText)}</p></div>
      </div>`) : "";
    main.innerHTML = `${header}
      <section class="card">
        <div class="two">
          <div><h3>제출 답안</h3>${imgs}${recognizedSection}</div>
          <div>
            <div class="score-head">
              <div class="score"><span>${g.total ?? "-"}</span><small>/ 100</small></div>
              <div class="review-actions">
                ${studentEdited ? "" : `<button class="btn ghost" id="regradeBtn">재채점</button>`}
                <button class="btn ghost" id="editScoreBtn">점수 수정</button>
                <button class="btn danger" id="rejectBtn">채점 불가</button>
              </div>
            </div>
            <div id="scoreView"><div class="crits">${rows}</div></div>
            <div class="fb-head">
              <h4>피드백</h4>
              <button class="btn ghost" id="editFeedbackBtn">수정</button>
            </div>
            <div id="feedbackView"><p class="feedback">${escapeHtml(it.feedback || "")}</p></div>
          </div>
        </div>
      </section>`;

    document.getElementById("editScoreBtn").addEventListener("click", () => {
      document.getElementById("scoreView").innerHTML = `
        <div class="crit-grid">
          ${critEditRow("핵심 개념 이해", 40, "concept", g.concept)}
          ${critEditRow("논리적 연결", 25, "logic", g.logic)}
          ${critEditRow("근거·예시", 20, "evidence", g.evidence)}
          ${critEditRow("완성된 문장형식으로 작성", 15, "expression", g.expression)}
        </div>
        <div class="total-row">
          <label>총점 <small>/ 100</small></label>
          <input type="number" id="totalInput" min="0" max="100" value="${g.total ?? 0}">
        </div>
        <div class="fb-actions">
          <button class="btn primary" id="saveScoreBtn">저장</button>
          <button class="btn ghost" id="cancelScoreBtn">취소</button>
        </div>`;
      wireTotalAutoCalc();
      document.getElementById("cancelScoreBtn").addEventListener("click", () => selectItem(it.id));
      document.getElementById("saveScoreBtn").addEventListener("click", () => saveGrade(it));
    });

    document.getElementById("rejectBtn").addEventListener("click", () => rejectSubmission(it));

    document.getElementById("editFeedbackBtn").addEventListener("click", () => {
      document.getElementById("feedbackView").innerHTML = `
        <textarea id="feedbackEdit" rows="8">${escapeHtml(it.feedback || "")}</textarea>
        <div class="fb-actions">
          <button class="btn primary" id="saveFeedbackBtn">저장</button>
          <button class="btn ghost" id="cancelFeedbackBtn">취소</button>
        </div>`;
      document.getElementById("cancelFeedbackBtn").addEventListener("click", () => selectItem(it.id));
      document.getElementById("saveFeedbackBtn").addEventListener("click", async () => {
        const saveBtn = document.getElementById("saveFeedbackBtn");
        saveBtn.disabled = true; saveBtn.textContent = "저장 중…";
        try {
          const newFeedback = document.getElementById("feedbackEdit").value;
          await updateDoc(doc(db, "submissions", it.id), { feedback: newFeedback });
          it.feedback = newFeedback;
          selectItem(it.id);
        } catch (e) {
          saveBtn.disabled = false; saveBtn.textContent = "저장";
          alert("저장에 실패했습니다: " + e.message);
        }
      });
    });

    const editRecognizedBtn = document.getElementById("editRecognizedBtn");
    if (editRecognizedBtn) {
      editRecognizedBtn.addEventListener("click", () => {
        document.getElementById("recognizedView").innerHTML = `
          <textarea id="recognizedEdit" rows="4">${escapeHtml(recognizedText)}</textarea>
          <div class="fb-actions">
            <button class="btn primary" id="saveRecognizedBtn">저장</button>
            <button class="btn ghost" id="cancelRecognizedBtn">취소</button>
          </div>`;
        document.getElementById("cancelRecognizedBtn").addEventListener("click", () => selectItem(it.id));
        document.getElementById("saveRecognizedBtn").addEventListener("click", async () => {
          const saveBtn = document.getElementById("saveRecognizedBtn");
          saveBtn.disabled = true; saveBtn.textContent = "저장 중…";
          try {
            const newText = document.getElementById("recognizedEdit").value;
            await updateDoc(doc(db, "submissions", it.id), {
              recognizedText: newText, recognizedEditedBy: "teacher",
            });
            it.recognizedText = newText;
            it.recognizedEditedBy = "teacher";
            selectItem(it.id);
          } catch (e) {
            saveBtn.disabled = false; saveBtn.textContent = "저장";
            alert("저장에 실패했습니다: " + e.message);
          }
        });
      });
    }

    if (studentEdited) {
      document.getElementById("regradeTextBtn")
        .addEventListener("click", () => regradeItem(it, "text", "regradeTextBtn"));
      document.getElementById("regradePhotoBtn")
        .addEventListener("click", () => regradeItem(it, "photo", "regradePhotoBtn"));
    } else {
      document.getElementById("regradeBtn")
        .addEventListener("click", () => regradeItem(it, "text", "regradeBtn"));
    }
  } else if (it.status === "rejected") {
    main.innerHTML = `${header}
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="muted small" style="margin-top:12px">사유: ${escapeHtml(it.rejectReason || "(사유 없음)")}</p>
        <p class="muted" style="margin-top:12px">채점 불가로 돌려보내 다시 제출을 기다리는 중입니다. 학생의 제출 횟수는 차감되지 않습니다.</p>
      </section>`;
  } else {
    const r = it.review || {};

    const recognizedEditSection = it.answerType !== "text" ? `
      <div class="recognized">
        <h4>사진으로 인식한 문장</h4>
        <textarea id="recognizedInput" rows="4">${escapeHtml(recognizedText)}</textarea>
      </div>` : "";
    main.innerHTML = `${header}
      ${r.reviewFlag ? `<p class="badge s-flag" style="margin:12px 0">확인 필요: ${escapeHtml(r.reviewReason || "")}</p>` : ""}
      <section class="card">
        <div class="two">
          <div><h3>제출 답안</h3>${imgs}${recognizedEditSection}</div>
          <div class="review-form">
            <div class="crit-grid">
              ${critEditRow("핵심 개념 이해", 40, "concept", r.concept, r.concept?.note)}
              ${critEditRow("논리적 연결", 25, "logic", r.logic, r.logic?.note)}
              ${critEditRow("근거·예시", 20, "evidence", r.evidence, r.evidence?.note)}
              ${critEditRow("완성된 문장형식으로 작성", 15, "expression", r.expression, r.expression?.note)}
            </div>
            <div class="total-row">
              <label>총점 <small>/ 100</small></label>
              <input type="number" id="totalInput" min="0" max="100" value="${r.total ?? 0}">
            </div>
            <label class="fb-label">피드백</label>
            <textarea id="fbInput" rows="8">${escapeHtml(r.feedback || "")}</textarea>
            <div class="review-actions">
              <button class="btn primary" id="releaseBtn">채점 완료</button>
              <button class="btn danger" id="rejectBtn">채점 불가</button>
            </div>
          </div>
        </div>
      </section>`;

    wireTotalAutoCalc();
    document.getElementById("releaseBtn").addEventListener("click", () => release(it));
    document.getElementById("rejectBtn").addEventListener("click", () => rejectSubmission(it));
  }

  document.getElementById("deleteBtn").addEventListener("click", () => deleteItem(it));
  document.getElementById("completeBtn").addEventListener("click", () => toggleComplete(it));
  wireLightboxImages(main);
}

async function toggleComplete(it) {
  const newVal = !it.completed;
  const btn = document.getElementById("completeBtn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "submissions", it.id), { completed: newVal });
    it.completed = newVal;
    // 별도 탭이 없으므로 항목을 그대로 열어 둔 채 목록·헤더의 배지만 "완료"로 바꾼다.
    await selectItem(it.id);
  } catch (e) {
    btn.disabled = false;
    alert("처리에 실패했습니다: " + e.message);
  }
}

// 항목별 점수(concept/logic/evidence/expression)를 고치면 총점 입력칸을 그 합으로
// 자동 갱신한다. 총점을 직접 덮어쓸 수도 있지만, 항목 점수를 다시 건드리면 합으로
// 되돌아간다.
function wireTotalAutoCalc() {
  const critInputs = document.querySelectorAll('.crit-edit input[data-k]');
  const totalInput = document.getElementById("totalInput");
  if (!critInputs.length || !totalInput) return;
  const recalc = () => {
    let sum = 0;
    critInputs.forEach((el) => { sum += Number(el.value) || 0; });
    totalInput.value = sum;
  };
  critInputs.forEach((el) => el.addEventListener("input", recalc));
}

// "채점 불가" 버튼 클릭 핸들러: 채점 자체가 불가능한 제출(엉뚱한 사진, 백지, 다른 학습지 등)을
// 사유와 함께 학생에게 돌려보낸다(상태 rejected). "다시 써 와"는 낮은 점수+피드백으로 하고,
// 이 버튼은 채점할 수 없는 경우에만 쓴다. 학생 화면에서는 업로드 폼이 다시 열리고,
// 새로 제출하면(student.js) 이전 자료가 자동으로 삭제되며 제출 횟수도 차감되지 않는다.
async function rejectSubmission(it) {
  const reason = prompt(
    "채점할 수 없는 이유를 입력하세요 (학생에게 표시됩니다)\n예: 사진이 흐려서 글씨가 안 보임 / 다른 학습지 사진 / 백지",
    ""
  );
  if (reason === null) return; // 취소
  if (!confirm(`${it.worksheetId} · ${it.studentEmail} 제출물을 채점 불가로 돌려보낼까요?\n점수 없이 사유만 전달되고, 학생이 다시 제출해야 합니다(제출 횟수 차감 없음).`)) return;
  const btn = document.getElementById("rejectBtn");
  btn.disabled = true; btn.textContent = "처리 중…";
  try {
    await updateDoc(doc(db, "submissions", it.id), {
      status: "rejected", rejectReason: reason, rejectedAt: serverTimestamp(), reviewFlag: false,
    });
    it.status = "rejected";
    it.rejectReason = reason;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "채점 불가";
    alert("채점 불가 처리에 실패했습니다: " + e.message);
  }
}

// 이미 공개된(released) 항목의 점수만 고쳐서 저장한다(상태·공개일은 그대로).
async function saveGrade(it) {
  const btn = document.getElementById("saveScoreBtn");
  btn.disabled = true; btn.textContent = "저장 중…";
  try {
    const get = (k) => {
      const el = document.querySelector(`input[data-k="${k}"]`);
      return el ? Number(el.value) : null;
    };
    const grade = {
      total: Number(document.getElementById("totalInput").value),
      concept: get("concept"), logic: get("logic"),
      evidence: get("evidence"), expression: get("expression"),
    };
    await updateDoc(doc(db, "submissions", it.id), { grade });
    it.grade = grade;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "저장";
    alert("저장에 실패했습니다: " + e.message);
  }
}

async function release(it) {
  const btn = document.getElementById("releaseBtn");
  btn.disabled = true; btn.textContent = "완료 처리 중…";
  try {
    const get = (k) => {
      const el = document.querySelector(`input[data-k="${k}"]`);
      return el ? Number(el.value) : null;
    };
    const grade = {
      total: Number(document.getElementById("totalInput").value),
      concept: get("concept"), logic: get("logic"),
      evidence: get("evidence"), expression: get("expression"),
    };
    const feedback = document.getElementById("fbInput").value;
    const recognizedInput = document.getElementById("recognizedInput");
    // 공개하면 교사 검토가 끝난 것이므로 "확인 필요" 배지도 내린다.
    const update = { grade, feedback, status: "released", releasedAt: serverTimestamp(), reviewFlag: false };
    if (recognizedInput) update.recognizedText = recognizedInput.value;

    await updateDoc(doc(db, "submissions", it.id), update);

    it.status = "released";
    it.grade = grade;
    it.feedback = feedback;
    if (recognizedInput) it.recognizedText = recognizedInput.value;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "채점 완료";
    alert("채점 완료 처리에 실패했습니다: " + e.message);
  }
}

async function deleteItem(it) {
  if (!confirm(`${it.worksheetId} · ${it.studentEmail} 제출물을 완전히 삭제할까요?\n학생 화면에서도 사라지며 되돌릴 수 없습니다.`)) return;
  const btn = document.getElementById("deleteBtn");
  btn.disabled = true; btn.textContent = "삭제 중…";
  try {
    if (it.answerType !== "text") {
      const pagesSnap = await getDocs(collection(db, "submissions", it.id, "pages"));
      for (const p of pagesSnap.docs) {
        await deleteDoc(doc(db, "submissions", it.id, "pages", p.id));
      }
    }
    await deleteDoc(doc(db, "reviews", reviewKey(it)));
    await deleteDoc(doc(db, "submissions", it.id));

    state.items = state.items.filter((x) => x.id !== it.id);
    state.selected = null;
    renderList();
    document.getElementById("t-main").innerHTML = `<p class="muted center">삭제했습니다.</p>`;
  } catch (e) {
    btn.disabled = false; btn.textContent = "삭제";
    alert("삭제에 실패했습니다: " + e.message);
  }
}

async function pagesHtml(subId) {
  const imgs = await loadPageImages(subId);
  if (!imgs.length) return `<p class="muted">이미지 없음</p>`;
  return `<div class="imgs">` + imgs.map((src) =>
    `<img src="${escapeHtml(src)}" alt="제출 이미지">`
  ).join("") + `</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
