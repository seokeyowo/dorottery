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
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

async function fetchDcPost(url) {
  const info = parseDcUrl(url);
  if (!info.id || !info.no) throw new Error("DC URL에서 id/no를 찾지 못했습니다.");

  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const title = $(".title_subject").text().trim() || $("title").text().trim();
  const galleryName = $(".title_headtext").text().trim() || info.id;
  const esnoMatch = html.match(/name=['"]e_s_n_o['"]\s+value=['"]([0-9a-f]+)['"]/i);
  const e_s_n_o = esnoMatch ? esnoMatch[1] : "";

  const comments = await fetchAllComments({ ...info, e_s_n_o, refererUrl: url });
  return { site: "dcinside", ...info, title, galleryName, total: comments.length, comments };
}

async function fetchAllComments({ id, no, e_s_n_o, refererUrl }) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    if (page > 1) await sleep(250); // 댓글 페이지 간 딜레이
    const body = new URLSearchParams({
      id, no, cmt_id: id, cmt_no: no,
      e_s_n_o, comment_page: String(page),
      sort: "", prevCnt: "0", board_type: "",
    });
    let j;
    try {
      const res = await fetch("https://gall.dcinside.com/board/comment/", {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": refererUrl,
          "Origin": "https://gall.dcinside.com",
        },
        body: body.toString(),
      });
      if (!res.ok) break;
      j = await res.json();
    } catch { break; }
    const list = j.comments || [];
    if (!list.length) break;
    let added = 0;
    for (const c of list) {
      if (c.nicktype === "COMMENT_BOY") continue;
      if (seen.has(c.no)) continue;
      seen.add(c.no);
      const text = String(c.memo || "")
        .replace(/<img[^>]+alt=['"]([^'"]*)['"][^>]*>/gi, "[$1]")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      out.push({
        id: c.no,
        name: c.name || c.user_id || "익명",
        userId: c.user_id || "",
        ip: c.ip || "",
        type: c.user_id ? "fixed" : (c.ip ? "floating" : "anonymous"),
        text,
        regDate: c.reg_date || "",
      });
      added++;
    }
    const total = j.total_cnt || 0;
    if (total && out.length >= total) break;
    if (added === 0) break;
  }
  return out;
}

async function fetchDcGallog(userId) {
  if (!userId) return { posts: 0, replies: 0 };
  try {
    const html = await fetchText(`https://gallog.dcinside.com/${encodeURIComponent(userId)}`);
    const grab = (pats) => {
      for (const re of pats) {
        const m = html.match(re);
        if (m) return parseInt(m[1].replace(/,/g, ""), 10) || 0;
      }
      return 0;
    };
    const posts = grab([
      /location\.href='\/[^']+\/posting'[^>]*>\s*게시글\s*<span[^>]*>\(([\d,]+)\)/,
      /\/posting['"][^>]*>\s*게시글[^<]*<span[^>]*>\(([\d,]+)\)/,
      /게시글\s*<span[^>]*class=['"]num['"][^>]*>\(([\d,]+)\)/,
    ]);
    const replies = grab([
      /location\.href='\/[^']+\/comment'[^>]*>\s*댓글\s*<span[^>]*>\(([\d,]+)\)/,
      /\/comment['"][^>]*>\s*댓글[^<]*<span[^>]*>\(([\d,]+)\)/,
      /댓글\s*<span[^>]*class=['"]num['"][^>]*>\(([\d,]+)\)/,
    ]);
    return { posts, replies };
  } catch (e) {
    if (e.message && e.message.includes("DC 차단")) throw e; // 전체 중단
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
  // 동시 2개 + 각 요청 사이 300ms 간격 → DC 봇차단 회피
  const profiles = {};
  const queue = users.slice();
  const worker = async () => {
    while (queue.length) {
      const uid = queue.shift();
      profiles[uid] = await fetchDcGallog(uid);
      await sleep(300);
    }
  };
  try {
    await Promise.all(Array.from({ length: 2 }, worker));
    res.json({ profiles });
  } catch (e) {
    console.error("gallog bulk fail:", e.message);
    res.status(503).json({ error: e.message, profiles });
  }
});

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`도로롱 로터리 → ${url}`);
  if (HOST === "127.0.0.1") {
    console.log("  브라우저가 1초 후 자동으로 열립니다. 종료: 이 창 닫기.");
    setTimeout(() => {
      const { exec } = require("child_process");
      const cmd = process.platform === "win32" ? `start "" "${url}"`
        : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd);
    }, 1000);
  }
});
