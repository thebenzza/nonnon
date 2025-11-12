// 🌟 Version 2025-11-12 — Pet Assistant (Nonnon) Full Server.js

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import admin from "firebase-admin";
import line from "@line/bot-sdk";

// =============================
// 🔐 Firebase Initialization (Base64 JSON)
// =============================
function parseServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("❌ Missing FIREBASE_SERVICE_ACCOUNT_B64");

  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

const serviceAccount = parseServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
console.log("✅ Firebase initialized successfully");

// =============================
// 🤖 LINE Bot Setup
// =============================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// =============================
// 💬 Express Setup
// =============================
const app = express();
app.use(bodyParser.json());
const PORT = process.env.PORT || 8080;

// =============================
// 🧠 Gemini API Setup
// =============================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

async function askGemini(prompt) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
    });

    const text =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "(ไม่มีคำตอบจากโมเดล)";
    return text;
  } catch (err) {
    console.error("Gemini API error:", err.response?.data || err.message);
    return "ระบบกำลังเริ่มต้น โปรดลองใหม่อีกครั้งนะครับ/ค่ะ";
  }
}

// =============================
// 🧩 Webhook for LINE
// =============================
app.post("/webhook", line.middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook error:", err);
      res.status(500).end();
    });
});

// =============================
// 🐾 Event Handler
// =============================
async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return null;

  const userMessage = event.message.text.trim();
  const userId = event.source.userId;

  // ตรวจสอบว่าเคยมีผู้ใช้ในระบบหรือไม่
  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    await userRef.set({
      createdAt: new Date(),
      name: null,
    });
    return reply(event.replyToken, [
      { type: "text", text: "สวัสดีฮับ! 🐶 น้อนน้อน ผู้ช่วยดูแลสัตว์เลี้ยงพร้อมให้บริการแล้ว!" },
      {
        type: "text",
        text: "คุณอยากเริ่มต้นด้วยการ:\n1️⃣ เพิ่มข้อมูลสัตว์เลี้ยง\n2️⃣ บันทึกสุขภาพ / วัคซีน\n3️⃣ ดูข้อมูลที่เคยบันทึกไว้\nพิมพ์หมายเลขได้เลยครับ ❤️",
      },
    ]);
  }

  // ถ้าเป็นข้อความทั่วไป ให้ส่งไปถาม Gemini
  const systemPrompt = `
คุณคือ "น้อนน้อน" ผู้ช่วยอัจฉริยะด้านสัตว์เลี้ยง
หน้าที่ของคุณคือช่วยเจ้าของสัตว์เลี้ยงในการ:
- จัดเก็บและแสดงข้อมูลสัตว์เลี้ยง เช่น ชื่อ วันเกิด เพศ สายพันธุ์ สี รูปภาพ
- จัดเก็บข้อมูลสุขภาพ เช่น วัคซีน โรค การรักษา ยา
- ตอบคำถามทั่วไปเกี่ยวกับสุขภาพ การดูแล และพฤติกรรมของสัตว์เลี้ยง
- พูดจาเป็นกันเอง อ่อนโยน และใช้คำพูดอบอุ่นแบบเพื่อนคุยกัน

หากข้อความดูเหมือน “ข้อมูลใหม่ของสัตว์เลี้ยง” เช่น “โมจิฉีดวัคซีนพิษสุนัขบ้ามาวันนี้”
ให้ตอบในรูปแบบยืนยัน เช่น “โอเคฮับ น้อนจะบันทึกให้ว่า โมจิฉีดวัคซีนพิษสุนัขบ้าวันนี้นะ”
แต่ถ้าเป็นคำถามเกี่ยวกับโรค อาหาร หรือการดูแล ให้ตอบตามความรู้ทั่วไป
`;

  const aiReply = await askGemini(`${systemPrompt}\n\nข้อความจากผู้ใช้: ${userMessage}`);

  return reply(event.replyToken, [{ type: "text", text: aiReply }]);
}

// =============================
// 📤 Reply Function
// =============================
async function reply(replyToken, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (err) {
    console.error("Reply Error:", err.originalError?.response?.data || err);
  }
}

// =============================
// 🧭 Health Check & Debug
// =============================
app.get("/", (req, res) => {
  res.send("🐾 Nonnon Pet Assistant is running!");
});

app.get("/debug/firestore", async (req, res) => {
  try {
    const testRef = await db.collection("tests").add({ timestamp: new Date() });
    res.json({ ok: true, id: testRef.id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// =============================
// 🚀 Start Server
// =============================
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
