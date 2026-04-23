// 도로롱 로터리 — Node.js 백엔드
// 로컬 실행: node server.js  → http://localhost:3939
// 웹호스팅: PORT 환경변수 자동 인식 (Render/Railway/iwinv 등 공통)
const express = require("express");
const path = require("path");
const fs = require("fs");
const cheerio = require("cheerio");

const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

// pkg 번들에서 public/ 경로 찾기
const ROOT = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(path.dirname(process.execPath), "public");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ── DC인사이드 스크래퍼 ──────────────────────────────────
function matchDc(url) {
  return /gall\.dcinside\.com\/(mgallery\/|mini\/)?board\/view\//.test(url);
}
function parseDcUrl(url) {
  const u = new URL(url);
  return {
    id: u.searchParams.get("id"),
    no: u.searchParams.get("no"),
    kind: u.pathname.includes("/mgallery/") ? "mgallery"
        : u.pathname.includes("/mini/") ? "mini" : "board",
  };
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", ...headers },
    redirect: "follow",
  });
  if (res.status === 429 || res.status === 403) {
    const ra = res.headers.get("retry-after");
    throw new Error(`DC 차단 감지 (HTTP ${res.status}${ra ? `, ${ra}s 후 재시도` : ""}). 5~15분 후 다시 시도하세요.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 간단한 LRU+TTL 캐시 (갤로그 user_id → {posts, replies})
const CACHE_TTL = 10 * 60 * 1000; // 10분
const CACHE_MAX = 500;
const profileCache = new Map();
function cacheGet(uid) {
  const e = profileCache.get(uid);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { profileCache.delete(uid); return null; }
  // LRU: 재삽입으로 최신화
  profileCache.delete(uid); profileCache.set(uid, e);
  return e.data;
}
function cacheSet(uid, data) {
  if (profileCache.size >= CACHE_MAX) {
    const firstKey = profileCache.keys().next().value;
    profileCache.delete(firstKey);
  }
  profileCache.set(uid, { ts: Date.now(), data });
}

async function fetchDcPost(url) {
  const info = parseDcUrl(url);
  if (!info.id || !info.no) throw new Error("DC URL에서 id/no를 찾지 못했습니다.");

  // 모바일 DC 사용 (PC 쪽은 봇 차단 강화됨)
  const mobileUrl = `https://m.dcinside.com/board/${info.id}/${info.no}`;
  const sessionCookies = { jar: new Map() };
  const postRes = await fetch(mobileUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    redirect: "follow",
  });
  if (!postRes.ok) throw new Error(`HTTP ${postRes.status} 게시글 페이지`);
  // Set-Cookie 수집
  const setCookie = postRes.headers.getSetCookie ? postRes.headers.getSetCookie() : [postRes.headers.get("set-cookie")].filter(Boolean);
  const cookieHeader = setCookie.map(s => s.split(";")[0]).join("; ");
  const html = await postRes.text();

  // CSRF 토큰 추출
  const csrfMatch = html.match(/meta\s+name=['"]csrf-token['"]\s+content=['"]([^'"]+)['"]/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  if (!csrf) throw new Error("CSRF 토큰 추출 실패");

  // 제목
  const $ = cheerio.load(html);
  let title = $(".tit").first().text().trim() || $("title").text().trim();
  // 제목에서 갤러리명 분리
  const titleMatch = title.match(/^(.+?)\s*-\s*([^-]+?갤러리)$/);
  const galleryName = titleMatch ? titleMatch[2].trim() : info.id;
  if (titleMatch) title = titleMatch[1].trim();

  const comments = await fetchAllComments({ id: info.id, no: info.no, csrf, cookieHeader, refererUrl: mobileUrl });
  return { site: "dcinside", ...info, title, galleryName, total: comments.length, comments };
}

async function fetchAllComments({ id, no, csrf, cookieHeader, refererUrl }) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    if (page > 1) await sleep(250);
    let html;
    try {
      const res = await fetch("https://m.dcinside.com/ajax/response-comment", {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Accept": "text/html, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "X-CSRF-TOKEN": csrf,
          "Referer": refererUrl,
          "Origin": "https://m.dcinside.com",
          "Cookie": cookieHeader,
        },
        body: new URLSearchParams({ id, no, cpage: String(page), managerskill: "", csort: "", permission_pw: "" }).toString(),
      });
      if (!res.ok) break;
      html = await res.text();
    } catch { break; }
    if (!html || html.length < 100) break;

    const $ = cheerio.load(html);
    let addedThisPage = 0;
    $("li.comment, li.comment-add").each((_, el) => {
      const $el = $(el);
      const cid = $el.attr("no");
      if (!cid || seen.has(cid)) return;
      seen.add(cid);
      const name = $el.find(".nick").first().text().trim() || "익명";
      // 고닉: /gallog/{user_id} 링크 존재
      let userId = "";
      const gallogA = $el.find("a[href*='/gallog/']").attr("href") || "";
      const m = gallogA.match(/\/gallog\/([^/?"]+)/);
      if (m) userId = m[1];
      // IP: 유동 ([0-9]+.[0-9]+) — date 앞에 표시
      const ipText = $el.find(".ip").text().trim();
      // 텍스트
      const text = $el.find(".txt").text().replace(/\s+/g, " ").trim();
      const date = $el.find(".date").text().trim();
      // 광고성 댓글
      if ($el.find(".nick").hasClass("comment_boy")) return;
      const type = userId ? "fixed" : (ipText ? "floating" : "anonymous");
      out.push({ id: cid, name, userId, ip: ipText, type, text, regDate: date });
      addedThisPage++;
    });

    // 총 댓글 수 확인 (있으면)
    const totalInput = $("#reple_totalCnt").attr("value");
    const total = totalInput ? parseInt(totalInput) : 0;
    if (total && out.length >= total) break;
    if (addedThisPage === 0) break;
  }
  return out;
}

async function fetchDcGallog(userId) {
  if (!userId) return { posts: 0, replies: 0 };
  try {
    // 모바일 갤로그 사용 (PC 버전은 봇차단됨)
    const html = await fetchText(`https://m.dcinside.com/gallog/${encodeURIComponent(userId)}`);
    const grab = (pats) => {
      for (const re of pats) {
        const m = html.match(re);
        if (m) return parseInt(m[1].replace(/,/g, ""), 10) || 0;
      }
      return 0;
    };
    const posts = grab([
      /(?:게시물|게시글)\s*<span[^>]*class=['"]ct2['"][^>]*>\(([\d,]+)\)/,
      /menu=G_all[^>]*>\s*(?:게시물|게시글)\s*<span[^>]*>\(([\d,]+)\)/,
    ]);
    const replies = grab([
      /댓글\s*<span[^>]*class=['"]ct2['"][^>]*>\(([\d,]+)\)/,
      /menu=R_all[^>]*>\s*댓글\s*<span[^>]*>\(([\d,]+)\)/,
    ]);
    return { posts, replies };
  } catch (e) {
    if (e.message && e.message.includes("DC 차단")) throw e;
    return { posts: 0, replies: 0, error: e.message };
  }
}

// ── HTTP 서버 ──────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(ROOT));

app.get("/api/fetch", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "url 필요" });
  try {
    if (matchDc(url)) return res.json(await fetchDcPost(url));
    return res.status(400).json({ error: "지원하지 않는 사이트 (현재 DC만)" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/profiles", async (req, res) => {
  const { site, users } = req.body || {};
  if (!Array.isArray(users)) return res.status(400).json({ error: "users 배열 필요" });
  if (site !== "dcinside") return res.status(400).json({ error: "지원하지 않는 사이트" });
  const profiles = {};
  const toFetch = [];
  // 캐시 먼저 확인
  for (const uid of users) {
    const hit = cacheGet(uid);
    if (hit) profiles[uid] = hit;
    else toFetch.push(uid);
  }
  const cached = Object.keys(profiles).length;
  console.log(`[profiles] ${users.length}명 요청 / 캐시 ${cached} / 신규 ${toFetch.length}`);

  // 신규만 동시 2개 + 300ms 딜레이로 조회
  const queue = toFetch.slice();
  const worker = async () => {
    while (queue.length) {
      const uid = queue.shift();
      const data = await fetchDcGallog(uid);
      profiles[uid] = data;
      cacheSet(uid, data);
      await sleep(300);
    }
  };
  try {
    await Promise.all(Array.from({ length: 2 }, worker));
    res.json({ profiles, cached, fetched: toFetch.length });
  } catch (e) {
    console.error("gallog bulk fail:", e.message);
    res.status(503).json({ error: e.message, profiles });
  }
});

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`도로롱 로터리 → ${url}`);
  console.log("  (이 창은 자동으로 최소화됩니다. 종료하려면 창을 닫으세요)");
  if (HOST === "127.0.0.1") {
    const { exec } = require("child_process");
    // 브라우저 자동 실행
    setTimeout(() => {
      const cmd = process.platform === "win32" ? `start "" "${url}"`
        : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd);
    }, 800);
    // 콘솔 창 최소화 (Windows 전용) — ShowWindow(SW_MINIMIZE=6)
    if (process.platform === "win32") {
      setTimeout(() => {
        const ps = `$s='[DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(int h,int s);'; ` +
                   `$t=Add-Type -MemberDefinition $s -Name Win -Namespace X -PassThru; ` +
                   `$h=(Get-Process -Id ${process.pid}).MainWindowHandle; ` +
                   `[X.Win]::ShowWindow($h, 6)`;
        exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, { windowsHide: true });
      }, 1500);
    }
  }
});
