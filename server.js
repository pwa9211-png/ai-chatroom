import express from "express";
import http from "http";
import { Server } from "socket.io";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.DB_NAME || "ai_chatroom_db";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let mongoClient = null;
let messagesCollection = null;

(async () => {
  if (!MONGODB_URI) return;
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    messagesCollection = mongoClient.db(DB_NAME).collection("messages");
    await messagesCollection.createIndex({ room: 1, timestamp: 1 });
    console.log("✅ MongoDB connected");
  } catch (e) {
    console.error("❌ MongoDB", e.message);
  }
})();

// 关键：显式根路由
app.get("/", (_req, res) =>
  res.sendFile(path.join(process.cwd(), "index.html"))
);

app.use(express.static("public"));
app.use(express.json());

const roomSystemPrompt = {}; // { roomId: "你是老师..." }

io.on("connection", (socket) => {
  console.log("🟢 连接:", socket.id);

  socket.on("join", async ({ room, user }) => {
    socket.join(room);
    console.log(`📥 ${user} 加入 ${room}`);
    if (messagesCollection) {
      const docs = await messagesCollection
        .find({ room })
        .sort({ timestamp: 1 })
        .limit(200)
        .toArray();
      socket.emit("history", docs);
    }
    io.to(room).emit("system", { text: `${user} 已加入房間` });
  });

  socket.on("chat message", async ({ room, user, text }) => {
    if (!room || !user) return;

    const roleCmd = text.trim();
    if (roleCmd.startsWith("/角色 ") || roleCmd.startsWith("/role ")) {
      const roleText = roleCmd.split(" ").slice(1).join(" ").trim();
      if (roleText) {
        roomSystemPrompt[room] = `你現在扮演：${roleText}。請以中文回應，並保持該角色風格直到被更改。`;
        io.to(room).emit("system", { text: `🛠️ 房間角色已設定為：${roleText}` });
        if (messagesCollection)
          await messagesCollection.insertOne({
            room,
            user: "system",
            text: `角色設定：${roleText}`,
            role: "system",
            timestamp: new Date(),
          });
        return;
      }
    }

    const msgDoc = { room, user, text, role: "user", timestamp: new Date() };
    if (messagesCollection)
      await messagesCollection.insertOne(msgDoc);
    io.to(room).emit("chat message", msgDoc);

    // AI 回答
    const msgs = [];
    if (roomSystemPrompt[room]) msgs.push({ role: "system", content: roomSystemPrompt[room] });
    msgs.push({ role: "user", content: text });

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: msgs,
        max_tokens: 800,
      });
      const aiText = resp.choices?.[0]?.message?.content || "（AI 未回覆）";
      const aiDoc = { room, user: "AI", text: aiText, role: "ai", timestamp: new Date() };
      if (messagesCollection) await messagesCollection.insertOne(aiDoc);
      io.to(room).emit("chat message", aiDoc);
    } catch (e) {
      console.error("❌ OpenAI", e.message);
      io.to(room).emit("chat message", {
        room,
        user: "系統",
        text: "⚠️ AI 回覆失敗，可能是 API Key 或配額問題。",
        role: "system",
        timestamp: new Date(),
      });
    }
  });

  socket.on("disconnect", () => console.log("🔴 斷線:", socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ 伺服器啟動，埠號：${PORT}`));

// Force rebuild 1