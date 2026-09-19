"""
grade.py — 채점 대기 제출물을 Gemini로 채점하고, 문제없는 건은 바로 학생에게 공개한다.

  사용: python grade.py            (GitHub Actions 가 5분마다 실행. 로컬에서도 동일)
                                    평일 16:30~02:00, 주말 09:00~02:00(KST)에만 실제로 채점하고,
                                    그 밖의 시간은 교사가 웹에서 직접 채점하므로 아무것도 하지 않고
                                    끝난다(ACTIVE_WINDOW, ACTIVE_WINDOW_WEEKEND, --force 참고).
        python grade.py --dry-run [제출물ID]
                                    (쓰기 없이 채점만 해 보고 결과를 출력. ID 를 주면 그 건만,
                                     안 주면 채점 대기 건 전부. 파이프라인 점검용)
  전제:
    - Firebase 서비스 계정: 환경변수 FIREBASE_SERVICE_ACCOUNT_JSON(키 JSON 문자열, Actions 용)
      또는 serviceAccountKey.json 파일(로컬·gitignore)
    - GEMINI_API_KEY (Actions 는 Secrets, 로컬은 .env)
    - 선택: GEMINI_MODEL, THROTTLE_SEC, AUTO_RELEASE("0" 이면 전부 교사 검토 대기로 둠),
            ACTIVE_WINDOW(평일, 기본 "16:30-02:00"), ACTIVE_WINDOW_WEEKEND(토·일, 기본 "09:00-02:00")
            — KST, 자정 넘김 가능, 그 시간대에만 실행. 둘 다 "" 이면 항상 실행
  흐름:
    submissions.status == "submitted" 조회
      → 각 제출의 pages(이미지) 또는 answerText 로드
        (교사가 재채점을 요청한 건은 regradeSource 에 따라 저장된 판독 문장 / 사진 재판독)
      → Gemini 채점(구조화 JSON)
      → reviews/{uid_학습지} 에 초안 저장
      → reviewFlag 가 아니면 바로 released(학생 공개), reviewFlag 면 graded(교사 검토 대기)
      → 채점 실패는 error 로 표시해 큐에서 뺀다(교사 화면에서 "다시 채점" 가능)
  로그: 공개 저장소의 Actions 로그는 누구나 볼 수 있으므로 학생 이메일·점수·답안은 절대
        출력하지 않는다. 제출물 문서 ID 와 건수만 남긴다.

주의:
  - google-genai SDK 버전에 따라 Part 생성/호출부 형태가 조금 다를 수 있음.
    설치된 버전 기준으로 Claude Code가 맞춰 조정할 것.
  - 무료 등급은 분당 요청 한도(RPM 약 10~15)가 있으므로 THROTTLE_SEC 로 천천히 처리.
  - 무료 등급에서 쓸 수 있는 멀티모달 모델/한도는 수시로 바뀐다.
    Google AI Studio의 rate limits 페이지에서 확인해 GEMINI_MODEL 을 맞출 것.
"""
import os, sys, time, base64, json
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore
from google import genai
from google.genai import types
from pydantic import BaseModel

load_dotenv()

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite"  # 무료 등급 가용 모델로 지정
THROTTLE_SEC   = float(os.environ.get("THROTTLE_SEC") or "5")               # 무료 RPM 대응
# 채점 결과를 교사 확인 없이 바로 학생에게 공개할지. reviewFlag(판독 애매, 문제 미등록 등)가
# 선 건은 이 값과 무관하게 항상 교사 검토 대기(graded)로 남긴다.
AUTO_RELEASE   = (os.environ.get("AUTO_RELEASE") or "1") not in ("0", "false", "no")
DRY_RUN        = "--dry-run" in sys.argv
FORCE_RUN      = "--force" in sys.argv or (os.environ.get("FORCE_RUN") or "") in ("1", "true")
# 서버 채점이 도는 시간대(KST). 그 밖의 시간(수업·근무 중)은 교사가 웹에서 직접 채점한다.
# 구간은 "그 날 시작 시각 ~ (자정을 넘겨) 끝 시각"이며, 토·일은 따로 준다.
ACTIVE_WINDOW         = os.environ.get("ACTIVE_WINDOW") or "16:30-02:00"          # 월~금
ACTIVE_WINDOW_WEEKEND = os.environ.get("ACTIVE_WINDOW_WEEKEND") or "09:00-02:00"  # 토·일
KST = timezone(timedelta(hours=9))


def _parse_window(spec):
    """"16:30-02:00" → ((16,30),(2,0)). 비어 있거나 형식이 이상하면 None(=항상 실행)."""
    if not spec.strip():
        return None
    try:
        h1, h2 = spec.split("-")
        return tuple(int(x) for x in h1.split(":")), tuple(int(x) for x in h2.split(":"))
    except ValueError:
        print(f"시간대 형식 오류({spec!r}) → 무시하고 실행")
        return None


def _window_for(isoweekday):
    return ACTIVE_WINDOW_WEEKEND if isoweekday >= 6 else ACTIVE_WINDOW


def in_active_window(now=None):
    """지금이 서버 채점 시간대면 True. 오늘 구간(시작 이후)이거나, 어제 구간이 자정을 넘긴
    꼬리(끝 시각 이전)에 있으면 True. 예: 월 16:30-02:00 → 월 16:30~화 01:59."""
    now = now or datetime.now(KST)
    t = (now.hour, now.minute)
    today = _parse_window(_window_for(now.isoweekday()))
    yesterday = _parse_window(_window_for((now - timedelta(days=1)).isoweekday()))
    if today is None and yesterday is None:
        return True
    if today:
        s, e = today
        if (s <= e and s <= t < e) or (s > e and t >= s):
            return True
    if yesterday:
        s, e = yesterday
        if s > e and t < e:   # 어제 구간이 자정을 넘긴 부분
            return True
    return False

# ---------- 채점 결과 스키마 ----------
class Criterion(BaseModel):
    score: int
    note: str

class Grade(BaseModel):
    check: str               # 채점 전 대조: 학생 서술 인용 ↔ 참고자료 문장 → 일치/불일치 (저장하지 않음)
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
- [참고자료]가 주어진 경우, 위 교차 점검 결과가 참고자료와 다르면 참고자료가
  더 정확하다. 참고자료에 적힌 용어·방향·인과관계는 당신의 기억이나 상식과
  달라 보여도 그대로 정답으로 인정하고, 참고자료와 일치하는 학생 서술을
  오답 처리하거나 반박하는 피드백을 쓰지 않는다. 의심과 재검증은 참고자료에
  없는 내용에만 적용한다.
- 조금이라도 확신이 서지 않는 과학적 판단이 있으면 단정하지 말고,
  reviewFlag=true 로 표시해 교사가 직접 확인하게 한다."""


def reference_section(reference_material):
    """학습지에 참고자료(교과서 핵심 개념 요약)가 등록돼 있으면, 그걸 교사가 확정한
    정답 기준으로 최우선 적용하도록 지시하는 섹션을 만든다. 없으면 빈 문자열."""
    if not reference_material:
        return ""
    return f"""
[참고자료 — 교사가 확정한 정답 기준. 이 프롬프트의 다른 모든 지시보다 우선한다]
아래는 이 학습지 단원의 교과서 핵심 개념을 교사가 정리·확정한 자료다.
- 자료의 용어·방향·인과관계는 당신의 기억, 상식, 일반 과학 지식과 달라 보여도
  무조건 정답이다. 당신의 지식이 자료와 다르면 당신이 틀린 것이다.
- 학생이 자료와 같은 내용(방향·용어 포함)을 썼다면 정답이다. 그것을 반대로
  고치거나 "오류", "반대로 서술"이라고 지적하지 않는다.
- 자료와 어긋나는 서술만 오답으로 처리한다.
- 출력 직전, note·feedback에 쓴 모든 과학적 진술을 이 자료와 한 줄씩 대조한다.
  자료와 모순되는 문장이 있으면 그 문장을 자료에 맞게 고치고 점수도 다시 매긴다.
- 자료에 없는 내용을 판단해야 할 때만 [과학적 정확성] 원칙으로 스스로 검증한다.

{reference_material}
"""


def problem_focus(problem):
    """등록된 문제가 있으면, 사진 판독 때 그 문제에 대한 답만 옮겨 적게 한다.
    (같은 학습지의 다른 빈칸·요약이 섞이면 채점이 흔들린다.)"""
    if not problem:
        return ""
    return f"""
   이 학습지에 등록된 '개념 활용하기' 문제는 아래와 같다. recognizedText 에는 **이 문제가
   묻는 문항에 대한 학생의 답만** 옮겨 적고, 학습지의 다른 빈칸·요약·필기(다른 상황에 대한
   서술 포함)는 제외한다.
   [등록된 문제]
   {problem}"""


def build_image_prompt(reference_material=None, problem=None):
    focus = problem_focus(problem)
    return f"""당신은 중학교 3학년 과학 서술형 답안을 채점하는 교사입니다.
이미지에는 학습지의 '문제'와 학생이 손으로 쓴 '답안'이 함께 있습니다.
이 채점은 학습지의 '개념 활용하기'라는 제목의 문제만 대상으로 한다. 학습지에 다른 제목의
문제·빈칸·요약·필기가 함께 있어도 읽거나 채점하지 말고, '개념 활용하기' 문제와 그 답안만 사용한다.
먼저 이미지에서 '개념 활용하기' 문제를 읽고, 그 문제에 대한 학생의 답안을 아래 기준으로 채점하세요.

[작성 절차]
1. 이미지에서 학생이 손으로 쓴 답안 부분을 판독해, 원문 그대로(요약·교정하지
   말고, 문제 텍스트는 제외하고 학생이 쓴 부분만) recognizedText 에 옮겨 적는다.{focus}
2. 문제와 답안을 파악해 채점 초안(점수·note·feedback)을 작성한다.
3. 그 초안을 다시 검토한다 — 채점 기준을 빠짐없이 반영했는지, 점수와 note·feedback
   내용이 서로 앞뒤가 맞는지, 사실관계나 과학적 오류는 없는지 확인한다.
4. 검토 결과 발견한 오류나 누락을 수정·보완하여 최종 결과만 출력한다.
   (초안이나 검토 과정 자체는 출력하지 않는다.)

{reference_section(reference_material)}
{SCIENCE_ACCURACY}
[대조 절차 — 점수를 매기기 전에 check 필드를 먼저 채운다]
- 문제가 묻는 문항마다 (a) 학생 답안의 핵심 서술을 원문 그대로 인용하고,
  (b) [참고자료]에서 그에 해당하는 문장을 인용한 뒤, (c) 두 내용의 방향·용어가
  같으면 "일치", 다르면 "불일치"라고 판정한다. 인용은 글자 그대로 옮기며,
  학생이 쓰지 않은 내용을 학생 서술로 인용하지 않는다.
- 이후 점수·note·feedback은 check 의 판정과 반드시 같은 결론이어야 한다.
  "일치"로 판정한 서술을 오답이라고 쓰지 않는다.

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
아래는 학습지의 '개념 활용하기' 문제와 학생이 직접 입력한 '답안'입니다.
이 채점은 '개념 활용하기'라는 제목의 문제만 대상으로 하며, 답안에 섞인 다른 제목의
문제·빈칸·요약에 대한 내용은 채점에 사용하지 않는다.

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

{reference_section(reference_material)}
{SCIENCE_ACCURACY}
[대조 절차 — 점수를 매기기 전에 check 필드를 먼저 채운다]
- 문제가 묻는 문항마다 (a) 학생 답안의 핵심 서술을 원문 그대로 인용하고,
  (b) [참고자료]에서 그에 해당하는 문장을 인용한 뒤, (c) 두 내용의 방향·용어가
  같으면 "일치", 다르면 "불일치"라고 판정한다. 인용은 글자 그대로 옮기며,
  학생이 쓰지 않은 내용을 학생 서술로 인용하지 않는다.
- 이후 점수·note·feedback은 check 의 판정과 반드시 같은 결론이어야 한다.
  "일치"로 판정한 서술을 오답이라고 쓰지 않는다.

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
- [학생 답안]에는 문제와 무관한 다른 학습 활동(같은 학습지의 다른 빈칸·요약 등)이나
  문제 본문이 섞여 있을 수 있다. [문제]가 묻는 문항(예: 1), 2))에 대한 답만 채점한다.
  문제가 묻는 상황과 다른 상황(예: 문제는 밝은 곳인데 어두운 곳)에 대한 문장은
  이 문제에 대한 학생의 답으로 보지 않으며, 그 문장을 근거로 감점하지 않는다.
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
# Actions 에서는 키를 파일로 남기지 않고 환경변수(Secrets)로만 받는다.
_sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
if _sa_json:
    _cred = credentials.Certificate(json.loads(_sa_json))
elif os.path.exists("serviceAccountKey.json"):
    _cred = credentials.Certificate("serviceAccountKey.json")
else:
    sys.exit("Firebase 서비스 계정이 없습니다. GitHub 이면 저장소 Secret 이름이 정확히 "
             "FIREBASE_SERVICE_ACCOUNT_JSON 인지 확인하세요(값은 키 JSON 파일 내용 전체). "
             "로컬이면 serviceAccountKey.json 을 두세요.")
firebase_admin.initialize_app(_cred)
db = firestore.client()
client = genai.Client(api_key=GEMINI_API_KEY)


def grade_images(image_bytes_list, reference_material=None, problem=None):
    parts = [build_image_prompt(reference_material, problem)] + [
        types.Part.from_bytes(data=b, mime_type="image/jpeg") for b in image_bytes_list
    ]
    res = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=parts,
        config={"response_mime_type": "application/json", "response_schema": Grade},
    )
    g = json.loads(res.text)
    g.pop("check", None)
    return g


def grade_text(problem, answer, reference_material=None):
    prompt = build_text_prompt(problem, answer, reference_material)
    res = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config={"response_mime_type": "application/json", "response_schema": Grade},
    )
    g = json.loads(res.text)
    g.pop("check", None)
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


def flat_grade(g):
    """reviews 초안(항목별 {score, note})을 submissions.grade 의 평면 형태로 바꾼다
    (teacher.js 의 toFlatGrade 와 동일)."""
    return {
        "total": g.get("total"),
        "concept": g.get("concept", {}).get("score", 0),
        "logic": g.get("logic", {}).get("score", 0),
        "evidence": g.get("evidence", {}).get("score", 0),
        "expression": g.get("expression", {}).get("score", 0),
    }


def grade_submission(sub_id, data):
    """제출물 한 건을 채점해 초안(dict)을 돌려준다. 쓰기는 하지 않는다."""
    ws = db.collection("worksheets").document(data["worksheetId"]).get()
    ws_data = ws.to_dict() or {}
    reference_material = ws_data.get("referenceMaterial", "")
    problem = ws_data.get("problem", "")
    regrade_source = data.get("regradeSource")

    if data.get("answerType") == "text":
        answer = data.get("answerText", "")
        if not answer:
            raise ValueError("답안 텍스트 없음")
        return append_resubmit_note(grade_text(problem, answer, reference_material))

    # 교사가 "저장된 문장으로 재채점"을 요청했고 판독 문장이 있으면 사진을 다시 보내지 않는다
    # (teacher.js 의 예전 performRegrade 와 동일, 토큰 절약).
    if regrade_source == "text" and data.get("recognizedText"):
        return append_resubmit_note(grade_text(problem, data["recognizedText"], reference_material))

    pages = (db.collection("submissions").document(sub_id)
               .collection("pages").order_by("order").stream())
    imgs = []
    for p in pages:
        b64 = p.to_dict().get("imageBase64", "")
        if "," in b64:                      # dataURL 헤더 제거
            b64 = b64.split(",", 1)[1]
        if b64:
            imgs.append(base64.b64decode(b64))
    if not imgs:
        raise ValueError("이미지 없음")
    g = grade_images(imgs, reference_material, problem)
    # 사진 채점은 이미지 속 인쇄 문구 등에 흔들려 참고자료를 어기는 일이 있다. 문제가 등록돼 있고
    # 판독문이 있으면, 판독문을 등록된 문제·참고자료로 텍스트 채점해 점수·피드백을 확정한다.
    # (판독문은 사진 단계 결과를 그대로 쓰고, 판독이 애매하다는 표시는 이어받는다.)
    if problem and g.get("recognizedText", "").strip():
        photo_flag, photo_reason = g.get("reviewFlag"), g.get("reviewReason", "")
        time.sleep(THROTTLE_SEC)
        g2 = grade_text(problem, g["recognizedText"], reference_material)
        if photo_flag:
            g2["reviewFlag"] = True
            g2["reviewReason"] = photo_reason or g2.get("reviewReason", "")
        g = g2
    return append_resubmit_note(g)


def main():
    if not FORCE_RUN and not DRY_RUN and not in_active_window():
        print(f"서버 채점 시간대(평일 {ACTIVE_WINDOW}, 주말 {ACTIVE_WINDOW_WEEKEND} KST) 밖이라 건너뜀. "
              f"지금 {datetime.now(KST):%a %H:%M}")
        return
    only_id = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
    if only_id:
        snap = db.collection("submissions").document(only_id).get()
        subs = [snap] if snap.exists else []
    else:
        subs = list(db.collection("submissions").where("status", "==", "submitted").stream())
    mode = " (dry-run: 쓰기 없음)" if DRY_RUN else ""
    print(f"채점 대상: {len(subs)}건{mode} · 모델 {GEMINI_MODEL} · 자동 공개 {'on' if AUTO_RELEASE else 'off'}")
    graded = released = flagged = errors = 0

    for i, s in enumerate(subs):
        data = s.to_dict()
        try:
            g = grade_submission(s.id, data)
            is_flag = bool(g.get("reviewFlag"))
            do_release = AUTO_RELEASE and not is_flag

            if DRY_RUN:
                print(f"  [dry] {s.id} → {'공개 예정' if do_release else '검토 대기'}"
                      f"{'  ⚠️ ' + str(g.get('reviewReason', ''))[:60] if is_flag else ''}")
            else:
                # 채점 초안 키는 학생+학습지 (teacher.js 의 reviewKey 와 반드시 동일해야 한다).
                review_key = f"{data.get('studentUid')}_{data.get('worksheetId')}"
                db.collection("reviews").document(review_key).set(g)

                update = {
                    "gradedAt": firestore.SERVER_TIMESTAMP,
                    "gradeError": None,
                    # 재채점 요청 표식과 "학생이 문장 수정함" 표식은 채점이 끝났으니 지운다.
                    "regradeSource": firestore.DELETE_FIELD,
                    "recognizedEditedBy": None,
                }
                if do_release:
                    # teacher.js 의 release() 가 쓰는 필드와 동일하게 확정본을 복사한다.
                    update.update({
                        "status": "released",
                        "releasedAt": firestore.SERVER_TIMESTAMP,
                        "grade": flat_grade(g),
                        "feedback": g.get("feedback", ""),
                        "recognizedText": g.get("recognizedText", ""),
                        "reviewFlag": False,
                    })
                else:
                    # 교사 화면 목록의 "확인 필요" 배지는 이 필드를 읽는다(초안 전체를 읽지 않기 위해).
                    update.update({"status": "graded", "reviewFlag": is_flag})
                db.collection("submissions").document(s.id).update(update)

            graded += 1
            if do_release:
                released += 1
            if is_flag:
                flagged += 1
        except Exception as e:
            errors += 1
            # 오류 메시지에 응답 본문이 섞일 수 있어 종류와 앞부분만 남긴다.
            msg = f"{type(e).__name__}: {str(e)[:120]}"
            print(f"  [오류] {s.id}: {msg}")
            if not DRY_RUN:
                # submitted 로 두면 다음 실행마다 같은 건을 다시 채점하며 한도를 태운다.
                # error 로 표시해 큐에서 빼고, 교사가 화면에서 "다시 채점"으로 되돌린다.
                try:
                    db.collection("submissions").document(s.id).update({
                        "status": "error", "gradeError": str(e)[:300],
                    })
                except Exception:
                    pass
        if i < len(subs) - 1:
            time.sleep(THROTTLE_SEC)

    print(f"\n채점 완료: {graded}건 (공개 {released}건, 확인 필요 {flagged}건, 오류 {errors}건)")
    if graded - released:
        print("→ 검토 대기 건은 웹 교사 화면에서 확인 후 공개하세요.")


if __name__ == "__main__":
    main()
