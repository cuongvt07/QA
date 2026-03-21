# POD Auto Test - Detailed Implementation Plan (P0 -> N)

**Document version:** 1.0  
**Date:** 2026-03-19  
**Based on:** `docs/pod-autotest-quality-upgrade.md`  
**Primary goal:** tăng do tin cay theo tieu chi "sat review nguoi" va giam phan loai sai (false positive / false negative), khong toi uu pass-rate.

---

## 0) Muc Tieu Kinh Doanh + Ky Thuat

1. Giam false FATAL (bao loi oan nghiem trong) xuong muc co the van hanh.
2. Tang kha nang giai thich quyet dinh (explainability) o muc row-level va case-level.
3. Chuan hoa policy de AI tro thanh signal co kiem soat, khong la "single decider".
4. Dat duoc quality gate de release co can cu dinh luong.

### KPI target theo giai doan

- P0 target:
  - False FATAL rate <= 8% (giam nhanh so voi baseline hien tai)
  - 100% FATAL co `status_reason` + evidence
- P1 target:
  - False FATAL rate <= 3%
  - Precision(FATAL) >= 90%
  - 100% report co `raw_score`, `decision`, `reason_codes`
- P2 target:
  - False FATAL rate <= 1-2%
  - Precision(FATAL) >= 98%
  - Case-level agreement voi human >= 95%
- P3/N target (steady-state):
  - Drift control: metric khong xau hon > 10% theo rolling 2 tuan

---

## 1) Baseline Hien Tai (So lieu da kiem ke)

Tu tap report hien co (`web/reports`):

- Tong report: 26
- Tong case: 52
- PASS: 40
- FAIL: 4
- FATAL: 8
- Trong 8 FATAL:
  - 6 case pass toan bo steps
  - 8/8 case co AI final verdict = PASS
  - 8/8 case co temporal violations

**Nhan dinh baseline:** policy temporal hard-gate dang chiem uu the trong quyet dinh FATAL va co xac suat false-positive cao.

---

## 2) Nguyen Tac Trien Khai (bat buoc)

1. Khong sua nhieu thanh phan cung luc ma khong co benchmark.
2. Moi thay doi decision policy phai kem A/B metric truoc-sau.
3. Luon tach biet:
- `raw_quality_score` (chat luong do duoc)
- `final_decision` (quyet dinh van hanh)
4. Bat buoc co `REVIEW` class de tranh auto-phat oan.
5. Moi FAIL/FATAL/BLOCKER phai co reason code, evidence path, va replay context.

---

## 3) Lo Trinh P0 -> N (chi tiet theo sprint)

## P0 - Containment (1-2 tuan): chan false-FATAL ngay

### P0.1 - Temporal policy patch (uu tien cao nhat)

**Files:**
- `src/validators/temporal-consistency.js`
- `src/cli.js`

**Viec can lam:**
1. Doi nguong temporal tam thoi (safe mode):
- HIGH khi diffPercent >= 2.0
- FATAL khi diffPercent >= 8.0
2. Loai tru context de giam noise:
- bo qua step co `skip_diff_check=true`
- bo qua `dropdown`, `menu_opener`, step non-customization
3. Bo sung metadata cho tung violation:
- `pair_step_from`, `pair_step_to`
- `diffMaskArea`, `relativeArea`
- `is_context_excluded`
4. Trong `cli.js`, chi truyen nhung step du dieu kien vao temporal checker.

**Acceptance criteria:**
- Cung 1 tap regression, so FATAL giam >= 40% ma khong tang FAIL oan.
- Khong con case "steps all PASS + ai PASS + FATAL=0" ma khong co reason code ro.

### P0.2 - Reporter decision decouple

**File:** `src/utils/reporter.js`

**Viec can lam:**
1. Tach bien:
- `raw_score` = tong diem cac thanh phan
- `final_score` = diem hien thi (co the giong raw_score hoac co policy adjustment)
2. Bo rule hard reset `finalScore=0` khi co 1 temporal fatal don le.
3. Ap policy tam thoi:
- Neu temporal severe + cart fail hoac navigation fail -> `FATAL`
- Neu temporal severe nhung AI PASS + cart PASS + completion PASS -> `REVIEW`
4. Them field report:
- `decision`
- `decision_reason_codes`
- `status_reason`
- `raw_score`
- `confidence_score` (neu chua co thi de null, nhung field phai ton tai)

**Acceptance criteria:**
- 100% case co reason code khi khong PASS.
- Khong con score collapse ve 0 neu khong co multi-evidence critical.

### P0.3 - UI explainability

**Files:**
- `web/js/dashboard.js`
- (neu can) `web/index.html`

**Viec can lam:**
1. Hien thi o All Test Cases:
- `Decision` (`PASS_AUTO/FAIL_AUTO/REVIEW/FATAL`)
- `Score` (raw/final)
- `Reason`
2. Detail modal:
- show top 3 deduction reasons
- show temporal evidence summary
3. Export Excel:
- them cot `Decision`, `Reason Codes`, `Raw Score`, `Final Score`, `Confidence`

**Acceptance criteria:**
- Nguoi review co the biet ly do fail/fatal trong <= 30 giay cho moi case.

---

## P1 - Decision System Hoa (2-4 tuan)

### P1.1 - Bat Reliability v2 theo default

**Files:**
- `src/cli.js`
- `src/core/reliability-engine.js`
- `src/core/reliability-normalizer.js`

**Viec can lam:**
1. Bat `RELIABILITY_V2=true` theo default cho run test-case API.
2. Chuan hoa decision mapping:
- `PASS_AUTO`
- `FAIL_AUTO`
- `REVIEW`
- `BLOCKER`
3. Rule consensus:
- Can >=2 tin hieu critical de ra BLOCKER/FATAL.

### P1.2 - Data model + API consistency

**Files:**
- `src/repository.js`
- `src/server.js`

**Viec can lam:**
1. Dam bao API `/api/runs`, `/api/reports`, `/api/runs/:id` tra ve dong nhat:
- `status` (execution)
- `result_status` (business)
- `decision`
- `decision_reason_codes`
- `raw_score` / `score`
- `confidence_score`
2. Add backward-compatible fallback de UI cu khong vo.

### P1.3 - Rule registry

**Files:**
- `src/utils/reporter.js`
- `docs/` (new rule catalog)

**Viec can lam:**
1. Tao "rule catalog" voi ma quy tac (VD: `TEMPORAL_SEVERE`, `CART_HARD_FAIL`, `NAV_FAIL`).
2. Moi status khong PASS phai map duoc toi rule code.

**Acceptance criteria P1:**
- 100% report co decision metadata day du.
- Precision(FATAL) >= 90% tren benchmark mini.

---

## P2 - Calibration + Benchmark (4-8 tuan)

### P2.1 - Tao bo human-labeled benchmark

**Scope:** >= 300 case da gan nhan boi reviewer co guideline thong nhat.

**Nhan label toi thieu:**
- gold_status (`PASS/FAIL/REVIEW/BLOCKER`)
- severity
- root_cause_group (temporal/cart/nav/render/data)

### P2.2 - Eval harness

**Files:**
- `scripts/eval/` (tao moi)
- `docs/metrics/` (bao cao)

**Viec can lam:**
1. Script tinh confusion matrix theo class.
2. Tinh:
- precision/recall/F1
- false-FATAL rate
- review-rate
- calibration error (neu co confidence)
3. Report theo version rule.

### P2.3 - Threshold tuning framework

1. Grid search threshold temporal / confidence gate.
2. Chon threshold theo objective:
- uu tien giam false-FATAL
- giu duoc recall cho case fail that.

**Acceptance criteria P2:**
- False FATAL <= 2%
- Agreement voi human >= 95%

---

## P3 - Production Hardening (8-12 tuan)

1. A/B canary policy moi tren 10-20% traffic run.
2. Versioning policy (`decision_policy_version`) trong report.
3. Rollback 1-click ve policy cu neu metric xau di.
4. Dashboard KPI theo tuan/thang.

---

## N - Van hanh lien tuc (continuous improvement)

1. Hang tuan:
- triage 20 case disagreement lon nhat
- cap nhat rule catalog
2. Hang thang:
- re-calibration threshold
- retrain exemplar prompt cho AI (neu dung retrieval/few-shot)
3. Moi release:
- phai dat quality gate truoc merge.

---

## 4) Chi tiet task theo file (implementation checklist)

## 4.1 `src/validators/temporal-consistency.js`

**Task list:**
- [ ] Them config threshold thong qua env:
  - `TEMPORAL_HIGH_THRESHOLD`
  - `TEMPORAL_FATAL_THRESHOLD`
- [ ] Filter steps theo `group_type` va `skip_diff_check`
- [ ] Return metadata chi tiet cho violation
- [ ] Unit tests cho cac case:
  - diff nho khong tao FATAL
  - skip context khong tinh violation

**Definition of done:**
- Test local pass
- report co metadata temporal moi

## 4.2 `src/utils/reporter.js`

**Task list:**
- [ ] Tach `raw_score` / `final_score`
- [ ] Sua hard-gate logic thanh consensus gate
- [ ] Them `decision`, `decision_reason_codes`, `status_reason`
- [ ] Add downgrade path tu FATAL -> REVIEW neu conflict signals

**Definition of done:**
- snapshot report truoc/sau khong vo schema
- case conflict khong bi ep 0 diem vo dieu kien

## 4.3 `src/cli.js`

**Task list:**
- [ ] Truyen context da loc vao temporal checker
- [ ] Bat reliability v2 theo feature flag default an toan
- [ ] Ensure reason codes day du khi build report

## 4.4 `src/repository.js` + `src/server.js`

**Task list:**
- [ ] Expose decision fields trong API list/detail
- [ ] Merge report-run khong lam mat decision metadata
- [ ] Backward compatibility cho data cu

## 4.5 `web/js/dashboard.js`

**Task list:**
- [ ] Them cot Decision/Reason/Confidence
- [ ] badge mau rieng cho REVIEW
- [ ] tooltip hien top deduction reasons
- [ ] export excel bo sung cot giai thich

---

## 5) Test Plan chi tiet (bat buoc truoc merge)

## 5.1 Unit tests

1. Temporal checker:
- threshold mapping
- context exclusion
- severity classification
2. Reporter decision:
- consensus gating
- reason code emission
- raw/final score consistency

## 5.2 Integration tests

1. Run end-to-end 20 case mau co nhan.
2. Verify API fields consistency (`runs`, `reports`, `run detail`).
3. Verify UI render dung status/decision sau reload.

## 5.3 Regression set

1. Chay lai cac code co lich su false-FATAL:
- `PRINTERVAL_1746040`
- `PRINTERVAL_1746190`
- `PRINTERVAL_1746432`
- `PRINTERVAL_1746493`
- `PRINTERVAL_1746550`
2. So sanh metric truoc/sau.

---

## 6) Rollout Strategy + Rollback

## 6.1 Rollout

1. Stage 1: internal only (100% dry-run metadata mode)
2. Stage 2: canary 20% run dung policy moi
3. Stage 3: full rollout neu dat KPI

## 6.2 Rollback condition

Rollback ngay neu 1 trong cac dieu kien:

1. False FATAL tang > 30% so voi 2 tuan truoc.
2. Review backlog tang vuot nguong SLA.
3. API schema mismatch gay vo dashboard/export.

## 6.3 Rollback mechanism

- policy version env var:
  - `DECISION_POLICY_VERSION=v1|v2`
- toggle:
  - `ENABLE_RELIABILITY_V2=true/false`

---

## 7) Governance + Ownership

## Vai tro de xuat

1. Rule owner (QA architect): quyet dinh threshold/policy.
2. Data owner (QA lead): benchmark labeling quality.
3. Platform owner (eng): API/UI/report consistency.
4. Release owner: phe duyet quality gate.

## Cadence

1. Daily 15m: blocker + false fatal triage.
2. Weekly 60m: metric review + threshold proposals.
3. Bi-weekly: policy version release window.

---

## 8) Chi tiet KPI dashboard de can theo doi

1. By status:
- PASS/FAIL/REVIEW/FATAL ratio
2. By quality:
- raw score distribution
- confidence distribution
3. By disagreement:
- AI vs decision conflict
- human vs system conflict
4. By root cause:
- temporal/cart/nav/render/data buckets
5. Time metrics:
- mean time to explain
- mean time to final adjudication

---

## 9) Reference implementation notes (de code nhanh)

1. Introduce decision object chung trong report:

```json
{
  "decision": {
    "label": "REVIEW",
    "policy_version": "v2",
    "reason_codes": ["TEMPORAL_SEVERE_SINGLE_SIGNAL"],
    "raw_score": 88,
    "final_score": 88,
    "confidence_score": 0.63
  }
}
```

2. Quy uoc uu tien:
- execution status (`RUNNING/COMPLETED`) khac business decision (`PASS_AUTO/REVIEW/...`).

3. Luon co explainability fields:
- `status_reason`
- `decision_reason_codes`
- `top_deductions`

---

## 10) Ke hoach thoi gian de xuat (thuc te)

1. Week 1:
- P0.1 + P0.2 implementation
- unit test co ban
2. Week 2:
- P0.3 UI + export
- canary nho
3. Week 3-4:
- P1 full metadata/API consistency
- bat reliability v2
4. Week 5-8:
- P2 benchmark + calibration
5. Week 9+:
- P3 hardening + continuous governance

---

## 11) Definition of Success

He thong duoc coi la "dang tin de van hanh" khi dong thoi dat:

1. False FATAL <= 2%
2. Precision(FATAL) >= 98%
3. Human agreement >= 95%
4. 100% case non-pass co explainability day du
5. Team co the truy vet ly do quyet dinh trong < 30s/case

---

## 12) Next Actions ngay lap tuc (ngay mai co the lam)

1. Mo PR #1: Temporal + Reporter decouple (P0.1 + P0.2).
2. Chon 30 case disagreement de lam mini benchmark.
3. Add 4 KPI cards vao dashboard: False FATAL, Review Rate, Human Agreement, Explainability Coverage.
4. Set policy versioning env var truoc khi rollout.

---

## 13) Appendix - Mapping nhanh tu issue -> file

1. False FATAL do temporal: `src/validators/temporal-consistency.js`, `src/utils/reporter.js`
2. Mat metadata sau sync/reload: `src/repository.js`, `src/server.js`, `web/js/dashboard.js`
3. UI khong giai thich duoc: `web/js/dashboard.js`
4. Export thieu reason/decision: `web/js/dashboard.js` (export section)

---

**Ghi chu:** Document nay la implementation playbook. Neu can, co the tach tiep thanh 3 file thao tac: `spec.md`, `taskboard.md`, `qa-gate.md`.
