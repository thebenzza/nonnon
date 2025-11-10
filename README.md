# LINE Pet Vaccine Bot — Firebase + Gemini (Railway)

## Quick Start
1) ตั้ง Railway Variables:
- LINE_CHANNEL_SECRET
- LINE_CHANNEL_ACCESS_TOKEN
- GEMINI_API_KEY  (AI Studio key)
- FIREBASE_SERVICE_ACCOUNT  (JSON ทั้งก้อน)
- TZ=Asia/Bangkok

2) Deploy → เช็ก
- GET /healthz  -> { ok: true }
- GET /version  -> เวอร์ชันปัจจุบัน
- GET /debug/firestore  -> { ok: true, id: "..." }

3) LINE Developers → Webhook URL: https://<your>.railway.app/webhook → Verify

4) ทดสอบแชต:
- เมนู
- เพิ่มหมาชื่อ โมจิ
- วัคซีน: Rabies 2025-11-03 365
- ฉีด Rabies ให้โมจิ 2025-11-03 รอบ 365
- ดูกำหนดวัคซีน / ดูวัคซีนของโมจิ

> หมายเหตุ: /webhook-raw และ /debug/firestore เป็น debug route แนะนำลบออกเมื่อใช้งานจริง
