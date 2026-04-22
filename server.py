"""도로롱 로터리 백엔드 — DC인사이드 댓글/갤로그 스크래퍼 + 정적 프론트 서빙."""
import json, re, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote
from concurrent.futures import ThreadPoolExecutor
import requests
from bs4 import BeautifulSoup

PORT = int(os.environ.get("PORT", 3939))
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1")
# PyInstaller 번들일 때는 sys._MEIPASS, 스크립트 실행일 때는 현재 디렉터리
_BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(_BASE, "public")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
session = requests.Session()
session.headers.update({"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9"})


# ─── DC인사이드 ──────────────────────────────────────────
def match_dc(url: str) -> bool:
    return bool(re.search(r"gall\.dcinside\.com/(mgallery/|mini/)?board/view/", url))


def parse_dc_url(url: str):
    u = urlparse(url)
    qs = parse_qs(u.query)
    return {
        "id": (qs.get("id") or [None])[0],
        "no": (qs.get("no") or [None])[0],
        "kind": "mgallery" if "/mgallery/" in u.path
                else "mini" if "/mini/" in u.path else "board",
    }


def fetch_dc_post(url: str):
    info = parse_dc_url(url)
    if not info["id"] or not info["no"]:
        raise ValueError("DC URL에서 id/no를 찾지 못했습니다.")
    r = session.get(url, timeout=15)
    r.raise_for_status()
    html = r.text
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.select_one(".title_subject")
    title = title_el.get_text(strip=True) if title_el else (soup.title.get_text(strip=True) if soup.title else "")
    gal = soup.select_one(".title_headtext")
    gallery_name = gal.get_text(strip=True) if gal else info["id"]

    m = re.search(r'name=["\']e_s_n_o["\']\s+value=["\']([0-9a-f]+)["\']', html)
    e_s_n_o = m.group(1) if m else ""

    comments = fetch_all_comments(info["id"], info["no"], e_s_n_o, url)
    return {
        "site": "dcinside", **info,
        "title": title, "galleryName": gallery_name,
        "total": len(comments), "comments": comments,
    }


def fetch_all_comments(gid, no, e_s_n_o, referer):
    out, seen = [], set()
    page = 1
    while page <= 100:
        body = {
            "id": gid, "no": no, "cmt_id": gid, "cmt_no": no,
            "e_s_n_o": e_s_n_o, "comment_page": str(page),
            "sort": "", "prevCnt": "0", "board_type": "",
        }
        try:
            r = session.post(
                "https://gall.dcinside.com/board/comment/",
                data=body,
                headers={
                    "Referer": referer,
                    "Origin": "https://gall.dcinside.com",
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                },
                timeout=15,
            )
            j = r.json()
        except Exception:
            break
        lst = j.get("comments") or []
        if not lst:
            break
        added = 0
        for c in lst:
            if c.get("nicktype") == "COMMENT_BOY":
                continue
            cid = c.get("no")
            if cid in seen:
                continue
            seen.add(cid)
            text = re.sub(r"<img[^>]*alt=['\"]([^'\"]*)['\"][^>]*>", r"[\1]", c.get("memo", ""))
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).replace("&nbsp;", " ").strip()
            user_id = c.get("user_id") or ""
            ip = c.get("ip") or ""
            ctype = "fixed" if user_id else ("floating" if ip else "anonymous")
            out.append({
                "id": cid, "name": c.get("name") or user_id or "익명",
                "userId": user_id, "ip": ip, "type": ctype,
                "text": text, "regDate": c.get("reg_date") or "",
            })
            added += 1
        total = j.get("total_cnt") or 0
        if total and len(out) >= total:
            break
        if added == 0:
            break
        page += 1
    return out


def fetch_dc_gallog(user_id: str):
    if not user_id:
        return {"posts": 0, "replies": 0}
    try:
        r = session.get(f"https://gallog.dcinside.com/{quote(user_id)}", timeout=10)
        html = r.text
        def grab(*pats):
            for p in pats:
                m = re.search(p, html)
                if m:
                    return int(m.group(1).replace(",", ""))
            return 0
        posts = grab(
            r"location\.href='/[^']+/posting'[^>]*>\s*게시글\s*<span[^>]*>\(([\d,]+)\)",
            r"게시글\s*<span[^>]*class=['\"]num['\"][^>]*>\(([\d,]+)\)",
        )
        replies = grab(
            r"location\.href='/[^']+/comment'[^>]*>\s*댓글\s*<span[^>]*>\(([\d,]+)\)",
            r"댓글\s*<span[^>]*class=['\"]num['\"][^>]*>\(([\d,]+)\)",
        )
        return {"posts": posts, "replies": replies}
    except Exception as e:
        return {"posts": 0, "replies": 0, "error": str(e)}


# ─── HTTP 서버 ──────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self.send_error(404); return
        ctype = ("text/html; charset=utf-8" if full.endswith(".html")
                 else "text/css; charset=utf-8" if full.endswith(".css")
                 else "application/javascript; charset=utf-8" if full.endswith(".js")
                 else "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/fetch":
            url = (parse_qs(u.query).get("url") or [""])[0]
            if not url:
                return self._json(400, {"error": "url 필요"})
            try:
                if match_dc(url):
                    return self._json(200, fetch_dc_post(url))
                return self._json(400, {"error": "지원하지 않는 사이트 (현재 DC만)"})
            except Exception as e:
                return self._json(500, {"error": str(e)})
        return self._static(u.path)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/profiles":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                return self._json(400, {"error": "잘못된 JSON"})
            users = body.get("users") or []
            if body.get("site") != "dcinside":
                return self._json(400, {"error": "지원하지 않는 사이트"})
            with ThreadPoolExecutor(max_workers=4) as ex:
                results = list(ex.map(fetch_dc_gallog, users))
            return self._json(200, {"profiles": dict(zip(users, results))})
        self.send_error(404)


if __name__ == "__main__":
    import webbrowser, threading
    url = f"http://localhost:{PORT}"
    print(f"도로롱 로터리 → {url}")
    print("  브라우저가 자동으로 열립니다. 종료하려면 이 창을 닫으세요.")
    # 로컬 실행(기본 3939 포트)일 때만 브라우저 자동 열기
    if HOST == "127.0.0.1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
