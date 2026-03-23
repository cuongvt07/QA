# Tai Lieu Tong Quan He Thong va Van Hanh

## 1. Muc tieu tai lieu

Tai lieu nay tong hop trang thai hien tai cua he thong `Automated Custom Product Testing Tool (E2E)` sau cac dot nang cap gan day, bao gom:

- kien truc tong the
- luong chay test case
- cach web dong bo du lieu tu API
- y nghia cac truong ket qua
- xuat Excel
- van hanh batch daily
- goi y deploy va cronjob
- nhung diem da on va nhung diem chua lam tiep

Tai lieu nay huong toi 2 nhom:

- team dev/qa can hieu he thong dang hoat dong the nao
- team van hanh can biet cach deploy, goi API va theo doi batch daily

---

## 2. Kien truc tong the

He thong hien tai co 6 lop chinh:

1. `web/`
- giao dien dashboard
- quan ly settings
- render danh sach test case, recent runs, report detail
- xuat Excel
- dong bo du lieu tu API bang `Sync Data`

2. `src/server.js`
- HTTP API
- queue chay test case
- bridge giua web, DB va CLI engine
- route batch daily
- SSE/polling support cho web sync

3. `src/cli.js`
- orchestration khi chay 1 test case
- mo browser, scan variants, chay customization, validation, AI review, build report
- co `case concurrency` rieng trong 1 test case

4. `src/actions/*`, `src/validators/*`, `src/utils/*`
- xu ly preview/customizer
- pixel diff, SSIM, OCR, color, temporal, cart
- tinh diem, confidence, decision

5. `src/repository.js` + DB
- doc/ghi `test_case`, `test_run`, `test_report`, `settings`
- enrich report metadata cho API list/detail

6. `web/reports/`
- noi luu artifact va report JSON tren disk
- moi `tc_code` co mot thu muc rieng
- report tong nam tai `web/reports/<TC_CODE>/report.json`

---

## 3. Luong chay 1 test case

### 3.1. Luc chay tu web hoac API theo test case

Route chuan de chay 1 TC la:

- `POST /api/test-cases/:id/run`

Flow:

1. server tao `test_run`
2. dua run vao queue
3. queue den luot se goi `src/cli.js`
4. CLI chay tung case trong TC
5. reporter build `report.json`
6. server cap nhat DB
7. web `Sync Data` hoac reload se thay ket qua moi

### 3.2. Concurrency hien tai

He thong co 2 tang concurrency:

1. `server queue concurrency`
- so TC duoc chay dong thoi o tang server
- hien tai mac dinh la `5`
- co the doi bang env:
  - `RUN_QUEUE_CONCURRENCY`
  - `SERVER_QUEUE_CONCURRENCY`

2. `CLI case concurrency`
- so case ben trong 1 TC duoc chay dong thoi
- hien tai default duoc de `2`
- route server se truyen xuong CLI

Dieu nay co nghia la:

- neu queue = 5
- va case concurrency = 2
- thi toi da co the co 10 case dang xu ly dong thoi

Trong van hanh server that, nen can doi phu hop tai nguyen may chu.

---

## 4. Web sync va API contract hien tai

### 4.1. Muc tieu

Yeu cau van hanh hien tai la:

- goi API de run
- web bam `Sync Data` hoac reload van thay dung trang thai
- recent runs, all test cases va detail modal doc duoc cung mot bo ket qua

### 4.2. Endpoint web dang dung

Web hien sync du lieu qua:

- `GET /api/test-cases`
- `GET /api/runs`
- `GET /api/reports`
- `GET /api/runs/:runId`

Backend da duoc chinh de:

- `/api/runs` va `/api/reports` tra ve field enrich
- `/api/runs/:runId` khong con qua "raw" nhu truoc
- `confidence_score` duoc chuan hoa ve thang `0..1`

### 4.3. Ket luan ve muc do dong bo

Trang thai hien tai:

- web + API da dong bo du de van hanh
- luong `run -> Sync Data -> mo detail` da on hon truoc ro ret
- frontend van con lop normalize de hop nhat contract, nhung backend da sach hon nhieu

Noi ngan gon:

- dung duoc cho van hanh hang ngay
- chua phai "enterprise contract versioning", nhung da oce cho nhu cau hien tai

---

## 5. Y nghia cac truong ket qua

De tranh nham lan, he thong hien tai tach cac lop status nhu sau:

### 5.1. `execution_status`

Trang thai thuc thi:

- `QUEUED`
- `RUNNING`
- `COMPLETED`
- `FAILED`

Day la trang thai "run dang chay toi dau".

### 5.2. `result_status`

Trang thai ket qua nghiep vu tong quat:

- `PASS`
- `FAIL`
- `REVIEW`
- `FATAL`

Day la business result co the hien tren web/export.

### 5.3. `report_status`

Trang thai tong hop tu report da luu tren disk.

Thong thuong no trung hoac rat gan `result_status`.

### 5.4. `decision`

Business decision chi tiet hon cua reliability engine:

- `PASS_AUTO`
- `FAIL_AUTO`
- `REVIEW`
- `FATAL`

Web va export nen uu tien doc `decision` khi muon biet "he thong ket luan theo logic reliability la gi".

### 5.5. `raw_score`

Diem goc truoc khi decision/confidence policy can thiep.

### 5.6. `quality_score`

Diem sau khi reliability engine tong hop signal.

### 5.7. `confidence_score`

Do tu tin cua ket luan, hien tai da chuan hoa ve thang:

- `0.0 -> 1.0`

Khuyen nghi:

- `>= 0.9`: rat tin cay
- `0.75 - 0.89`: kha tin cay
- `< 0.75`: can than trong hon, de `REVIEW` la hop ly

---

## 6. Hien trang danh gia chat luong test

Sau cac dot fix gan day, he thong da cai thien ro o 4 diem:

1. Giam false-FATAL / false-FAIL
- temporal khong con "ket an oan" nhu truoc
- lifecycle step khong con bi `UNAVAILABLE` vo ly

2. OCR va color it keo score xuong oan hon
- color audit khong con dung nen thumbnail trang lam expected color
- OCR exact/fuzzy match duoc credit hop ly hon

3. AI final review da quay lai flow dung
- khong bi block cung chi vi `preview_valid=false` neu van co `final_preview.png`

4. Web/API/report giong nhau hon
- web sync ra data doc duoc va bieu dien nhat quan hon

Trang thai danh gia thuc te hien tai:

- AI-enabled: da o muc co the dung de van hanh batch thuc te
- CPU-only: da on hon truoc nhieu, nhung van bao thu hon AI-enabled

Luu y:

- he thong da tot hon ro ret
- nhung van nen giu lane `REVIEW`
- chua nen xem nhu hard gate 100% khong can con nguoi

---

## 7. Xuat Excel

Phan export Excel da duoc lam lai de doc de hon.

### 7.1. Cac sheet hien tai

1. `Tong_Quan`
- tong hop theo TC/run
- status, result, decision, score, confidence, case counts, ly do chinh

2. `Chi_Tiet_Case`
- moi dong la 1 case
- AI final, strengths/layout/colors/content, reason, score

3. `Chi_Tiet_Buoc`
- moi dong la 1 step
- diff, ssim, OCR, color, temporal, AI reason, verdict

4. `Giai_Thich`
- giai nghia cac cot va cach doc ket qua

### 7.2. Ngon ngu

Khuyen nghi hien tai:

- he thong export nen de tieng Viet cho:
  - ten cot
  - ten sheet
  - phan giai thich
  - phan tom tat de doc nhanh

- AI raw text nen giu nguyen ngon ngu goc
  - tranh meo nghia
  - de doi chieu khi debug

Tom lai:

- UX nen la tieng Viet
- AI raw nen giu nguyen

---

## 8. Daily batch v1: chi chay TC moi

Day la tinh nang batch daily da duoc them de phuc vu server + cronjob.

### 8.1. Muc tieu

- moi ngay chi lay cac TC moi tinh
- so luong lay moi ngay co the cau hinh tren giao dien
- server van chay theo queue, khong ban 100 TC cung luc

### 8.2. Rule chon TC moi

Daily batch v1 hien tai chi chon cac TC:

- khong o trang thai `QUEUED` hoac `RUNNING`
- `last_run_id IS NULL`
- chua tung co `test_run` trong DB

Noi ngan gon:

- "moi tinh"
- "chua tung chay"

### 8.3. API daily moi

Route:

- `POST /api/batches/daily-new`

API nay se:

1. doc `limit`
2. chon dung so TC moi theo rule
3. dua vao queue bang luong chay co san
4. tra summary queue

### 8.4. Setting tren giao dien

Trong `Settings` da co:

- `Daily New Test Case Limit`

Ngoai ra co nut test tay:

- `Queue Daily New Run`

Muc dich:

- test batch daily ngay tren web
- truoc khi dua vao cronjob

### 8.5. Queue hien tai

Queue mac dinh server hien tai:

- `5 TC cung chay mot luc`

Phan con lai se nam trong queue.

Dieu nay rat quan trong:

- limit daily co the la 100
- nhung khong co nghia 100 TC se chay dong thoi

---

## 9. Goi y deploy va cronjob

### 9.1. Cach goi cron dung

Khong nen cron loop 100 lan de goi tung:

- `POST /api/test-cases/:id/run`

Nen cron chi goi duy nhat:

- `POST /api/batches/daily-new`

Vi du payload:

```json
{
  "limit": 100,
  "headless": true,
  "useAi": true
}
```

Neu khong truyen `limit`, server se lay tu setting/env.

### 9.2. Env nen dung

- `RUN_QUEUE_CONCURRENCY=5`
- `DAILY_NEW_TC_LIMIT=100`

Neu server thuc te yeu hon mong doi, co the ha:

- `RUN_QUEUE_CONCURRENCY=3`

### 9.3. Luong van hanh khuyen nghi

1. cron goi `/api/batches/daily-new`
2. server chon TC moi
3. queue chay dan
4. web bam `Sync Data` hoac reload se thay duoc run moi
5. report va Excel co the xuat duoc binh thuong

---

## 10. Time va performance hien tai

Danh gia thuc te gan day cho thay:

- he thong da quay ve muc runtime hop ly hon so voi giai doan bi regression
- 2 case trong 1 TC dang chay song song dung
- bottleneck lon nhat van la `phase_customization`

Tom tat:

1. `phase_ai_review`
- hien tai khong phai bottleneck lon
- da duoc goi lai dung khi co final preview hop le

2. `phase_variants`
- da nhe hon truoc

3. `phase_customization`
- van la phan an thoi gian nhat
- neu muon tu 6-7 phut xuong 5 phut hoac thap hon, day la noi can toi uu tiep

4. hidden overhead
- van con ton tai o mot so product nặng
- can instrument them neu muon toi uu sau hon nua

---

## 11. Nhung gi da xong va nhung gi chua xong

### 11.1. Da xong

- web va API sync on hon
- `/api/runs`, `/api/runs/:runId`, `/api/reports` on hon truoc
- export Excel ro rang hon
- daily batch v1 chi chay TC moi da co
- queue theo TC dang hoat dong
- AI final review da duoc noi lai dung flow
- OCR/color/temporal da giam false fail oan

### 11.2. Chua xong

- auto retry TC fail theo infra/business
- batch history table rieng
- overlap lock de tranh cron chay chong
- watchdog mark run treo
- selection mode nang cao:
  - retry failed
  - mixed daily
  - only changed products

---

## 12. Ke hoach tiep theo duoc khuyen nghi

Neu muon dua len server chay 100 TC/ngay on hon, thu tu uu tien nen la:

1. them `cron-safe lock`
- tranh mot ngay goi batch nhieu lan

2. them `retry policy` chi cho `INFRA_FAIL`
- khong retry vo toi va voi fail functional that

3. them `watchdog`
- run treo qua lau se bi mark lai dung

4. them batch history
- de biet ngay hom do da chay batch nao, bao nhieu TC, ti le PASS/REVIEW/FAIL ra sao

5. toi uu them `phase_customization`
- neu muc tieu la batch chay nhanh hon nua

---

## 13. Ket luan

Trang thai hien tai cua he thong la:

- da qua muc prototype de bat dau van hanh batch co kiem soat
- web va API da dong bo du de dung thuc te
- daily new batch da co ban v1
- export/report da ro rang hon cho nguoi doc

Nhung cach dung dung nhat o thoi diem nay van la:

1. `PASS_AUTO` confidence cao
- co the tin tuong nhieu hon

2. `REVIEW`
- van nen co nguoi review

3. `FAIL/FATAL`
- la tin hieu manh, nhung voi batch lon van nen co spot-check

Noi ngan gon:

- he thong hien tai da "oce de dung"
- de len server chay daily duoc
- nhung van nen di tiep theo huong `retry + lock + watchdog` de thanh ban van hanh production chac tay hon

