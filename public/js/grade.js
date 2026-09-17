// 브라우저에서 직접 Gemini API를 호출해 채점한다 (grade.py와 동일한 채점 기준).
// Firebase Blaze(과금) 플랜 없이 관리자 화면 버튼만으로 채점을 트리거하기 위한 용도.
import { GEMINI_API_KEY, GEMINI_MODEL } from "../config.js";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    total: { type: "INTEGER" },
    concept: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    logic: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    evidence: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    expression: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    recognizedText: { type: "STRING" },
    feedback: { type: "STRING" },
    reviewFlag: { type: "BOOLEAN" },
    reviewReason: { type: "STRING" },
  },
  required: ["total", "concept", "logic", "evidence", "expression", "recognizedText", "feedback", "reviewFlag", "reviewReason"],
};

const SCIENCE_ACCURACY = `[과학적 정확성 — 최우선 원칙, 채점자(당신) 스스로에게 적용]
- 당신은 경량(lite) 모델이라 사실관계나 개념을 착각할 가능성이 평소보다 높다.
  이 점을 인지하고 스스로의 판단을 한 번 더 의심하며 검증한다.
- 채점 근거로 삼는 모범답안·note·feedback에 과학 개념 오류가 있으면 절대 안
  된다. 최종 출력 전, 당신이 작성한 모든 과학적 진술이 중학교 3학년
  교육과정 및 실제 과학적 사실과 정확히 일치하는지 엄격하고 꼼꼼하게
  스스로 재검증한다.
- 학생 답안과 비교할 모범답안 자체가 틀리면 채점 전체가 잘못되므로, 먼저
  모범답안의 과학적 정확성부터 확실히 확인한 뒤 학생 답안을 채점한다.
- 조금이라도 확신이 서지 않는 과학적 판단이 있으면 단정하지 말고,
  reviewFlag=true 로 표시해 교사가 직접 확인하게 한다.`;

// 학습지에 참고자료(교과서 핵심 개념 요약)가 등록돼 있으면, 그걸 최우선 채점
// 기준으로 삼도록 지시하는 섹션을 만든다. 없으면 빈 문자열(기존 방식대로 동작).
function referenceSection(referenceMaterial) {
  if (!referenceMaterial) return "";
  return `\n[참고자료 — 이 학습지 단원의 정확한 과학 개념 설명]
아래는 이 학습지가 다루는 단원의 교과서 핵심 개념을 정리한 자료다. 학생 답안의
과학적 정확성은 당신의 지식이 아니라 반드시 이 참고자료를 기준으로 판단한다.
참고자료와 어긋나는 서술은 오답으로 처리하고, 참고자료에 없는 내용을 판단해야
할 때만 위 [과학적 정확성] 원칙에 따라 신중하게 스스로 검증한다.

${referenceMaterial}
`;
}

function imagePrompt(referenceMaterial) {
  return `당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
이미지에는 학습지의 '문제'와 학생이 손으로 쓴 '답안'이 함께 있습니다.
먼저 이미지에서 문제를 읽고, 그 문제에 대한 학생의 답안을 아래 기준으로 채점하세요.

[작성 절차]
1. 이미지에서 학생이 손으로 쓴 답안 부분을 판독해, 원문 그대로(요약·교정하지
   말고, 문제 텍스트는 제외하고 학생이 쓴 부분만) recognizedText 에 옮겨 적는다.
2. 문제와 답안을 파악해 채점 초안(점수·note·feedback)을 작성한다.
3. 그 초안을 다시 검토한다 — 채점 기준을 빠짐없이 반영했는지, 점수와 note·feedback
   내용이 서로 앞뒤가 맞는지, 사실관계나 과학적 오류는 없는지 확인한다.
4. 검토 결과 발견한 오류나 누락을 수정·보완하여 최종 결과만 출력한다.
   (초안이나 검토 과정 자체는 출력하지 않는다.)

${SCIENCE_ACCURACY}
${referenceSection(referenceMaterial)}
[채점 기준 — 중요도 순, 100점]
1. 핵심 개념을 맞게 이해했는가 (40점)  → concept
2. 문장이 논리적으로 이어지는가 (25점)  → logic
3. 근거·예시를 들었는가 (20점)          → evidence
4. 완성된 문장 형식으로 작성했는가 (15점)      → expression

[피드백 원칙]
- 격려성 문구 없이, 문제에서 다뤄야 할 내용 중심으로 작성한다.
- 맞은 점 / 빠진 점 / 보완할 점을 구체적으로 쓴다.
- 정답 기준이 별도로 주어지지 않으므로, 문제를 읽고 과학적으로 타당한
  모범답안을 스스로 판단해 채점한다.
- 이 문제를 푸는 대상은 중학교 3학년 학생이다. 모범답안·채점·피드백 모두
  중학교 3학년 교육과정 수준에서 판단하고, 고등학교 이상 수준의 개념·용어·
  표현을 요구하거나 사용하지 않는다.
- 손글씨가 흐리거나 잘려 판독이 애매하면 reviewFlag=true 로 표시하고
  reviewReason 에 이유를 적는다(그 외에는 false).`;
}

function textPrompt(problem, answer, referenceMaterial) {
  return `당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
아래는 학습지의 '문제'와 학생이 직접 입력한 '답안'입니다.

[문제]
${problem || "(미등록)"}

[학생 답안]
${answer}

[작성 절차]
1. 문제와 답안을 파악해 채점 초안(점수·note·feedback)을 작성한다.
2. 그 초안을 다시 검토한다 — 채점 기준을 빠짐없이 반영했는지, 점수와 note·feedback
   내용이 서로 앞뒤가 맞는지, 사실관계나 과학적 오류는 없는지 확인한다.
3. 검토 결과 발견한 오류나 누락을 수정·보완하여 최종 결과만 출력한다.
   (초안이나 검토 과정 자체는 출력하지 않는다.)

${SCIENCE_ACCURACY}
${referenceSection(referenceMaterial)}
[채점 기준 — 중요도 순, 100점]
1. 핵심 개념을 맞게 이해했는가 (40점)  → concept
2. 문장이 논리적으로 이어지는가 (25점)  → logic
3. 근거·예시를 들었는가 (20점)          → evidence
4. 완성된 문장 형식으로 작성했는가 (15점)      → expression

[피드백 원칙]
- 격려성 문구 없이, 문제에서 다뤄야 할 내용 중심으로 작성한다.
- 맞은 점 / 빠진 점 / 보완할 점을 구체적으로 쓴다.
- 정답 기준이 별도로 주어지지 않으므로, 문제를 읽고 과학적으로 타당한
  모범답안을 스스로 판단해 채점한다.
- 이 문제를 푸는 대상은 중학교 3학년 학생이다. 모범답안·채점·피드백 모두
  중학교 3학년 교육과정 수준에서 판단하고, 고등학교 이상 수준의 개념·용어·
  표현을 요구하거나 사용하지 않는다.
- [문제]가 비어 있으면 채점할 수 없으니 reviewFlag=true 로 표시하고
  reviewReason 에 "문제 텍스트 미등록"이라고 적는다(그 외에는 false).`;
}

const CRIT_LABELS = { concept: "핵심 개념 이해", logic: "논리적 연결", evidence: "근거·예시", expression: "완성된 문장형식으로 작성" };
const CRIT_MAX = { concept: 40, logic: 25, evidence: 20, expression: 15 };

// 95점 미만이면 만점이 아닌 채점 기준을 짚어, 각 기준의 채점 note를 근거로
// 무엇을 보충해야 하는지까지 구체적으로 피드백에 덧붙인다.
function appendResubmitNote(g) {
  if (g.total >= 95) return g;
  const weak = Object.keys(CRIT_LABELS).filter((k) => (g[k]?.score ?? 0) < CRIT_MAX[k]);
  const keys = weak.length ? weak : Object.keys(CRIT_LABELS);
  const detail = keys.map((k) => `- ${CRIT_LABELS[k]}: ${g[k]?.note || ""}`).join("\n");
  g.feedback = `${g.feedback || ""}\n\n[보충이 필요한 부분]\n${detail}\n\n위 내용을 보충, 수정하여 다시 작성하여 제출해보세요.`.trim();
  return g;
}

async function callGemini(parts, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error("Gemini 응답에 결과 텍스트가 없습니다.");
  return JSON.parse(text);
}

// dataUrls: "data:image/jpeg;base64,...." 배열
export async function gradeImages(dataUrls, referenceMaterial) {
  const parts = [
    { text: imagePrompt(referenceMaterial) },
    ...dataUrls.map((u) => ({
      inlineData: { mimeType: "image/jpeg", data: u.split(",", 2)[1] || u },
    })),
  ];
  const g = await callGemini(parts, SCHEMA);
  return appendResubmitNote(g);
}

export async function gradeText(problem, answer, referenceMaterial) {
  const g = await callGemini([{ text: textPrompt(problem, answer, referenceMaterial) }], SCHEMA);
  g.recognizedText = answer; // 텍스트 답안은 이미 원문이 있으므로 모델 출력 대신 그대로 사용
  return appendResubmitNote(g);
}

// ---------- 자유 채점(AI 서술형 채점기) 전용 ----------
// 재제출 개념이 없는 1회성 도구라 recognizedText 대신, 횟수가 아까운 학생에게
// 더 유용한 "100점짜리 모범답안"을 만들어 보여준다.
const SCHEMA_FREEFORM = {
  type: "OBJECT",
  properties: {
    total: { type: "INTEGER" },
    concept: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    logic: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    evidence: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    expression: { type: "OBJECT", properties: { score: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["score", "note"] },
    modelAnswer: { type: "STRING" },
    feedback: { type: "STRING" },
    reviewFlag: { type: "BOOLEAN" },
    reviewReason: { type: "STRING" },
  },
  required: ["total", "concept", "logic", "evidence", "expression", "modelAnswer", "feedback", "reviewFlag", "reviewReason"],
};

function freeformImagePrompt(referenceMaterial) {
  return `당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
이미지에는 문제와 학생이 손으로 쓴 답안이 함께 있습니다.
먼저 이미지에서 문제를 읽고, 그 문제에 대한 학생의 답안을 아래 기준으로 채점하세요.

[작성 절차]
1. 이미지에서 문제를 파악하고, 학생 답안을 기준에 따라 채점 초안(점수·note·
   feedback)을 작성한다.
2. 그 문제에 대한 100점짜리 모범답안을 modelAnswer 에 완성된 문장으로 작성한다
   — 이 문제가 요구하는 내용을 빠짐없이, 정확하게 담는다.
3. 채점 초안과 모범답안을 다시 검토한다 — 채점 기준을 빠짐없이 반영했는지,
   점수·note·feedback·모범답안 내용이 서로 앞뒤가 맞는지, 사실관계나 과학적
   오류는 없는지 확인한다.
4. 검토 결과 발견한 오류나 누락을 수정·보완하여 최종 결과만 출력한다.
   (초안이나 검토 과정 자체는 출력하지 않는다.)

${SCIENCE_ACCURACY}
${referenceSection(referenceMaterial)}
[채점 기준 — 중요도 순, 100점]
1. 핵심 개념을 맞게 이해했는가 (40점)  → concept
2. 문장이 논리적으로 이어지는가 (25점)  → logic
3. 근거·예시를 들었는가 (20점)          → evidence
4. 완성된 문장 형식으로 작성했는가 (15점)      → expression

[피드백 원칙]
- 격려성 문구 없이, 문제에서 다뤄야 할 내용 중심으로 작성한다.
- 맞은 점 / 빠진 점 / 보완할 점을 구체적으로 쓴다.
- 이 문제를 푸는 대상은 중학교 3학년 학생이다. 모범답안·채점·피드백 모두
  중학교 3학년 교육과정 수준에서 판단하고, 고등학교 이상 수준의 개념·용어·
  표현을 요구하거나 사용하지 않는다.
- 손글씨가 흐리거나 잘려 판독이 애매하면 reviewFlag=true 로 표시하고
  reviewReason 에 이유를 적는다(그 외에는 false).`;
}

export function gradeFreeform(dataUrls, referenceMaterial) {
  const parts = [
    { text: freeformImagePrompt(referenceMaterial) },
    ...dataUrls.map((u) => ({
      inlineData: { mimeType: "image/jpeg", data: u.split(",", 2)[1] || u },
    })),
  ];
  return callGemini(parts, SCHEMA_FREEFORM);
}

const SUMMARY_PROMPT = `당신은 중학교 3학년 과학 교사입니다. 첨부된 교과서 PDF 단원의
핵심 과학 개념을, 서술형 답안을 채점할 때 "정답 기준"으로 바로 쓸 수 있도록
정리하세요.

- 이 단원에서 다루는 핵심 개념·용어·인과관계를 빠짐없이, 정확하게 정리한다.
- 교과서에 있는 내용만 사실대로 쓰고, 추측하거나 새로 지어내지 않는다.
- 개조식(항목별 bullet)으로 간결하게 쓴다 — 채점자가 빠르게 대조할 수 있어야 한다.
- 삽화 설명, 페이지 번호, 활동 안내 문구, 형성평가 문제 등은 제외하고 개념
  설명 내용만 담는다.
- 다른 설명 없이 정리된 개념 내용만 바로 출력한다.`;

// PDF(base64, 헤더 제외)를 Gemini에 보내 채점 기준용 요약 텍스트를 생성한다.
// 이렇게 한 번 만든 요약을 worksheets.referenceMaterial 에 저장해두고
// 이후 채점부터는 이 짧은 텍스트만 재사용한다(원본 PDF를 매번 다시 보내지 않음).
export async function summarizeReference(pdfBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: SUMMARY_PROMPT },
          { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API 오류 (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!text) throw new Error("Gemini 응답에 요약 텍스트가 없습니다.");
  return text.trim();
}
