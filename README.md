# Custom Product QA Engine (E2E)

Engine tu dong test E2E cho website custom product:

- Tu dong thao tac customizer (text, dropdown, image option, file upload).
- Validate thay doi preview bang code diff + AI.
- Verify Add to Cart + chup bang chung popup mini cart ben phai.
- Sinh report JSON + screenshot de xem tren dashboard.

Tai lieu chi tiet ky thuat: [tong-hop-ky-thuat-cong-nghe-giai-phap.md](./tong-hop-ky-thuat-cong-nghe-giai-phap.md)

## 1) Yeu cau

- Node.js 18+.
- Da cai npm.
- Co API key neu dung AI:
  - `OPENAI_API_KEY` trong `.env`.

## 2) Cai dat

```bash
npm i
npx playwright install chromium
```

## 3) Chay he thong

```bash
node src/server.js
```

Mo dashboard: `http://localhost:8090`

## 4) Chay CLI truc tiep

```bash
node src/cli.js --url="https://your-product-url"
node src/cli.js --url="https://your-product-url" --scan
node src/cli.js --url="https://your-product-url" --option-index=0
node src/cli.js --url="https://your-product-url" --tc-code=MEE002 --no-ai
```

Luu y:

- Moi run hien tai chay **exactly 2 case / 1 testcase**.
- Ket qua luu trong `web/reports/<TC_CODE>/`.

## 5) API tai `src/server.js`

### Test case management

- `GET /api/test-cases`: danh sach test case.
- `POST /api/test-cases`: tao test case moi (`name` la optional, khong truyen se auto sinh `MEE###`).
- `GET /api/test-cases/:id`: xem detail test case + runs lien quan.
- `DELETE /api/test-cases/:id`: xoa test case (va runs/report lien quan neu co).
- `POST /api/test-cases/:id/run`: run test case do.

Payload tao test case:

```json
{
  "url": "https://meear.com/..."
}
```

### Curl example (copy vao Postman)

Vi du day du cho API tao test case:

```bash
curl --location 'http://localhost:8090/api/test-cases' \
--header 'Content-Type: application/json' \
--data '{
  "name": "MEE002",
  "url": "https://meear.com/personalized-kid-baseball-player-christmas-keychain-2025-new-release-p117179"
}'
```

Response mau:

```json
{
  "id": "TC_1732351111111_ab12cd",
  "name": "MEE002",
  "url": "https://meear.com/personalized-kid-baseball-player-christmas-keychain-2025-new-release-p117179",
  "status": "pending",
  "created_at": "2026-03-16T12:34:56.789Z",
  "updated_at": "2026-03-16T12:34:56.789Z"
}
```

Import vao Postman:

1. Mo Postman -> `Import`.
2. Chon `Raw text`.
3. Paste nguyen lenh `curl` o tren -> `Continue` -> `Import`.

Neu muon custom ten:

```json
{
  "name": "MEE002",
  "url": "https://meear.com/..."
}
```

Payload run test case:

```json
{
  "headless": true,
  "useAi": true,
  "optionIndex": 0,
  "customImageFilename": "custom_upload_default.png"
}
```

Ghi chu `customImageFilename`:

- Khong truyen: engine dung anh mac dinh `images/test-dog.png`.
- Co truyen: engine uu tien file trong thu muc `images/` theo ten ban truyen.
- Neu ten truyen vao khong ton tai: tu dong fallback ve `images/test-dog.png`.

### Run management

- `GET /api/runs`: danh sach run (co the loc `?test_case_id=...`).
- `GET /api/runs/:runId`: detail run + report detail (neu co).
- `DELETE /api/runs/:runId`: xoa run (va report cua run neu co).

### Backward-compatible endpoints (dashboard hien tai dang dung)

- `POST /api/run`
- `GET /api/run-status/:runId`
- `GET /api/reports`
- `DELETE /api/reports/:code`
- `DELETE /api/reports-all`
- `POST /api/upload-image`

## 6) Data va report

- Test case storage: `web/data/test-cases.json`
- Run storage: `web/data/test-runs.json`
- Report output: `web/reports/<TC_CODE>/report.json`

Moi case thuong gom:

- `case_1/step_*_before.png`
- `case_1/step_*_after.png`
- `case_2/...`
- Add-to-cart evidence (`*_add_to_cart_popup.png` hoac `*_viewport.png`)

## 7) AI hien tai

- Step-level AI: `gpt-4o-mini`.
- Final review AI: `gpt-4o`.
- Add-to-cart AI review tren anh evidence mini-cart.
- Palette 20 mau de ve bounding boxes cho `AI Detected Customizations`.
