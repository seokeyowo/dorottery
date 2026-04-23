// 빌드 후 exe에 아이콘 리소스를 삽입한다
const path = require("path");
const fs = require("fs");

(async () => {
  const { rcedit } = await import("rcedit");
  const exePath = path.resolve(__dirname, "..", "dist", process.argv[2] || "DororongLottery.exe");
  const iconPath = path.resolve(__dirname, "..", "public", "burger.ico");
  if (!fs.existsSync(exePath)) { console.error("exe not found:", exePath); process.exit(1); }
  if (!fs.existsSync(iconPath)) { console.error("icon not found:", iconPath); process.exit(1); }
  try {
    await rcedit(exePath, {
      icon: iconPath,
      "version-string": {
        ProductName: "Dororong Lottery",
        FileDescription: "DC 도로롱 기계식 키보드 갤러리 댓글 추첨기",
        CompanyName: "Dororong",
        LegalCopyright: "© Dororong",
      },
    });
    console.log("✅ icon embedded →", exePath);
  } catch (err) {
    console.error("❌ rcedit failed:", err);
    process.exit(1);
  }
})();
