// 로컬 실행: node server.js -> http://localhost:3939
// 배포 호스팅: PORT 환경변수 자동 인식 (Render/Railway/iwinv 등과 호환)
const express = require("express");
const path = require("path");
const fs = require("fs");
const cheerio = require("cheerio");
if (typeof globalThis.File === "undefined") {
  globalThis.File = require("buffer").File;
}

const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

// pkg 踰덈뱾?먯꽌 public/ 寃쎈줈 李얘린
const ROOT = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.join(path.dirname(process.execPath), "public");

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// ?? DC?몄궗?대뱶 ?ㅽ겕?섑띁 ??????????????????????????????????
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

async function fetchText(url, headers = {}, opts = {}) {
  const retries = opts.retries ?? 3;
  const minDelay = opts.minDelay ?? 1200;
  const maxDelay = opts.maxDelay ?? 3500;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", ...headers },
      redirect: "follow",
    });
    if (res.ok) return await res.text();

    if (res.status === 429 || res.status === 403) {
      const ra = res.headers.get("retry-after");
      const waitMs = ra ? Math.min(30000, Math.max(1000, Number(ra) * 1000)) : Math.min(maxDelay, minDelay * (attempt + 1));
      lastErr = new Error(`DC 차단 감지 (HTTP ${res.status}${ra ? `, ${ra}s 후 재시도` : ""})`);
      if (attempt < retries) {
        await sleep(waitMs);
        continue;
      }
      throw new Error(`요청 실패: ${lastErr.message}. 잠시 후 다시 시도해 주세요.`);
    }

    lastErr = new Error(`HTTP ${res.status} ${url}`);
    if (attempt < retries && res.status >= 500) {
      await sleep(minDelay * (attempt + 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr || new Error(`HTTP error ${url}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 媛꾨떒??LRU+TTL 罹먯떆 (媛ㅻ줈洹?user_id ??{posts, replies})
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX = 500;
const profileCache = new Map();
function cacheGet(uid) {
  const e = profileCache.get(uid);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { profileCache.delete(uid); return null; }
  // LRU: refresh recency
  profileCache.delete(uid);
  profileCache.set(uid, e);
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

  const mobileUrl = `https://m.dcinside.com/board/${info.id}/${info.no}`;
  const postRes = await fetch(mobileUrl, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
    redirect: "follow",
  });
  if (!postRes.ok) throw new Error(`HTTP ${postRes.status} 게시글 페이지`);

  const html = await postRes.text();
  const csrfMatch = html.match(/meta\s+name=['"]csrf-token['"]\s+content=['"]([^'"]+)['"]/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";
  if (!csrf) throw new Error("CSRF 토큰 추출 실패");

  const $ = cheerio.load(html);
  let title = $(".tit").first().text().trim() || $("title").text().trim();
  const titleMatch = title.match(/^(.+?)\s*-\s*([^-]+)$/);
  const galleryName = titleMatch ? titleMatch[2].trim() : info.id;
  if (titleMatch) title = titleMatch[1].trim();

  const comments = await fetchAllComments({ id: info.id, no: info.no, csrf, refererUrl: mobileUrl });
  return { site: "dcinside", ...info, title, galleryName, total: comments.length, comments };
}

async function fetchAllComments({ id, no, csrf, refererUrl }) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= 80; page++) {
    if (page > 1) await sleep(700);
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
      },
      body: new URLSearchParams({ id, no, cpage: String(page), managerskill: "", csort: "", permission_pw: "" }).toString(),
    });

    if (res.status === 429 || res.status === 403) {
      throw new Error(`댓글 조회 차단 (HTTP ${res.status})`);
    }
    if (!res.ok) break;

    const html = await res.text();
    if (!html || html.length < 100) break;
    const $ = cheerio.load(html);
    const items = $("li.comment, li.comment-add");
    if (!items.length) break;

    items.each((_, el) => {
      const $el = $(el);
      const cid = $el.attr("no");
      if (!cid || seen.has(cid)) return;
      seen.add(cid);

      let userId = "";
      const gallogA = $el.find("a[href*='/gallog/']").attr("href") || "";
      const m = gallogA.match(/\/gallog\/([^/?"]+)/);
      if (m) userId = m[1];
      if (!userId) {
        const nickA = $el.find(".nick a[href*='/gallog/']").attr("href") || "";
        const m2 = nickA.match(/\/gallog\/([^/?"]+)/);
        if (m2) userId = m2[1];
      }

      const ipText = $el.find(".ip").text().trim();
      const text = $el.find(".txt").text().replace(/\s+/g, " ").trim();
      const date = $el.find(".date").text().trim();
      if ($el.find(".nick").hasClass("comment_boy")) return;
      const type = userId ? "fixed" : (ipText ? "floating" : "anonymous");
      const rawName = $el.find(".nick").first().text().trim();
      const name = rawName || (type === "anonymous" ? "익명" : type === "floating" ? "유동닉" : "미상");
      const popupHtml = $el.find(".user_data_list, .user-popup, .user_info, .pop_userinfo, .user_layer").first().html() || "";
      out.push({ id: cid, name, userId, ip: ipText, type, text, regDate: date, popupHtml });
    });

    const totalInput = $("#reple_totalCnt").attr("value");
    const total = totalInput ? parseInt(totalInput) : 0;
    if (total && out.length >= total) break;
  }
  return out;
}

async function fetchDcGallog(userId) {
  if (!userId) return { posts: 0, replies: 0, source: "none" };
  const urls = [
    `https://gallog.dcinside.com/${encodeURIComponent(userId)}`,
    `https://m.dcinside.com/gallog/${encodeURIComponent(userId)}`,
  ];

  for (const url of urls) {
    try {
      const html = await fetchText(url, {}, { retries: 2, minDelay: 1500, maxDelay: 4000 });
      const $ = cheerio.load(html);
      const parseNum = (raw) => {
        const m = String(raw || "").match(/[\d,]+/);
        return m ? parseInt(m[0].replace(/,/g, ""), 10) || 0 : 0;
      };
      const text = $.root().text().replace(/\s+/g, " ");
      let posts = 0;
      let replies = 0;

      $("h2").each((_, el) => {
        const label = $(el).text().replace(/\s+/g, " ").trim();
        const num = parseNum($(el).find("span").first().text());
        if (!num) return;
        if (/게시(?:글|물)/.test(label)) posts = num;
        if (/댓글/.test(label)) replies = num;
      });

      if (!posts) {
        const m = text.match(/게시(?:글|물)\s*\(?\s*([\d,]+)\s*\)?/i);
        posts = m ? parseNum(m[1]) : 0;
      }
      if (!replies) {
        const m = text.match(/댓글\s*\(?\s*([\d,]+)\s*\)?/i);
        replies = m ? parseNum(m[1]) : 0;
      }

      if (posts || replies) return { posts, replies, source: url.includes("gallog.dcinside.com") ? "gallog" : "mobile-gallog" };
    } catch (e) {
      if (e.message && (e.message.includes("DC 차단") || e.message.includes("DC blocked"))) throw e;
    }
  }

  return { posts: 0, replies: 0, source: "none" };
}

function parsePopupStats(html) {
  if (!html) return { posts: 0, replies: 0 };
  const text = String(html).replace(/\s+/g, " ");
  const get = (re) => {
    const m = text.match(re);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) || 0 : 0;
  };
  const posts =
    get(/게시물<em[^>]*>([\d,]+)<\/em>/i) ||
    get(/게시글<em[^>]*>([\d,]+)<\/em>/i) ||
    get(/게시물\s*([\d,]+)/i) ||
    get(/게시글\s*([\d,]+)/i);
  const replies =
    get(/댓글<em[^>]*>([\d,]+)<\/em>/i) ||
    get(/댓글\s*([\d,]+)/i);
  return { posts, replies };
}

async function fetchUserStats({ userId, popupHtml } = {}) {
  const popup = parsePopupStats(popupHtml);
  if (popup.posts || popup.replies) return { source: "popup", ...popup };
  if (!userId) return { source: "none", posts: 0, replies: 0 };
  const gallog = await fetchDcGallog(userId);
  return gallog.posts || gallog.replies ? gallog : { source: "none", posts: 0, replies: 0, error: gallog.error || "no data" };
}

const app = express();
app.use(express.json({ limit: "8mb" }));
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
    return res.status(400).json({ error: "지원하지 않는 사이트입니다 (현재 DC만 지원)" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

function normalizeUsers(users) {
  return users.map(u => typeof u === "string" ? { userId: u } : { userId: u.userId, popupHtml: u.popupHtml });
}

app.post("/api/profiles", async (req, res) => {
  const { site, users } = req.body || {};
  if (!Array.isArray(users)) return res.status(400).json({ error: "users array required" });
  if (site !== "dcinside") return res.status(400).json({ error: "unsupported site" });

  const list = normalizeUsers(users);
  const profiles = {};
  const toFetch = [];
  for (const u of list) {
    const hit = cacheGet(u.userId);
    if (hit) { profiles[u.userId] = hit; continue; }
    const popup = parsePopupStats(u.popupHtml);
    if (popup.posts || popup.replies) {
      const data = { source: "popup", ...popup };
      profiles[u.userId] = data; cacheSet(u.userId, data); continue;
    }
    toFetch.push(u);
  }

  const queue = toFetch.slice();
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try {
        const data = await fetchUserStats(u);
        profiles[u.userId] = data;
        cacheSet(u.userId, data);
      } catch (e) {
        profiles[u.userId] = { source: "error", posts: 0, replies: 0, error: e.message };
      }
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  res.json({ profiles, cached: Object.keys(profiles).length, fetched: toFetch.length });
});

app.post("/api/profiles/stream", async (req, res) => {
  const { site, users } = req.body || {};
  if (!Array.isArray(users)) return res.status(400).json({ error: "users array required" });
  if (site !== "dcinside") return res.status(400).json({ error: "unsupported site" });

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const write = (obj) => res.write(JSON.stringify(obj) + "\n");

  const list = normalizeUsers(users);
  const toFetch = [];
  const fastItems = [];
  for (const u of list) {
    const hit = cacheGet(u.userId);
    if (hit) { fastItems.push({ uid: u.userId, data: hit, fromCache: true }); continue; }
    const popup = parsePopupStats(u.popupHtml);
    if (popup.posts || popup.replies) {
      const data = { source: "popup", ...popup };
      cacheSet(u.userId, data);
      fastItems.push({ uid: u.userId, data, fromCache: false });
      continue;
    }
    toFetch.push(u);
  }
  const total = list.length;
  let done = 0;
  write({ type: "start", total, cachedCount: fastItems.filter(x=>x.fromCache).length, fromPopup: fastItems.filter(x=>!x.fromCache).length, toFetch: toFetch.length });
  for (const it of fastItems) {
    done++;
    write({ type: "item", uid: it.uid, data: it.data, done, total, fromCache: it.fromCache });
  }

  let aborted = false;
  req.on("close", () => { aborted = true; });

  const queue = toFetch.slice();
  const worker = async () => {
    while (queue.length && !aborted) {
      const u = queue.shift();
      let data;
      try {
        data = await fetchUserStats(u);
        cacheSet(u.userId, data);
      } catch (e) {
        data = { source: "error", posts: 0, replies: 0, error: e.message };
      }
      done++;
      write({ type: "item", uid: u.userId, data, done, total, fromCache: false });
      await sleep(250);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  if (!aborted) write({ type: "done", done, total });
  res.end();
});

function startServer(port) {
  const server = app.listen(port, HOST, () => {
    const actualPort = server.address().port;
    const url = `http://localhost:${actualPort}`;
    console.log(`프로로터리 열림: ${url}`);
    console.log("  (??李쎌? ?먮룞?쇰줈 理쒖냼?붾맗?덈떎. 醫낅즺?섎젮硫?李쎌쓣 ?レ쑝?몄슂)");
    if (HOST === "127.0.0.1") {
      const { exec } = require("child_process");
      setTimeout(() => {
        const cmd = process.platform === "win32" ? `start "" "${url}"`
          : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
        exec(cmd);
      }, 800);
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

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT + 10) {
      console.log(`포트 ${port} 사용 중, ${port + 1}로 재시도합니다...`);
      startServer(port + 1);
      return;
    }
    console.error(err);
    process.exit(1);
  });
}

startServer(PORT);




