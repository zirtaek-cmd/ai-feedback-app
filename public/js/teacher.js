import { db } from "./firebase-init.js";
import {
  collection, doc, query, where, orderBy, getDocs, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { gradeImages, gradeText, summarizeReference } from "./grade.js";
import { wireLightboxImages } from "./lightbox.js";

const THROTTLE_MS = 4000; // 무료 등급 RPM 대응

let state = { items: [], selected: null, tab: "review" };
let unsubscribeItems = null;
let isGrading = false;
let rosterMap = {};        // studentEmail -> { class, number }
let worksheetOrderMap = {}; // worksheetId  -> order

// 목록 정렬·그룹핑(반별 구역, 학습지 번호순)에 쓸 명단/학습지 순서를 불러온다.
// 매 탭 전환마다 새로 불러오되(한 번 실패하면 계속 비어있는 캐시 버그를 피하기 위해
// 영구 캐시는 두지 않는다), 제출물 구독과 동시에 진행해 기다리는 시간을 줄인다.
async function loadRosterAndWorksheets() {
  const [rosterSnap, wsSnap] = await Promise.all([
    getDocs(collection(db, "roster")),
    getDocs(collection(db, "worksheets")),
  ]);
  rosterMap = {};
  rosterSnap.docs.forEach((d) => { rosterMap[d.id] = d.data(); });
  worksheetOrderMap = {};
  wsSnap.docs.forEach((d) => { worksheetOrderMap[d.id] = d.data().order ?? 0; });
}

export async function renderTeacher(access) {
  const root = document.getElementById("app-root");
  root.innerHTML = `
    <div class="tabs">
      <button class="tab active" id="tabReview">제출물 검토</button>
      <button class="tab" id="tabCompleted">완료된 과제</button>
      <button class="tab" id="tabWorksheets">학습지 문제 관리</button>
      <button class="tab" id="tabRoster">학생 명단</button>
    </div>
    <div id="t-body"></div>`;
  document.getElementById("tabReview").addEventListener("click", () => switchTab("review"));
  document.getElementById("tabCompleted").addEventListener("click", () => switchTab("completed"));
  document.getElementById("tabWorksheets").addEventListener("click", () => switchTab("worksheets"));
  document.getElementById("tabRoster").addEventListener("click", () => switchTab("roster"));
  await switchTab("review");
}

async function switchTab(tab) {
  document.getElementById("tabReview").classList.toggle("active", tab === "review");
  document.getElementById("tabCompleted").classList.toggle("active", tab === "completed");
  document.getElementById("tabWorksheets").classList.toggle("active", tab === "worksheets");
  document.getElementById("tabRoster").classList.toggle("active", tab === "roster");
  const body = document.getElementById("t-body");
  state.tab = tab;
  state.selected = null;
  if (tab === "review" || tab === "completed") {
    body.innerHTML = `
      ${tab === "review" ? `<div class="grade-bar">
        <button class="btn primary" id="gradeBtn">지금 채점하기</button>
        <span class="muted small" id="gradeStatus"></span>
      </div>` : ""}
      <div class="layout">
        <aside class="sidebar" id="t-list"></aside>
        <main class="main" id="t-main"><p class="muted center">왼쪽에서 ${tab === "review" ? "검토할" : "확인할"} 제출물을 선택하세요.</p></main>
      </div>`;
    if (tab === "review") document.getElementById("gradeBtn").addEventListener("click", runGrading);
    startListening();
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

    // 각 항목의 채점 초안(reviews) 로드 (있으면) — 항목이 많아도 느려지지 않도록 병렬로 조회.
    await Promise.all(items.map(async (it) => {
      const r = await getDoc(doc(db, "reviews", it.id));
      it.review = r.exists() ? r.data() : null;
    }));
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

    // 공개된 항목의 recognizedText가 마지막 채점 시점(reviews.recognizedText)과
    // 달라졌으면 — 학생이든 교사든 "사진으로 인식한 문장"을 고친 것이므로 —
    // 자동으로 재채점한다(버튼 없이도 동작, 이미지 아닌 텍스트라 토큰도 적게 듦).
    const needsRegrade = items.filter((it) =>
      it.status === "released" && it.answerType !== "text" && !it.completed &&
      it.recognizedText && it.review && it.recognizedText !== it.review.recognizedText
    );
    if (needsRegrade.length) {
      autoRegradeAll(needsRegrade);
    } else if (items.some((it) => it.status === "submitted")) {
      // 새로 제출된(=아직 채점 전인) 건이 있으면 버튼을 누른 것처럼 자동 채점한다.
      // 관리자 화면이 열려 있는 동안만 동작한다.
      runGrading();
    }
  });
}

async function autoRegradeAll(items) {
  isGrading = true;
  const statusEl = document.getElementById("gradeStatus");
  for (const it of items) {
    if (statusEl) statusEl.textContent = `"${it.studentEmail}" 학생이 수정한 문장으로 재채점 중…`;
    try {
      await performRegrade(it);
      if (state.selected === it.id) selectItem(it.id);
      else renderList();
    } catch (e) {
      console.error(`[자동 재채점 오류] ${it.id}:`, e);
    }
    if (items.indexOf(it) < items.length - 1) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
    }
  }
  if (statusEl) statusEl.textContent = "";
  isGrading = false;
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

      <div class="ws-grid">
      ${worksheets.map((w) => `
        <section class="card">
          <h3>${w.unit}단원 · ${w.title || w.code}</h3>

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
          <span class="ws-code">${w.title || w.code}</span>
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

  let body = `<header class="main-head"><h2>${ws.title || ws.code}</h2></header>`;
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
      : sub.status === "rejected" ? `반려됨${sub.rejectReason ? ` — ${escapeHtml(sub.rejectReason)}` : ""}`
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

async function loadPageImages(subId) {
  const snap = await getDocs(query(collection(db, "submissions", subId, "pages"), orderBy("order")));
  return snap.docs.map((d) => d.data().imageBase64).filter(Boolean);
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
async function performRegrade(it) {
  const wsSnap = await getDoc(doc(db, "worksheets", it.worksheetId));
  const wsData = wsSnap.exists() ? wsSnap.data() : {};
  let g;
  if (it.answerType === "text") {
    g = await gradeText(wsData.problem, it.answerText || "", wsData.referenceMaterial);
  } else if (it.recognizedText) {
    // 이미 인식된 문장이 있으면 이미지를 다시 보내지 않고 텍스트로 재채점(토큰 절약).
    g = await gradeText(wsData.problem, it.recognizedText, wsData.referenceMaterial);
  } else {
    // 인식된 문장이 없는(이 기능 이전에 채점된) 예전 항목만 이미지로 재채점.
    const imgs = await loadPageImages(it.id);
    if (!imgs.length) throw new Error("이미지 없음");
    g = await gradeImages(imgs, wsData.referenceMaterial);
  }
  await setDoc(doc(db, "reviews", it.id), g);
  const flat = toFlatGrade(g);
  await updateDoc(doc(db, "submissions", it.id), {
    grade: flat, feedback: g.feedback, recognizedText: g.recognizedText, gradedAt: serverTimestamp(),
  });
  it.grade = flat;
  it.feedback = g.feedback;
  it.recognizedText = g.recognizedText;
  it.review = g;
}

// "재채점" 버튼 클릭 핸들러: 확인창 + 버튼 로딩 상태 표시 후 performRegrade 실행.
async function regradeItem(it) {
  if (!confirm(`${it.worksheetId} · ${it.studentEmail} 항목을 다시 채점할까요?\n기존 점수·피드백이 새 결과로 덮어써집니다.`)) return;
  const btn = document.getElementById("regradeBtn");
  btn.disabled = true;
  btn.textContent = "재채점 중…";
  try {
    await performRegrade(it);
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "재채점";
    alert("재채점에 실패했습니다: " + e.message);
  }
}

async function runGrading() {
  if (isGrading) return; // 이미 채점 중이면(자동/수동 무관) 중복 실행 방지
  isGrading = true;
  const btn = document.getElementById("gradeBtn");
  const statusEl = document.getElementById("gradeStatus");
  btn.disabled = true;
  try {
    const snap = await getDocs(query(collection(db, "submissions"), where("status", "==", "submitted")));
    const subs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!subs.length) {
      statusEl.textContent = "채점할 새 제출물이 없습니다.";
      return;
    }
    let done = 0, released = 0, flagged = 0, errors = 0;
    for (const s of subs) {
      statusEl.textContent = `채점 중… (${done + errors + 1}/${subs.length})`;
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
          g = await gradeImages(imgs, wsData.referenceMaterial);
        }
        await setDoc(doc(db, "reviews", s.id), g);

        if (g.reviewFlag) {
          // AI가 확인이 필요하다고 표시한 건은 교사 검토 대기로 남긴다.
          await updateDoc(doc(db, "submissions", s.id), { status: "graded", gradedAt: serverTimestamp() });
          flagged++;
        } else {
          // 확인 필요 없는 건은 채점과 동시에 바로 공개한다.
          await updateDoc(doc(db, "submissions", s.id), {
            status: "released",
            gradedAt: serverTimestamp(),
            releasedAt: serverTimestamp(),
            grade: toFlatGrade(g),
            feedback: g.feedback,
            recognizedText: g.recognizedText,
          });
          released++;
        }
        done++;
      } catch (e) {
        errors++;
        console.error(`[채점 오류] ${s.id}:`, e);
      }
      if (subs.indexOf(s) < subs.length - 1) {
        await new Promise((r) => setTimeout(r, THROTTLE_MS));
      }
    }
    statusEl.textContent = `채점 완료: ${done}건 (자동 공개 ${released}건, 확인 필요 ${flagged}건, 오류 ${errors}건)`;
    // 목록은 실시간 구독(onSnapshot)이 자동으로 갱신한다.
  } catch (e) {
    statusEl.textContent = "채점 실패: " + e.message;
  } finally {
    btn.disabled = false;
    isGrading = false;
  }

  // 채점 도중 새로 제출된 건이 있으면(자동 트리거가 "채점 중"이라 건너뛰었을 수 있음) 이어서 채점한다.
  const stillPending = await getDocs(query(collection(db, "submissions"), where("status", "==", "submitted")));
  if (!stillPending.empty) runGrading();
}

const STATUS_LABEL = { submitted: "채점 대기", graded: "검토 대기", released: "공개됨", rejected: "반려됨" };
const STATUS_CLS   = { submitted: "s-none",   graded: "s-pending",  released: "s-done", rejected: "s-rejected" };

function renderList() {
  const list = document.getElementById("t-list");
  const visible = state.items.filter((it) => !!it.completed === (state.tab === "completed"));
  if (!visible.length) {
    list.innerHTML = `<p class="muted center">${state.tab === "completed" ? "완료된 과제가 없습니다." : "제출물이 없습니다."}</p>`;
    return;
  }

  // 이미 반→학습지순으로 정렬된 목록(state.items)을 반 단위 구역으로 묶어서 그린다.
  const byClass = {};
  visible.forEach((it) => {
    const cls = rosterMap[it.studentEmail]?.class ?? "미확인";
    (byClass[cls] ||= []).push(it);
  });
  const classes = Object.keys(byClass).sort((a, b) => {
    if (a === "미확인") return 1;
    if (b === "미확인") return -1;
    return Number(a) - Number(b);
  });

  list.innerHTML = classes.map((cls) => {
    const items = byClass[cls].map((it) => {
      const flag = it.review?.reviewFlag ? `<span class="badge s-flag">확인 필요</span>` : "";
      const active = state.selected === it.id ? "active" : "";
      const score = it.status === "released" ? it.grade?.total : it.review?.total;
      const num = rosterMap[it.studentEmail]?.number;
      const who = num ? `${num}번 ${it.studentEmail}` : it.studentEmail;
      return `<button class="ws-item ${active}" data-id="${it.id}">
          <span class="ws-code">${it.worksheetId} · ${who}</span>
          <span>${score ?? "-"}점
            <span class="badge ${STATUS_CLS[it.status] || "s-none"}">${STATUS_LABEL[it.status] || it.status}</span>
            ${flag}
          </span>
        </button>`;
    }).join("");
    return `<div class="unit"><div class="unit-title">${cls === "미확인" ? cls : cls + "반"}</div>${items}</div>`;
  }).join("");
  list.querySelectorAll(".ws-item").forEach((b) =>
    b.addEventListener("click", () => selectItem(b.dataset.id))
  );
}

async function selectItem(id) {
  state.selected = id;
  renderList();
  const it = state.items.find((x) => x.id === id);
  const main = document.getElementById("t-main");

  const imgs = it.answerType === "text"
    ? `<p class="feedback">${escapeHtml(it.answerText || "")}</p>`
    : await pagesHtml(it.id);

  // 공개된 건은 submissions.recognizedText(학생도 읽을 수 있는 사본), 그 전엔
  // reviews.recognizedText(초안)를 사용한다.
  const recognizedText = it.recognizedText ?? it.review?.recognizedText ?? "";

  const header = `
    <header class="main-head">
      <h2>${it.worksheetId} · ${it.studentEmail}</h2>
      <span class="badge ${STATUS_CLS[it.status] || "s-none"}">${STATUS_LABEL[it.status] || it.status}</span>
      <button class="btn ghost" id="completeBtn" style="margin-left:auto">${it.completed ? "완료 취소" : "과제 완료"}</button>
      <button class="btn ghost" id="deleteBtn">삭제</button>
    </header>`;

  if (it.status === "submitted") {
    main.innerHTML = `${header}
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="muted" style="margin-top:12px">아직 채점 전입니다. 위의 "지금 채점하기" 버튼을 눌러 채점하세요.</p>
      </section>`;
  } else if (it.status === "released") {
    const g = it.grade || {};
    const rows = [
      ["핵심 개념 이해", g.concept, 40], ["논리적 연결", g.logic, 25],
      ["근거·예시", g.evidence, 20], ["완성된 문장형식으로 작성", g.expression, 15],
    ].map(([label, val, max]) =>
      `<div class="crit"><span>${label}</span><b>${val ?? "-"} / ${max}</b></div>`
    ).join("");
    const recognizedSection = it.answerType !== "text" ? `
      <div class="recognized">
        <div class="fb-head"><h4>사진으로 인식한 문장</h4><button class="btn ghost" id="editRecognizedBtn">수정</button></div>
        <div id="recognizedView"><p class="feedback">${escapeHtml(recognizedText)}</p></div>
      </div>` : "";
    main.innerHTML = `${header}
      <section class="card">
        <div class="two">
          <div><h3>제출 답안</h3>${imgs}${recognizedSection}</div>
          <div>
            <div class="score-head">
              <div class="score"><span>${g.total ?? "-"}</span><small>/ 100</small></div>
              <div class="review-actions">
                <button class="btn ghost" id="regradeBtn">재채점</button>
                <button class="btn ghost" id="editScoreBtn">점수 수정</button>
                <button class="btn danger" id="rejectBtn">반려</button>
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
            await updateDoc(doc(db, "submissions", it.id), { recognizedText: newText });
            it.recognizedText = newText;
            selectItem(it.id);
          } catch (e) {
            saveBtn.disabled = false; saveBtn.textContent = "저장";
            alert("저장에 실패했습니다: " + e.message);
          }
        });
      });
    }

    document.getElementById("regradeBtn").addEventListener("click", () => regradeItem(it));
  } else if (it.status === "rejected") {
    main.innerHTML = `${header}
      <section class="card">
        <h3>제출 답안</h3>${imgs}
        <p class="muted small" style="margin-top:12px">반려 사유: ${escapeHtml(it.rejectReason || "(사유 없음)")}</p>
        <p class="muted" style="margin-top:12px">학생에게 반려되어 다시 제출을 기다리는 중입니다.</p>
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
              <button class="btn primary" id="releaseBtn">공개</button>
              <button class="btn danger" id="rejectBtn">반려</button>
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
    state.selected = null;
    renderList();
    document.getElementById("t-main").innerHTML =
      `<p class="muted center">${newVal ? "완료된 과제로 이동했습니다." : "제출물 검토로 되돌렸습니다."}</p>`;
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

// "반려" 버튼 클릭 핸들러: 사유를 입력받아 상태를 rejected로 바꾼다.
// 학생 화면에서는 이 상태가 "released"와 동일하게 취급되어 업로드 폼이 다시
// 열리고, 새로 제출하면(student.js) 반려된 이전 자료가 자동으로 삭제된다.
async function rejectSubmission(it) {
  const reason = prompt("반려 사유를 입력하세요 (학생에게 표시됩니다. 비워두면 사유 없이 반려)", "");
  if (reason === null) return; // 취소
  if (!confirm(`${it.worksheetId} · ${it.studentEmail} 제출물을 반려할까요?\n학생이 처음부터 다시 제출해야 합니다.`)) return;
  const btn = document.getElementById("rejectBtn");
  btn.disabled = true; btn.textContent = "반려 중…";
  try {
    await updateDoc(doc(db, "submissions", it.id), {
      status: "rejected", rejectReason: reason, rejectedAt: serverTimestamp(),
    });
    it.status = "rejected";
    it.rejectReason = reason;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "반려";
    alert("반려 처리에 실패했습니다: " + e.message);
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
  btn.disabled = true; btn.textContent = "공개 중…";
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
    const update = { grade, feedback, status: "released", releasedAt: serverTimestamp() };
    if (recognizedInput) update.recognizedText = recognizedInput.value;

    await updateDoc(doc(db, "submissions", it.id), update);

    it.status = "released";
    it.grade = grade;
    it.feedback = feedback;
    if (recognizedInput) it.recognizedText = recognizedInput.value;
    renderList();
    selectItem(it.id);
  } catch (e) {
    btn.disabled = false; btn.textContent = "공개";
    alert("공개에 실패했습니다: " + e.message);
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
    await deleteDoc(doc(db, "reviews", it.id));
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
  const snap = await getDocs(query(collection(db, "submissions", subId, "pages"), orderBy("order")));
  if (snap.empty) return `<p class="muted">이미지 없음</p>`;
  return `<div class="imgs">` + snap.docs.map((d) => {
    const src = d.data().imageBase64;
    return `<img src="${src}" alt="제출 이미지">`;
  }).join("") + `</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
