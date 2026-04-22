# 도로롱 로터리 (Node.js 버전)

DC인사이드 게시글 댓글을 자동 수집해 추첨하는 도구.

## 로컬 실행 (exe)

`dist/DororongLottery.exe` 더블클릭 → 브라우저가 자동으로 `http://localhost:3939` 로 열립니다.

## 개발 모드

```
npm install
npm start
# 또는 파일 변경 시 자동 재시작
npm run dev
```

## exe 빌드

```
npm run build
```
→ `dist/DororongLottery.exe` 생성 (약 53MB, Node 런타임 내장).

## 웹 호스팅 배포

### 공통
- `PORT` 환경변수가 있으면 자동으로 `0.0.0.0`에 바인딩하고 해당 포트로 listen.
- `npm start` 가 표준 시작 명령.

### Render / Railway / Heroku
- Build Command: `npm install`
- Start Command: `npm start`
- `PORT` 자동 주입됨

### iwinv / Cafe24 / VPS
```bash
git clone <repo>
cd <repo>
npm install --production
PORT=80 npm start
```
또는 systemd 서비스 등록:
```ini
[Service]
ExecStart=/usr/bin/node /opt/dororong/server.js
Environment=PORT=3939
Environment=HOST=0.0.0.0
Restart=always
```

## 파일 구조

```
dororong-js/
├── server.js         # Node 백엔드 (express + cheerio)
├── public/
│   ├── index.html    # 프론트엔드 (단일 파일)
│   └── burger.png    # 로고
├── package.json
└── dist/
    └── DororongLottery.exe
```

## 주의

DC인사이드는 클라우드 데이터센터 IP를 차단할 수 있어, 웹 호스팅 시 해외 리전(AWS, GCP 등)에서는 타임아웃이 발생합니다. 한국 리전 VPS(iwinv, Cafe24 등) 또는 가정용 회선에서 운영하세요.
