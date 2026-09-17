"""
seed_import.py — roster/worksheets 시드 업로드 + 관리자 커스텀 클레임 설정.

  사용: python seed_import.py
  전제: serviceAccountKey.json, seed/roster.json, seed/worksheets.json, seed/admins.json

주의:
  - 관리자 클레임(admin=true)은 해당 계정이 '한 번 이상 로그인'해 Firebase Auth 에
    사용자로 존재해야 부여할 수 있다. 두 교사 계정으로 웹에 먼저 1회 로그인한 뒤
    이 스크립트를 (다시) 실행하면 클레임이 설정된다.
  - 클레임 부여 후에는 해당 계정이 재로그인(토큰 갱신)해야 관리자 권한이 적용된다.
"""
import json
import firebase_admin
from firebase_admin import credentials, firestore, auth

firebase_admin.initialize_app(credentials.Certificate("serviceAccountKey.json"))
db = firestore.client()


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# --- roster ---
roster = load("seed/roster.json")
for email, v in roster.items():
    db.collection("roster").document(email).set(v)
print(f"roster: {len(roster)}명 등록")

# --- worksheets ---
# merge=True: 웹 교사 화면에서 입력한 problem(문제 텍스트)을 재시드 시 덮어쓰지 않음.
ws = load("seed/worksheets.json")
for code, v in ws.items():
    db.collection("worksheets").document(code).set(v, merge=True)
print(f"worksheets: {len(ws)}개 등록")

# --- 관리자 클레임 ---
admins = load("seed/admins.json")["admins"]
for email in admins:
    try:
        u = auth.get_user_by_email(email)
        auth.set_custom_user_claims(u.uid, {"admin": True})
        print(f"admin 설정 완료: {email}")
    except auth.UserNotFoundError:
        print(f"[대기] {email} — 아직 로그인 이력이 없어 클레임 미설정. "
              f"해당 계정으로 웹에 1회 로그인 후 이 스크립트를 다시 실행하세요.")
