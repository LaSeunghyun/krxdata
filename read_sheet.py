"""
Google Sheets reader (OAuth, 내 계정 인증)
- 서비스 계정이 아니라 본인(lash@wisebirds.com) 계정으로 인증 → 외부 차단/AI 차단 우회
- 최초 1회만 브라우저 로그인, 이후 토큰 캐시로 자동 접근

사용법:
  python read_sheet.py                 # 모든 시트 탭 요약 출력
  python read_sheet.py <gid>           # 특정 탭(gid)만 전체 출력
"""
import sys
import gspread

# 대상 스프레드시트
SPREADSHEET_ID = "1IFYgvMJMVwJKYhkunUcDIh0JZQofyAfro2BT16qZky0"

# OAuth 클라이언트 자격증명/토큰 경로 (gspread 기본 경로)
#   credentials.json  : Google Cloud에서 받은 OAuth 클라이언트 ID (Desktop app)
#   authorized_user.json : 최초 로그인 후 자동 생성되는 토큰 캐시
gc = gspread.oauth(
    scopes=[
        "https://www.googleapis.com/auth/spreadsheets.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
    ],
)


def main():
    sh = gc.open_by_key(SPREADSHEET_ID)
    print(f"# 스프레드시트: {sh.title}\n")

    target_gid = sys.argv[1] if len(sys.argv) > 1 else None

    for ws in sh.worksheets():
        if target_gid is not None and str(ws.id) != str(target_gid):
            continue
        print(f"## 탭: {ws.title}  (gid={ws.id}, {ws.row_count}x{ws.col_count})")
        if target_gid is None:
            # 요약 모드: 첫 5행만 미리보기
            rows = ws.get_values()[:5]
            for r in rows:
                print("  ", r)
            print()
        else:
            # 전체 출력 모드
            for r in ws.get_values():
                print("\t".join(r))
            print()


if __name__ == "__main__":
    main()
