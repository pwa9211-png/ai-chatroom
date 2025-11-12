import express from "express";
import http from "http";
import { Server } from "socket.io";
import { MongoClient } from "mongodb";
import OpenAI from "openai";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "ai_chatroom_db";

if (!OPENAI_API_KEY) {
  console.warn("⚠️ OPENAI_API_KEY is not set. AI replies will fail until you set it in environment variables.");
}
if (!MONGODB_URI) {
  console.warn("⚠️ MONGODB_URI is not set. Chat persistence will be disabled until you set it.");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let mongoClient = null;
let messagesCollection = null;

async function initMongo() {
  if (!MONGODB_URI) return;
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  messagesCollection = db.collection("messages");
  await messagesCollection.createIndex({ room: 1, timestamp: 1 });
  console.log("✅ 已连接到 MongoDB");
}
initMongo().catch(err => {
  console.error("MongoDB 连接失败：", err.message);
});

// 用来记录每个房间的当前“系统角色”设定（内存）
const roomSystemPrompt = {}; // { roomId: "你是老師..." }

app.use(express.static("public"));

io.on("connection", (socket) => {
  console.log("🟢 有客户端已连接:", socket.id);

  // 加入房間
  socket.on("join", async ({ room, user }) => {
    socket.join(room);
    console.log(`📥 ${user} 加入房間 ${room}`);
    // 發送歷史訊息（最近 200 條）
    if (messagesCollection) {
      try {
        const docs = await messagesCollection.find({ room }).sort({ timestamp: 1 }).limit(200).toArray();
        socket.emit("history", docs);
      } catch (err) {
        console.error("取得歷史訊息錯誤：", err.message);
      }
    }
    io.to(room).emit("system", { text: `${user} 已加入房間` });
  });

  // 處理聊天室訊息
  socket.on("chat message", async ({ room, user, text }) => {
    if (!room || !user) return;

    // 檢查是否為 /角色 指令 (支援中文與英文)
    const roleCmd = text.trim();
    if (roleCmd.startsWith("/角色 ") || roleCmd.startsWith("/role ")) {
      const parts = roleCmd.split(" ");
      parts.shift();
      const roleText = parts.join(" ").trim();
      if (roleText) {
        roomSystemPrompt[room] = `你現在扮演：${roleText}。請以中文回應，並保持該角色風格直到被更改。`;
        io.to(room).emit("system", { text: `🛠️ 房間角色已設定為：${roleText}` });
        // 存一條系統消息到DB
        if (messagesCollection) {
          try {
            await messagesCollection.insertOne({
              room,
              user: "system",
              text: `角色設定：${roleText}`,
              role: "system",
              timestamp: new Date()
            });
          } catch (err) { console.error(err); }
        }
        return;
      }
    }

    const messageDoc = {
      room,
      user,
      text,
      role: "user",
      timestamp: new Date()
    };

    // 儲存使用者訊息到 MongoDB（若有）
    if (messagesCollection) {
      try {
        await messagesCollection.insertOne(messageDoc);
      } catch (err) {
        console.error("儲存使用者訊息失敗：", err.message);
      }
    }

    // 廣播使用者訊息給房間內所有人
    io.to(room).emit("chat message", messageDoc);

    // 準備傳給 OpenAI 的 messages，若房間有系統角色則先放入 system
    const messagesForAI = [];
    if (roomSystemPrompt[room]) {
      messagesForAI.push({ role: "system", content: roomSystemPrompt[room] });
    }
    messagesForAI.push({ role: "user", content: text });

    // 呼叫 OpenAI，取得回覆並儲存與廣播
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messagesForAI,
        max_tokens: 800
      });
      const aiText = resp.choices?.[0]?.message?.content || "（AI 未回覆內容）";

      const aiDoc = {
        room,
        user: "AI",
        text: aiText,
        role: "ai",
        timestamp: new Date()
      };

      if (messagesCollection) {
        try {
          await messagesCollection.insertOne(aiDoc);
        } catch (err) { console.error("儲存AI訊息失敗：", err.message); }
      }

      io.to(room).emit("chat message", aiDoc);
    } catch (err) {
      console.error("OpenAI 呼叫失敗：", err.message || err);
      io.to(room).emit("chat message", {
        room,
        user: "系統",
        text: "⚠️ AI 回覆失敗，可能是 API Key 或配額問題。",
        role: "system",
        timestamp: new Date()
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 客戶端已斷線:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ 伺服器啟動，監聽埠號：${PORT}`);
});
