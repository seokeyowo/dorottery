// 도로롱 추첨기 헬퍼 — 콘텐츠 스크립트
// DC 게시글 페이지에 플로팅 "추첨" 버튼을 주입하고, 클릭 시 댓글+갤로그를 수집하여 추첨기로 전송
(() => {
  const SITE_URL = "https://dorottery.onrender.com/";

  const params = new URLSearchParams(location.search);
  const gid = params.get("id");
  const gno = params.get("no");
  if (!gid || !gno) return;

  // 이미 주입돼 있으면 스킵
  if (document.getElementById("dororong-fab")) return;

  const btn = document.createElement("button");
  btn.id = "dororong-fab";
  btn.textContent = "🎰 도로롱 추첨";
  btn.style.cssText =
    "position:fixed;bottom:28px;right:28px;z-index:999999;" +
    "padding:12px 20px;border:none;border-radius:999px;" +
    "background:linear-gradient(135deg,#e91e63,#ff6b9a);color:#fff;" +
    "font:700 14px 'Malgun Gothic',sans-serif;cursor:pointer;" +
    "box-shadow:0 6px 20px rgba(233,30,99,.45);transition:transform .15s";
  btn.onmouseover = () => (btn.style.transform = "translateY(-2px)");
  btn.onmouseout = () => (btn.style.transform = "");
  document.body.appendChild(btn);

  btn.onclick = runCollect;

  async function runCollect() {
    btn.disabled = true;
    const overlay = makeOverlay();
    const st = (t) => (overlay.statusEl.textContent = t);

    try {
      const html = document.documentElement.outerHTML;
      const esn = (html.match(/name=['"]e_s_n_o['"]\s+value=['"]([a-f0-9]+)['"]/) || [, ""])[1];

      const all = [];
      const seen = new Set();
      for (let p = 1; p <= 100; p++) {
        st(`댓글 페이지 ${p}…`);
        let j;
        try {
          const r = await fetch("/board/comment/", {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body: new URLSearchParams({
              id: gid, no: gno, cmt_id: gid, cmt_no: gno,
              e_s_n_o: esn, comment_page: String(p),
              sort: "", prevCnt: "0", board_type: "",
            }),
            credentials: "include",
          });
          j = await r.json();
        } catch (e) { break; }
        const list = j.comments || [];
        if (!list.length) break;
        let added = 0;
        for (const c of list) {
          if (c.nicktype === "COMMENT_BOY") continue;
          if (seen.has(c.no)) continue;
          seen.add(c.no);
          const text = (c.memo || "")
            .replace(/<img[^>]+alt=['"]([^'"]*)['"][^>]*>/gi, "[$1]")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .replace(/&nbsp;/g, " ")
            .trim();
          all.push({
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
        if (total && all.length >= total) break;
        if (added === 0) break;
      }

      const users = [...new Set(all.filter((c) => c.userId).map((c) => c.userId))];
      const profiles = {};
      // 동시 5개씩 조회
      let done = 0;
      const workers = Array.from({ length: 5 }, async () => {
        while (users.length) {
          const u = users.shift();
          try {
            const h = await fetch("https://gallog.dcinside.com/" + encodeURIComponent(u), { credentials: "include" }).then((r) => r.text());
            const pm = h.match(/posting['"][^>]*>\s*게시글\s*<span[^>]*>\(([\d,]+)\)/);
            const cm = h.match(/comment['"][^>]*>\s*댓글\s*<span[^>]*>\(([\d,]+)\)/);
            profiles[u] = {
              posts: pm ? parseInt(pm[1].replace(/,/g, "")) : 0,
              replies: cm ? parseInt(cm[1].replace(/,/g, "")) : 0,
            };
          } catch (e) { profiles[u] = { posts: 0, replies: 0 }; }
          done++;
          st(`활동량 조회 ${done}명…`);
        }
      });
      await Promise.all(workers);

      const title = (document.querySelector(".title_subject") || {}).textContent || "";
      const gal = (document.querySelector(".title_headtext") || {}).textContent || gid;

      const data = {
        site: "dcinside",
        id: gid,
        no: gno,
        title: title.trim(),
        galleryName: gal.trim(),
        total: all.length,
        comments: all,
        profiles,
      };
      st("추첨기로 이동…");
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
      const target = SITE_URL + "#data=" + b64;
      window.open(target, "_blank");
      overlay.statusEl.innerHTML = `✓ 수집 완료 — ${all.length}개 댓글, ${Object.keys(profiles).length}명 활동량`;
      setTimeout(() => overlay.root.remove(), 2500);
    } catch (e) {
      overlay.statusEl.textContent = "실패: " + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function makeOverlay() {
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;top:20px;right:20px;z-index:999999;" +
      "background:#1a1410;color:#fff;padding:14px 18px;border-radius:10px;" +
      "font:14px 'Malgun Gothic',sans-serif;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.4);min-width:300px";
    root.innerHTML =
      '<b style="color:#ffd66b">🎰 도로롱 수집 중…</b>' +
      '<div id="dororong-status" style="margin-top:8px;font-size:12px;opacity:.85">준비 중…</div>';
    document.body.appendChild(root);
    return { root, statusEl: root.querySelector("#dororong-status") };
  }
})();
