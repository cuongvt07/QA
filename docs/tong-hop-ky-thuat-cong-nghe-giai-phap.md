# Tong hop ky thuat, cong nghe va giai phap cua tool

## 1. Muc tieu cua tool

Tool nay duoc xay dung de tu dong hoa E2E test cho website ban san pham co ca nhan hoa (custom product), tap trung vao:

- Tu dong thao tac tren customizer (chon option, nhap text, upload anh).
- Kiem tra thay doi preview bang code-based diff + AI review.
- Kiem tra Add to Cart.
- Ghi log loi JS/console/network.
- Sinh report de xem tren dashboard web.

---

## 2. Kien truc tong the

```
[Dashboard UI (web)]
        |
        v
[Express API server: src/server.js]
        |
        v
[CLI Engine: src/cli.js]
        |
        v
[Playwright Browser Automation]
        |
        v
[Target Product Website]
        |
        v
[Reports + screenshots in web/reports/*]
        |
        v
[Dashboard read /api/reports de hien thi]
```

Kien truc chia 3 lop chinh:

- Engine layer: Chay test logic va danh gia.
- API layer: Trigger run, tra status, quan ly report files.
- UI layer: Quan ly test case, theo doi run, xem report chi tiet.

---

## 3. Cong nghe su dung

### Runtime va backend

- Node.js (CommonJS modules).
- Express + CORS (`src/server.js`).
- `dotenv` de quan ly bien moi truong.
- `yargs` cho CLI options.

### E2E automation

- Playwright (`chromium`) cho browser automation.
- He thong selector fallback de ho tro nhieu giao dien customizer.

### Image/visual validation

- `pixelmatch` + `pngjs` de tinh diff phan tram truoc/sau.
- `sharp` de optimize anh truoc khi gui AI.
- `src/utils/annotate-image.js` de ve bounding boxes tren anh ket qua AI.

### AI va OCR

- OpenAI SDK (`openai`) voi 2 model:
  - Step-level: `gpt-4o-mini`.
  - Final review: `gpt-4o`.
- `tesseract.js` co module OCR (`src/utils/ocr-validator.js`) de verify text tren preview.

### Frontend dashboard

- Vanilla HTML/CSS/JS (`web/index.html`, `web/css/dashboard.css`, `web/js/dashboard.js`).
- API polling de dong bo trang thai run.
- Du lieu test case/run co storage phia server trong `web/data/*.json`.

---

## 4. Luong xu ly E2E chinh

## 4.1 Khoi tao run

1. Nhan URL tu CLI hoac dashboard.
2. Mo browser Playwright (co headless option).
3. Navigate trang san pham.
4. Tu dong an popup/quang cao bang JS injection (khong click random element).
590. Detect customizer widget.
91. Tu dong quet va chon cac bien the san pham (Style/Size) ben ngoai customizer de dam bao co the "Add to Cart" thanh cong.

## 4.2 Quet option va tao test cases

1. Quet group image_option dau tien de lay danh sach option.
2. Neu scan mode (`--scan`) thi in JSON va thoat.
3. Neu run test:
   - Co the chay 1 option cu the (`--option-index`).
   - Hoac lay option scan duoc.
   - He thong chay **exactly 2 case moi testcase** (khong 3+ case trong 1 run).

## 4.3 Customization flow (dynamic)

`performCustomization()` trong `src/actions/customizer.js`:

- Re-scan cac group lien tuc de bat dynamic sub-group moi.
- Xu ly cac loai control:
  - `text_input`: sinh data mau va nhap text.
  - `dropdown`: chon option hop le.
  - `image_option`: chon swatch/variant.
  - `file_upload`: upload anh tu `images/` (neu khong truyen `customImageFilename` se dung mac dinh `test-dog.png`; neu co truyen se uu tien file duoc truyen, neu khong ton tai thi fallback ve mac dinh).
- Moi step deu chup `before` va `after`.
- Dung `smartWait()` de cho render on dinh:
  - Tu dong bo qua cac request tu tracking/analytics (GA, FB, Klaviyo, v.v.) de tranh cho doi vo ich.
  - Giam thoi gian cho bat dau xuong 1s (truoc day la 2s).
  - Ho tro placeholder loading spinner detection voi timeout 20s.

## 4.4 Validation va scoring

1. Pixel diff:
   - So sanh anh before/after bang `pixelmatch`.
   - **Co che Auto-Pass**: Tu dong PASS neu diff <= 0.05% (neu bat `DIFF_AUTO_PASS_ZERO`) hoac diff >= `DIFF_AUTO_PASS_HIGH`.
   - **Xy ly thay doi nho**: Coi moi thay doi >= 0.01% la PASS (phu hop voi nhap text ngan).
   - **Hieu nang**: Xu ly doc va parse PNG theo co che bat dong bo (Async) de khong lam nghen CPU khi chay parallel.
2. Preview validation:
   - Check image/canvas co render dung khong.
   - Bat cac loi nhu `BROKEN_IMAGE_LINK`, `CANVAS_CRASH`, `PREVIEW_RENDER_FAIL`.
3. Add to cart validation:
   - Check mini-cart drawer ben phai (`.mini-cart-drawer`, `.item-summary-product`, `View cart`...).
   - Chup evidence popup ben phai de luu report va debug.
4. Error listener:
   - Thu JS runtime error, console error, network error.
   - Danh dau fatal neu lien quan API customily.

## 4.5 AI evaluation

- Step-level AI:
  - Chay cho cac step anh huong truc tiep (`text_input`, `image_option`, `file_upload`).
  - So sanh before/after de danh gia dung sai theo step.
- Add-to-cart AI:
  - Chay tren anh evidence mini-cart sau khi bam Add to Cart.
  - Tra ve verdict/rationale rieng cho step `add_to_cart`.
- Final AI review (neu co key va preview hop le):
  - Gui anh cuoi + context custom actions.
  - Nhan verdict PASS/FAIL + reason + detected elements.
  - Ve bounding boxes len anh de debug truc quan.
  - Dung palette 20 mau de tranh lap mau khung khi co nhieu doi tuong.

## 4.6 Report output

- Tao thu muc run theo ma testcase (`TC_*` hoac custom code nhu `MEE001`).
- Cau truc:
  - `web/reports/<TC_CODE>/case_1/*`
  - `web/reports/<TC_CODE>/case_2/*`
  - `web/reports/<TC_CODE>/report.json`
- Report gom:
  - summary toan run,
  - danh sach case,
  - timeline tung step,
  - score breakdown,
  - final evaluation va danh sach errors.

---

## 5. Giai phap ky thuat noi bat

## 5.1 Chiu duoc UI dong

- Khong hard-code mot flow co dinh.
- Re-scan group sau moi thao tac de bat cac field moi hien ra.
- Dung group signature (`name|type|groupId|nameIndex`) de tranh xu ly lap.

## 5.2 Giam flakiness

- `smartWait()` phan biet truong hop co API call hay khong.
- Cho loading hide + buffer render canvas.
- `ensureCleanPage()` go popup truoc/sau action.
- Skip diff cho step khong anh huong visual.

## 5.3 Danh gia da lop

- Lop 1: Code-based pixel diff (khach quan, nhanh).
- Lop 2: AI vision review (bo sung ngu nghia hien thi).
- Lop 3: Runtime health (JS/console/network + API fatal).

## 5.4 Bao cao de debug nhanh

- Luu cap anh before/after theo step.
- Luu snapshot HTML khi FAIL/FATAL.
- Co annotation bounding box cho AI final review.
- Co evidence rieng cho Add to Cart popup ben phai.
- Cac option mau co them metadata mau (`option_color_hex`) va hien thi swatch + ma mau tren timeline/UI.
- Dashboard xem timeline, score, errors, case tabs.
- **Scrollable Timeline**: Step timeline hien tai co the cuon (scroll) de de dang quan ly cac case co nhieu buoc ma khong lam vo giao dien.
- **Performance Logging**: CLI in ra thoi gian thuc hien cho tung giai doan (Navigation, Variants, Customization, Evaluation, AI Review) de de dang tim "nut that" hieu nang.

---

## 6. API va dashboard

Server (`src/server.js`) cung cap 2 nhom API:

### 6.1 API test case + run management (moi)

- `GET /api/test-cases`: danh sach test case.
- `POST /api/test-cases`: tao test case (`name` optional, auto sinh theo dang `MEE###` neu khong truyen).
- `GET /api/test-cases/:id`: detail test case + runs lien quan.
- `DELETE /api/test-cases/:id`: xoa test case (va du lieu lien quan).
- `POST /api/test-cases/:id/run`: run test case do.
- `GET /api/runs`: danh sach run (co the loc theo `test_case_id`).
- `GET /api/runs/:runId`: detail run + report detail.
- `DELETE /api/runs/:runId`: xoa run va report cua run (neu co).

### 6.2 API tuong thich dashboard cu

- `POST /api/run`: trigger test truc tiep.
- `GET /api/run-status/:runId`: poll trang thai.
- `GET /api/reports`: lay danh sach report.
- `DELETE /api/reports/:code`: xoa 1 report folder.
- `DELETE /api/reports-all`: reset toan bo reports.
- `POST /api/upload-image`: upload anh custom cho file-upload step.

### 6.3 Storage phia server

- `web/data/test-cases.json`: luu test cases.
- `web/data/test-runs.json`: luu lich su runs.
- `web/reports/*`: artifact + report json.

Dashboard (`web/js/dashboard.js`) ho tro:

- Quan ly test cases.
- Trigger run headless/visible + bat/tat AI.
- Hien thi RUNNING state realtime.
- Import report JSON.
- Xem chi tiet run theo case va timeline.

---

## 7. Cach van hanh co ban

### Chay CLI truc tiep

```bash
node src/cli.js --url="https://your-product-url"
node src/cli.js --url="https://your-product-url" --scan
node src/cli.js --url="https://your-product-url" --option-index=0
node src/cli.js --url="https://your-product-url" --tc-code=MEE001 --no-ai
```

### Chay dashboard server

```bash
node src/server.js
```

Mo trinh duyet: `http://localhost:8090`

---

## 8. Ghi chu hien trang (quan trong)

- Trong comment co nhac "Gemini", nhung implementation AI hien tai dang dung OpenAI:
  - `gpt-4o-mini` cho step-level.
  - `gpt-4o` cho final review.
- Module OCR (`src/utils/ocr-validator.js`) da co, nhung chua thay duoc goi truc tiep trong main flow hien tai.
- Reporting va dashboard da ho tro multi-case run (2 case/testcase), case-level score, AI detected customizations, va hien thi mau (`swatch + #HEX`) cho option mau.
