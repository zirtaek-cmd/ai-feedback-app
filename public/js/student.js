import { db } from "./firebase-init.js";
import {
  collection, doc, query, where, orderBy, getDocs, getDoc, addDoc, updateDoc, deleteDoc,
  runTransaction, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { compressImage } from "./compress.js";
import { wireLightboxImages } from "./lightbox.js";
import { gradeFreeform } from "./grade.js";

const MAX_ATTEMPTS = 5; // 최초 + 재제출 4회. 화면에만 표시되는 목표치이며, 넘어가도 제출 자체는 막지 않는다.

const STATUS = {
  none:     { key: "none",     label: "미제출",     cls: "s-none" },
  pending:  { key: "pending",  label: "검토 중",    cls: "s-pending" },
  released: { key: "released", label: "완료",       cls: "s-done" },
};

// 자유 채점: 참고자료가 등록된 단원만 고를 수 있게 학습지 코드와 순서대로 매칭.
const FREEFORM_UNITS = [
  { code: "4-1-1", label: "시각" },
  { code: "4-1-2", label: "청각" },
  { code: "4-1-3", label: "피부감각과 후각과 미각" },
  { code: "4-2-1", label: "신경계와 뉴런" },
  { code: "4-2-2", label: "의식적 반응과 무조건 반사" },
  { code: "4-2-3", label: "호르몬과 항상성" },
];
const FREEFORM_LIMIT = 5;
const FREEFORM_TTL_MS = 10 * 60 * 1000; // 10분 후 자동 삭제

let state = { worksheets: [], subsByWs: {}, selected: null, access: null, hasDraftInput: false, tab: "worksheets" };
let unsubscribeSubs = null;

export async function renderStudent(access) {
  state.access = access;
  setupBrandNav();
  await switchStudentTab("worksheets");
}

function setupBrandNav() {
  const nav = document.getElementById("brandNav");
  if (!nav) return;
  nav.innerHTML = `
    <button id="tabWorksheetsBtn" class="active">학습지 제출</button>
    <button id="tabFreeformBtn">AI 서술형 채점기</button>`;
  document.getElementById("tabWorksheetsBtn").addEventListener("click", () => switchStudentTab("worksheets"));
  document.getElementById("tabFreeformBtn").addEventListener("click", () => switchStudentTab("freeform"));
}

async function switchStudentTab(tab) {
  state.tab = tab;
  document.getElementById("tabWorksheetsBtn")?.classList.toggle("active", tab === "worksheets");
  document.getElementById("tabFreeformBtn")?.classList.toggle("active", tab === "freeform");
  if (unsubscribeSubs) { unsubscribeSubs(); unsubscribeSubs = null; }

  const root = document.getElementById("app-root");
  if (tab === "worksheets") {
    state.selected = null;
    root.innerHTML = `<div class="layout">
        <aside class="sidebar" id="sidebar"></aside>
        <main class="main" id="main"></main>
      </div>`;
    await loadWorksheets();
    listenSubmissions();
  } else {
    await renderFreeformTab(root);
  }
}

async function loadWorksheets() {
  const wsSnap = await getDocs(query(collection(db, "worksheets"), orderBy("order")));
  state.worksheets = wsSnap.docs.map((d) => d.data()).filter((w) => w.active !== false);
}

// 제출물을 실시간 구독한다 — 선생님이 채점/공개하면 새로고침 없이 바로 반영된다.
// 단, 업로드 폼(사진 선택·텍스트 입력 중)이 떠 있는 상태에서는 자동으로 다시
// 그리지 않는다(입력 중이던 내용이 날아가는 것을 방지).
function listenSubmissions() {
  if (unsubscribeSubs) unsubscribeSubs();
  unsubscribeSubs = onSnapshot(
    query(collection(db, "submissions"), where("studentUid", "==", state.access.uid)),
    (snap) => {
      const map = {};
      snap.docs.forEach((d) => {
        const s = { id: d.id, ...d.data() };
        (map[s.worksheetId] ||= []).push(s);
      });
      Object.values(map).forEach((arr) => arr.sort((a, b) => (a.attempt || 0) - (b.attempt || 0)));
      state.subsByWs = map;

      if (!state.selected) {
        renderSidebar();
        const first = state.worksheets[0];
        if (first) selectWorksheet(first.code);
      } else if (state.uploadFormRendered && state.hasDraftInput) {
        // 입력 폼에 실제로 사진을 고르거나 텍스트를 입력해둔 상태일 때만 갈아엎지
        // 않는다(입력 중이던 내용 보존). 폼만 떠 있고 아무것도 안 골랐으면 그냥 갱신.
        renderSidebar();
      } else {
        selectWorksheet(state.selected);
      }
    }
  );
}

function latestSub(code) {
  const arr = state.subsByWs[code];
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// 재제출 시 이전 자료를 삭제하므로, 남은 문서 개수가 아니라 최신 제출물의
// attempt 번호로 "지금까지 몇 번 제출했는지"를 판단한다.
function attemptsUsed(code) {
  const s = latestSub(code);
  return s ? (s.attempt || 0) : 0;
}

function statusOf(code) {
  const s = latestSub(code);
  if (!s) return STATUS.none;
  return s.status === "released" ? STATUS.released : STATUS.pending;
}

function renderSidebar() {
  const byUnit = {};
  state.worksheets.forEach((w) => (byUnit[w.unit] ||= []).push(w));
  const units = Object.keys(byUnit).sort((a, b) => a - b);

  const html = units.map((u) => {
    const items = byUnit[u].map((w) => {
      const st = statusOf(w.code);
      const active = state.selected === w.code ? "active" : "";
      return `<button class="ws-item ${active}" data-code="${w.code}">
          <span class="ws-code">${w.title || w.code}</span>
          <span class="badge ${st.cls}">${st.label}</span>
        </button>`;
    }).join("");
    return `<div class="unit"><div class="unit-title">${u}단원</div>${items}</div>`;
  }).join("");

  const sb = document.getElementById("sidebar");
  sb.innerHTML = html;
  sb.querySelectorAll(".ws-item").forEach((b) =>
    b.addEventListener("click", () => selectWorksheet(b.dataset.code))
  );
}

async function selectWorksheet(code) {
  state.selected = code;
  renderSidebar();
  const ws = state.worksheets.find((w) => w.code === code);
  const sub = latestSub(code);
  const attempts = attemptsUsed(code);
  const main = document.getElementById("main");

  // 헤더
  const st = statusOf(code);
  let body = `<header class="main-head">
      <h2>${ws.title || ws.code}</h2>
      <span class="badge ${st.cls}">${st.label}</span>
    </header>`;

  if (ws.problem) {
    body += `<section class="card"><h3>문제</h3><p class="feedback">${escapeHtml(ws.problem)}</p></section>`;
  }

  // 공개된 건 재제출 횟수와 무관하게 항상 다시 제출할 수 있다("남은 제출 횟수"는
  // 화면에만 보이는 목표치일 뿐, 실제로 더 이상의 제출을 막지는 않는다).
  state.uploadFormRendered = !sub || sub.status === "released";
  state.hasDraftInput = false;
  if (state.uploadFormRendered) {
    body += uploadPanel(attempts);
    if (sub) body += await resultPanel(sub); // 이전 공개 결과도 함께 보여줌
  } else {
    body += await pendingPanel(sub); // 검토 중
  }

  main.innerHTML = body;
  wireLightboxImages(main);
  wireUpload(code, attempts);
  if (sub) wireRecognizedEdit(sub, code);
  const cancelBtn = document.getElementById("cancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelSubmission(sub, code));
}

function uploadPanel(attempts) {
  const left = Math.max(0, MAX_ATTEMPTS - attempts);
  return `<section class="card upload">
      <div class="upload-head">
        <h3>답안 제출</h3>
        <span class="muted">남은 제출 ${left}회</span>
      </div>
      <div class="seg" id="modeSeg">
        <button type="button" class="active" data-mode="photo">사진으로 제출</button>
        <button type="button" data-mode="text">텍스트로 입력</button>
      </div>
      <div id="photoMode">
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <button class="drop" id="dropBtn">사진 선택 · 촬영 (여러 장 가능)</button>
        <div class="previews" id="previews"></div>
      </div>
      <div id="textMode" class="hidden">
        <textarea id="answerText" rows="8" placeholder="답안을 입력하세요"></textarea>
      </div>
      <button class="btn primary" id="submitBtn" disabled>제출</button>
      <p class="hint">제출하면 선생님 확인 뒤 점수·피드백이 공개됩니다.</p>
    </section>`;
}

async function pendingPanel(sub) {
  const content = await submittedContentHtml(sub);
  const cancelBtn = sub.status === "submitted"
    ? `<button class="btn ghost" id="cancelBtn">제출 취소</button>`
    : "";
  return `<section class="card">
      <div class="two">
        <div><h3>제출한 답안</h3>${content}</div>
        <div class="pending-note">
          <div class="dot"></div>
          <p>채점 검토 중입니다.<br>선생님이 확인하면 점수와 피드백이 여기에 표시됩니다.</p>
          ${cancelBtn}
        </div>
      </div>
    </section>`;
}

async function cancelSubmission(sub, code) {
  if (!confirm("제출을 취소할까요?\n제출한 내용이 삭제되고 다시 제출할 수 있습니다.")) return;
  const btn = document.getElementById("cancelBtn");
  if (btn) { btn.disabled = true; btn.textContent = "취소 중…"; }
  try {
    if (sub.answerType !== "text") {
      const pagesSnap = await getDocs(
        query(collection(db, "submissions", sub.id, "pages"), where("studentUid", "==", state.access.uid))
      );
      for (const p of pagesSnap.docs) {
        await deleteDoc(doc(db, "submissions", sub.id, "pages", p.id));
      }
    }
    await deleteDoc(doc(db, "submissions", sub.id));
    // 목록은 실시간 구독(onSnapshot)이 자동으로 갱신한다.
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "제출 취소"; }
    alert("취소에 실패했습니다: " + e.message);
  }
}

async function resultPanel(sub) {
  const content = await submittedContentHtml(sub);
  const g = sub.grade || {};
  const rows = [
    ["핵심 개념 이해", g.concept, 40],
    ["논리적 연결", g.logic, 25],
    ["근거·예시", g.evidence, 20],
    ["완성된 문장형식으로 작성", g.expression, 15],
  ].map(([label, val, max]) =>
    `<div class="crit"><span>${label}</span><b>${val ?? "-"} / ${max}</b></div>`
  ).join("");

  return `<section class="card">
      <div class="two">
        <div><h3>제출한 답안</h3>${content}</div>
        <div>
          <div class="score"><span>${g.total ?? "-"}</span><small>/ 100</small></div>
          <div class="crits">${rows}</div>
          <h4>피드백</h4>
          <p class="feedback">${escapeHtml(sub.feedback || "")}</p>
        </div>
      </div>
    </section>`;
}

async function submittedContentHtml(sub) {
  if (sub.answerType === "text") {
    return `<p class="feedback">${escapeHtml(sub.answerText || "")}</p>`;
  }
  const imgsHtml = await pagesHtml(sub.id);
  if (!sub.recognizedText) return imgsHtml;
  return imgsHtml + `
    <div class="recognized">
      <div class="fb-head"><h4>사진으로 인식한 문장</h4><button class="btn ghost" id="editRecognizedBtn">수정</button></div>
      <div id="recognizedView"><p class="feedback">${escapeHtml(sub.recognizedText)}</p></div>
    </div>`;
}

function wireRecognizedEdit(sub, code) {
  const editBtn = document.getElementById("editRecognizedBtn");
  if (!editBtn) return;
  editBtn.addEventListener("click", () => {
    document.getElementById("recognizedView").innerHTML = `
      <textarea id="recognizedEdit" rows="4">${escapeHtml(sub.recognizedText || "")}</textarea>
      <div class="fb-actions">
        <button class="btn primary" id="saveRecognizedBtn">저장</button>
        <button class="btn ghost" id="cancelRecognizedBtn">취소</button>
      </div>`;
    document.getElementById("cancelRecognizedBtn").addEventListener("click", () => selectWorksheet(code));
    document.getElementById("saveRecognizedBtn").addEventListener("click", async () => {
      const saveBtn = document.getElementById("saveRecognizedBtn");
      saveBtn.disabled = true;
      saveBtn.textContent = "저장 중…";
      try {
        const newText = document.getElementById("recognizedEdit").value;
        await updateDoc(doc(db, "submissions", sub.id), { recognizedText: newText });
        sub.recognizedText = newText;
        selectWorksheet(code);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = "저장";
        alert("저장에 실패했습니다: " + e.message);
      }
    });
  });
}

async function pagesHtml(subId) {
  const snap = await getDocs(
    query(
      collection(db, "submissions", subId, "pages"),
      where("studentUid", "==", state.access.uid),
      orderBy("order")
    )
  );
  if (snap.empty) return `<p class="muted">이미지 없음</p>`;
  return `<div class="imgs">` + snap.docs.map((d) => {
    const src = d.data().imageBase64;
    return `<img src="${src}" alt="제출 이미지">`;
  }).join("") + `</div>`;
}

function wireUpload(code, attempts) {
  const fileInput = document.getElementById("fileInput");
  const dropBtn = document.getElementById("dropBtn");
  const submitBtn = document.getElementById("submitBtn");
  const previews = document.getElementById("previews");
  const answerTextEl = document.getElementById("answerText");
  const modeSeg = document.getElementById("modeSeg");
  const photoModeEl = document.getElementById("photoMode");
  const textModeEl = document.getElementById("textMode");
  if (!fileInput) return;

  let mode = "photo";
  let dataUrls = [];

  function updateSubmitState() {
    const hasInput = mode === "photo" ? dataUrls.length > 0 : !!answerTextEl.value.trim();
    submitBtn.disabled = !hasInput;
    state.hasDraftInput = hasInput;
  }

  modeSeg.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode;
      modeSeg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      photoModeEl.classList.toggle("hidden", mode !== "photo");
      textModeEl.classList.toggle("hidden", mode !== "text");
      updateSubmitState();
    });
  });

  dropBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    dropBtn.textContent = "압축 중…";
    for (const f of fileInput.files) {
      try { dataUrls.push(await compressImage(f)); } catch (_) {}
    }
    previews.innerHTML = dataUrls.map((u) => `<img src="${u}" alt="미리보기">`).join("");
    dropBtn.textContent = "사진 더 추가";
    updateSubmitState();
  });

  answerTextEl.addEventListener("input", updateSubmitState);

  submitBtn.addEventListener("click", async () => {
    if (mode === "photo" && !dataUrls.length) return;
    if (mode === "text" && !answerTextEl.value.trim()) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "제출 중…";
    try {
      const prevSub = latestSub(code); // 재제출이면 공개된 이전 제출물(있으면 나중에 삭제)
      const attempt = attempts + 1;
      const base = {
        studentUid: state.access.uid,
        studentEmail: state.access.email,
        worksheetId: code,
        status: "submitted",
        attempt,
        submittedAt: serverTimestamp(),
        answerType: mode,
      };
      if (mode === "text") base.answerText = answerTextEl.value.trim();

      const subRef = await addDoc(collection(db, "submissions"), base);

      if (mode === "photo") {
        for (let i = 0; i < dataUrls.length; i++) {
          await addDoc(collection(db, "submissions", subRef.id, "pages"), {
            imageBase64: dataUrls[i], order: i, studentUid: state.access.uid,
          });
        }
      }

      if (prevSub) {
        // 재제출이므로 이전 자료(이미지/텍스트)는 지운다. attempt 번호는 새 제출물에
        // 이어져 있으니 제출 횟수 제한은 계속 정상 동작한다.
        if (prevSub.answerType !== "text") {
          const prevPages = await getDocs(
            query(collection(db, "submissions", prevSub.id, "pages"), where("studentUid", "==", state.access.uid))
          );
          for (const p of prevPages.docs) {
            await deleteDoc(doc(db, "submissions", prevSub.id, "pages", p.id));
          }
        }
        await deleteDoc(doc(db, "submissions", prevSub.id));
      }

      // 실시간 구독이 곧 갱신하겠지만, 즉각적인 화면 반응을 위해 로컬 상태도 바로 반영.
      state.subsByWs[code] = [{ id: subRef.id, ...base }];
      renderSidebar();
      selectWorksheet(code);
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "제출";
      alert("제출에 실패했습니다: " + e.message);
    }
  });
}

// ---------- 자유 채점 (학습지에 안 묶인 문제 사진 채점) ----------

async function renderFreeformTab(root) {
  root.innerHTML = `
    <div class="layout">
      <main class="main freeform-main">
        <header class="main-head"><h2>AI 서술형 채점기</h2></header>
        <p class="muted small">학습지에 없는 다른 문제지나 교과서 문제를 사진으로 올려서 채점받아볼 수 있어요.
          단원별 참고자료를 기준으로 채점되고, 결과는 10분 후 자동으로 삭제됩니다.</p>
        <section class="card upload">
          <label class="fb-label">단원 선택</label>
          <select id="ffUnit">
            ${FREEFORM_UNITS.map((u) => `<option value="${u.code}">${u.label}</option>`).join("")}
          </select>
          <input type="file" id="ffFileInput" accept="image/*" multiple hidden />
          <button class="drop" id="ffDropBtn" style="margin-top:12px">사진 선택 · 촬영 (여러 장 가능)</button>
          <div class="previews" id="ffPreviews"></div>
          <button class="btn primary" id="ffSubmitBtn" disabled style="margin-top:12px">채점하기</button>
          <p class="muted small" id="ffUsage" style="margin-top:8px"></p>
        </section>
        <div id="ffResult"></div>
      </main>
    </div>`;

  await sweepExpiredFreeform();
  await refreshFreeformUsage();
  wireFreeformUpload();
}

async function refreshFreeformUsage() {
  const snap = await getDoc(doc(db, "freeformUsage", state.access.uid));
  const count = snap.exists() ? snap.data().count : 0;
  const left = Math.max(0, FREEFORM_LIMIT - count);
  state.freeformLeft = left; // 사진 선택 핸들러에서 참조해 버튼이 잘못 재활성화되지 않게 함
  const usageEl = document.getElementById("ffUsage");
  if (usageEl) usageEl.textContent = `남은 사용 횟수: ${left}/${FREEFORM_LIMIT}`;
  const submitBtn = document.getElementById("ffSubmitBtn");
  if (submitBtn && left <= 0) {
    submitBtn.disabled = true;
    submitBtn.textContent = "사용 횟수를 모두 사용했습니다";
  }
  return left;
}

// 사용 횟수를 원자적으로 확인+증가한다. 5회 이상이면 예외를 던진다.
// 서버 규칙에서도 "정확히 +1, 5 미만일 때만" 을 강제하므로 클라이언트 코드를
// 조작해도 우회할 수 없다.
async function reserveFreeformUsage() {
  const ref = doc(db, "freeformUsage", state.access.uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.data().count : 0;
    if (current >= FREEFORM_LIMIT) {
      throw new Error(`사용 횟수(${FREEFORM_LIMIT}회)를 모두 사용했습니다.`);
    }
    if (snap.exists()) tx.update(ref, { count: current + 1 });
    else tx.set(ref, { count: 1 });
    return current + 1;
  });
}

async function deleteFreeformSubmission(id) {
  const pagesSnap = await getDocs(
    query(collection(db, "freeformSubmissions", id, "pages"), where("studentUid", "==", state.access.uid))
  );
  for (const p of pagesSnap.docs) {
    await deleteDoc(doc(db, "freeformSubmissions", id, "pages", p.id));
  }
  await deleteDoc(doc(db, "freeformSubmissions", id));
}

// 탭을 열 때마다 본인의 10분 지난 결과를 정리한다 — 탭을 미리 닫아서
// setTimeout이 못 돌았던 경우를 대비한 보완 장치.
async function sweepExpiredFreeform() {
  const snap = await getDocs(query(collection(db, "freeformSubmissions"), where("studentUid", "==", state.access.uid)));
  const now = Date.now();
  for (const d of snap.docs) {
    const createdMs = d.data().createdAt?.toMillis ? d.data().createdAt.toMillis() : 0;
    if (createdMs && now - createdMs > FREEFORM_TTL_MS) {
      try { await deleteFreeformSubmission(d.id); } catch (_) {}
    }
  }
}

function scheduleFreeformDeletion(id) {
  setTimeout(() => {
    deleteFreeformSubmission(id).catch(() => {});
    if (state.tab === "freeform") {
      const resultEl = document.getElementById("ffResult");
      if (resultEl) resultEl.innerHTML = `<p class="muted center">10분이 지나 결과가 삭제되었습니다.</p>`;
    }
  }, FREEFORM_TTL_MS);
}

function renderFreeformResult(unitLabel, g) {
  const rows = [
    ["핵심 개념 이해", g.concept?.score, 40],
    ["논리적 연결", g.logic?.score, 25],
    ["근거·예시", g.evidence?.score, 20],
    ["완성된 문장형식으로 작성", g.expression?.score, 15],
  ].map(([label, val, max]) =>
    `<div class="crit"><span>${label}</span><b>${val ?? "-"} / ${max}</b></div>`
  ).join("");

  const resultEl = document.getElementById("ffResult");
  if (!resultEl) return;
  resultEl.innerHTML = `
    <section class="card">
      <h3>${escapeHtml(unitLabel)} · 채점 결과 <span class="muted small">(10분 후 자동 삭제)</span></h3>
      <div class="score"><span>${g.total ?? "-"}</span><small>/ 100</small></div>
      <div class="crits">${rows}</div>
      <h4>피드백</h4>
      <p class="feedback">${escapeHtml(g.feedback || "")}</p>
      <div class="recognized">
        <h4>모범답안 (100점)</h4>
        <p class="feedback">${escapeHtml(g.modelAnswer || "")}</p>
      </div>
    </section>`;
}

function wireFreeformUpload() {
  const fileInput = document.getElementById("ffFileInput");
  const dropBtn = document.getElementById("ffDropBtn");
  const previews = document.getElementById("ffPreviews");
  const submitBtn = document.getElementById("ffSubmitBtn");
  const unitSelect = document.getElementById("ffUnit");

  let dataUrls = [];

  dropBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    dropBtn.textContent = "압축 중…";
    for (const f of fileInput.files) {
      try { dataUrls.push(await compressImage(f)); } catch (_) {}
    }
    previews.innerHTML = dataUrls.map((u) => `<img src="${u}" alt="미리보기">`).join("");
    dropBtn.textContent = "사진 더 추가";
    submitBtn.disabled = dataUrls.length === 0 || state.freeformLeft <= 0;
    if (state.freeformLeft <= 0) submitBtn.textContent = "사용 횟수를 모두 사용했습니다";
  });

  submitBtn.addEventListener("click", async () => {
    if (!dataUrls.length) return;
    submitBtn.disabled = true;
    submitBtn.textContent = "채점 중…";
    try {
      await reserveFreeformUsage(); // 한도 초과면 여기서 예외 발생, 이후 진행 안 함

      const unit = FREEFORM_UNITS.find((u) => u.code === unitSelect.value);
      const wsSnap = await getDoc(doc(db, "worksheets", unit.code));
      const referenceMaterial = wsSnap.exists() ? wsSnap.data().referenceMaterial : "";

      const g = await gradeFreeform(dataUrls, referenceMaterial);

      const ref = await addDoc(collection(db, "freeformSubmissions"), {
        studentUid: state.access.uid,
        studentEmail: state.access.email,
        unitCode: unit.code,
        unitLabel: unit.label,
        grade: {
          total: g.total,
          concept: g.concept?.score ?? 0,
          logic: g.logic?.score ?? 0,
          evidence: g.evidence?.score ?? 0,
          expression: g.expression?.score ?? 0,
        },
        feedback: g.feedback,
        modelAnswer: g.modelAnswer,
        createdAt: serverTimestamp(),
      });
      for (let i = 0; i < dataUrls.length; i++) {
        await addDoc(collection(db, "freeformSubmissions", ref.id, "pages"), {
          imageBase64: dataUrls[i], order: i, studentUid: state.access.uid,
        });
      }

      renderFreeformResult(unit.label, g);
      scheduleFreeformDeletion(ref.id);

      dataUrls = [];
      previews.innerHTML = "";
      fileInput.value = "";
      submitBtn.textContent = "채점하기";
      await refreshFreeformUsage();
    } catch (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "채점하기";
      alert("채점에 실패했습니다: " + e.message);
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
