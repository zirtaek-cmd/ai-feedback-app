"""
grade.py — 밀린 제출물을 Gemini로 채점해 '초안'을 reviews/ 에 저장한다.

  사용: python grade.py
  전제:
    - serviceAccountKey.json (Firebase 서비스 계정 키, 로컬·gitignore)
    - .env 에 GEMINI_API_KEY (Google AI Studio 무료 키)
  흐름:
    submissions.status == "submitted" 조회
      → 각 제출의 pages(이미지) 로드 (문제·답안 모두 이미지에 있음)
      → Gemini 채점(구조화 JSON)
      → reviews/{id} 에 초안 저장 + submissions.status = "graded"
    ※ 학생 공개는 여기서 하지 않는다(교사 검토·공개는 웹 교사 화면에서).

주의:
  - google-genai SDK 버전에 따라 Part 생성/호출부 형태가 조금 다를 수 있음.
    설치된 버전 기준으로 Claude Code가 맞춰 조정할 것.
  - 무료 등급은 분당 요청 한도(RPM 약 10~15)가 있으므로 THROTTLE_SEC 로 천천히 처리.
  - 무료 등급에서 쓸 수 있는 멀티모달 모델/한도는 수시로 바뀐다.
    Google AI Studio의 rate limits 페이지에서 확인해 GEMINI_MODEL 을 맞출 것.
"""
import os, time, base64, json
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore
from google import genai
from google.genai import types
from pydantic import BaseModel

load_dotenv()

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")  # ← 무료 등급 가용 모델로 지정
THROTTLE_SEC   = float(os.environ.get("THROTTLE_SEC", "5"))          # 무료 RPM 대응

# ---------- 채점 결과 스키마 ----------
class Criterion(BaseModel):
    score: int
    note: str

class Grade(BaseModel):
    total: int
    concept: Criterion       # ① 핵심 개념 이해 (40)
    logic: Criterion         # ② 논리적 연결 (25)
    evidence: Criterion      # ③ 근거·예시 (20)
    expression: Criterion    # ④ 완성된 문장형식으로 작성 (15)
    recognizedText: str      # 이미지에서 판독한 학생 답안 원문
    feedback: str
    reviewFlag: bool
    reviewReason: str

SCIENCE_ACCURACY = """[과학적 정확성 — 최우선 원칙, 채점자(당신) 스스로에게 적용]
- 당신은 경량(lite) 모델이라 사실관계나 개념을 착각할 가능성이 평소보다 높다.
  이 점을 인지하고 스스로의 판단을 한 번 더 의심하며 검증한다.
- 채점 근거로 삼는 모범답안·note·feedback에 과학 개념 오류가 있으면 절대 안
  된다. 최종 출력 전, 당신이 작성한 모든 과학적 진술이 중학교 3학년
  교육과정 및 실제 과학적 사실과 정확히 일치하는지 엄격하고 꼼꼼하게
  스스로 재검증한다.
- 학생 답안과 비교할 모범답안 자체가 틀리면 채점 전체가 잘못되므로, 먼저
  모범답안의 과학적 정확성부터 확실히 확인한 뒤 학생 답안을 채점한다.
- 조금이라도 확신이 서지 않는 과학적 판단이 있으면 단정하지 말고,
  reviewFlag=true 로 표시해 교사가 직접 확인하게 한다."""


def reference_section(reference_material):
    """학습지에 참고자료(교과서 핵심 개념 요약)가 등록돼 있으면, 그걸 최우선
    채점 기준으로 삼도록 지시하는 섹션을 만든다. 없으면 빈 문자열."""
    if not reference_material:
        return ""
    return f"""
[참고자료 — 이 학습지 단원의 정확한 과학 개념 설명]
아래는 이 학습지가 다루는 단원의 교과서 핵심 개념을 정리한 자료다. 학생 답안의
과학적 정확성은 당신의 지식이 아니라 반드시 이 참고자료를 기준으로 판단한다.
참고자료와 어긋나는 서술은 오답으로 처리하고, 참고자료에 없는 내용을 판단해야
할 때만 위 [과학적 정확성] 원칙에 따라 신중하게 스스로 검증한다.

{reference_material}
"""


def build_image_prompt(reference_material=None):
    return f"""당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
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

{SCIENCE_ACCURACY}
{reference_section(reference_material)}
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
  reviewReason 에 이유를 적는다(그 외에는 false).
"""


def build_text_prompt(problem, answer, reference_material=None):
    return f"""당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
아래는 학습지의 '문제'와 학생이 직접 입력한 '답안'입니다.

[문제]
{problem or "(미등록)"}

[학생 답안]
{answer}

[작성 절차]
1. 문제와 답안을 파악해 채점 초안(점수·note·feedback)을 작성한다.
2. 그 초안을 다시 검토한다 — 채점 기준을 빠짐없이 반영했는지, 점수와 note·feedback
   내용이 서로 앞뒤가 맞는지, 사실관계나 과학적 오류는 없는지 확인한다.
3. 검토 결과 발견한 오류나 누락을 수정·보완하여 최종 결과만 출력한다.
   (초안이나 검토 과정 자체는 출력하지 않는다.)

{SCIENCE_ACCURACY}
{reference_section(reference_material)}
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
  reviewReason 에 "문제 텍스트 미등록"이라고 적는다(그 외에는 false).
"""


SUMMARY_PROMPT = """당신은 중학교 3학년 과학 교사입니다. 첨부된 교과서 PDF 단원의
핵심 과학 개념을, 서술형 답안을 채점할 때 "정답 기준"으로 바로 쓸 수 있도록
정리하세요.

- 이 단원에서 다루는 핵심 개념·용어·인과관계를 빠짐없이, 정확하게 정리한다.
- 교과서에 있는 내용만 사실대로 쓰고, 추측하거나 새로 지어내지 않는다.
- 개조식(항목별 bullet)으로 간결하게 쓴다 — 채점자가 빠르게 대조할 수 있어야 한다.
- 삽화 설명, 페이지 번호, 활동 안내 문구, 형성평가 문제 등은 제외하고 개념
  설명 내용만 담는다.
- 다른 설명 없이 정리된 개념 내용만 바로 출력한다."""

# ---------- Firebase ----------
firebase_admin.initialize_app(credentials.Certificate("serviceAccountKey.json"))
db = firestore.client()
client = genai.Client(api_key=GEMINI_API_KEY)


def grade_images(image_bytes_list, reference_material=None):
    parts = [build_image_prompt(reference_material)] + [
        types.Part.from_bytes(data=b, mime_type="image/jpeg") for b in image_bytes_list
    ]
    res = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=parts,
        config={"response_mime_type": "application/json", "response_schema": Grade},
    )
    return json.loads(res.text)


def grade_text(problem, answer, reference_material=None):
    prompt = build_text_prompt(problem, answer, reference_material)
    res = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config={"response_mime_type": "application/json", "response_schema": Grade},
    )
    g = json.loads(res.text)
    g["recognizedText"] = answer  # 텍스트 답안은 이미 원문이 있으므로 모델 출력 대신 그대로 사용
    return g


def summarize_reference(pdf_path):
    """교과서 PDF를 한 번 읽어 채점 기준용 요약 텍스트를 만든다.
    이 요약을 worksheets/{code}.referenceMaterial 에 저장해두고 이후
    채점부터는 이 짧은 텍스트만 재사용한다(원본 PDF를 매번 다시 보내지 않음)."""
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()
    res = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=[SUMMARY_PROMPT, types.Part.from_bytes(data=pdf_bytes, mime_type="application/pdf")],
    )
    return res.text.strip()


CRIT_LABELS = {"concept": "핵심 개념 이해", "logic": "논리적 연결", "evidence": "근거·예시", "expression": "완성된 문장형식으로 작성"}
CRIT_MAX = {"concept": 40, "logic": 25, "evidence": 20, "expression": 15}


def append_resubmit_note(g):
    """95점 미만이면 만점이 아닌 채점 기준을 짚어, 각 기준의 채점 note를 근거로
    무엇을 보충해야 하는지까지 구체적으로 피드백에 덧붙인다."""
    if g.get("total", 0) >= 95:
        return g
    weak = [k for k in CRIT_LABELS if g.get(k, {}).get("score", 0) < CRIT_MAX[k]]
    keys = weak if weak else list(CRIT_LABELS)
    detail = "\n".join(f"- {CRIT_LABELS[k]}: {g.get(k, {}).get('note', '')}" for k in keys)
    g["feedback"] = (
        f"{g.get('feedback', '')}\n\n[보충이 필요한 부분]\n{detail}\n\n"
        "위 내용을 보충, 수정하여 다시 작성하여 제출해보세요."
    ).strip()
    return g


def main():
    subs = list(db.collection("submissions").where("status", "==", "submitted").stream())
    print(f"채점 대상: {len(subs)}건")
    graded = flagged = errors = 0

    for s in subs:
        data = s.to_dict()
        try:
            ws = db.collection("worksheets").document(data["worksheetId"]).get()
            ws_data = ws.to_dict() or {}
            reference_material = ws_data.get("referenceMaterial", "")

            if data.get("answerType") == "text":
                problem = ws_data.get("problem", "")
                answer = data.get("answerText", "")
                if not answer:
                    print(f"  [건너뜀] 답안 없음: {s.id}")
                    continue
                g = append_resubmit_note(grade_text(problem, answer, reference_material))
            else:
                pages = (db.collection("submissions").document(s.id)
                           .collection("pages").order_by("order").stream())
                imgs = []
                for p in pages:
                    b64 = p.to_dict().get("imageBase64", "")
                    if "," in b64:                      # dataURL 헤더 제거
                        b64 = b64.split(",", 1)[1]
                    if b64:
                        imgs.append(base64.b64decode(b64))
                if not imgs:
                    print(f"  [건너뜀] 이미지 없음: {s.id}")
                    continue
                g = append_resubmit_note(grade_images(imgs, reference_material))
            db.collection("reviews").document(s.id).set(g)
            db.collection("submissions").document(s.id).update({
                "status": "graded",
                "gradedAt": firestore.SERVER_TIMESTAMP,
            })
            graded += 1
            if g.get("reviewFlag"):
                flagged += 1
            tag = "  ⚠️ 확인필요" if g.get("reviewFlag") else ""
            print(f"  [완료] {data.get('studentEmail')} {data.get('worksheetId')} "
                  f"→ {g.get('total')}점{tag}")
        except Exception as e:
            errors += 1
            print(f"  [오류] {s.id}: {e}")
        time.sleep(THROTTLE_SEC)

    print(f"\n채점 완료: {graded}건 (확인 필요 {flagged}건, 오류 {errors}건)")
    print("→ 웹 교사 화면에서 검토·공개하세요.")


if __name__ == "__main__":
    main()
