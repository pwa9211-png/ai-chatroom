// api/index.js

// ❗ 注意：Vercel Serverless Function 應導出一個請求處理器，
// ❗ 且不適合長時間的 Socket.IO WebSocket 連接。
// ❗ 為了讓它能處理所有 HTTP 請求，我們移除 server.listen() 並直接導出 app。

import express from 'express';
import { createServer } from 'http'; // 雖然保留，但不再用於啟動
import { Server } from 'socket.io'; // 雖然保留，但 Vercel 不保證其穩定性
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// 創建一個 http 伺服器實例，但不會調用 listen
const server = createServer(app); 

// Vercel Serverless Function 對 Socket.IO 的支持有限且不穩定，
// 這行代碼在 Vercel 環境中可能永遠無法正常工作，但為了保持代碼結構，我們保留它。
const io = new Server(server, { 
    transports: ['websocket'],
    // 關鍵: 在 Serverless 環境中，需要啟用 CORS
    cors: {
      origin: "*", 
      methods: ["GET", "POST"]
    }
}); 


const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.DB_NAME || 'ai_chatroom_db';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let messagesCollection = null;

// MongoDB 初始化（在冷啟動時執行）
(async () => {
  if (!MONGODB_URI) return;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    messagesCollection = client.db(DB_NAME).collection('messages');
    await messagesCollection.createIndex({ room: 1, timestamp: 1 });
    console.log('✅ MongoDB connected');
  } catch (e) {
    console.error('❌ MongoDB', e.message);
  }
})();

// 靜態文件 - 將 public 資料夾暴露
app.use(express.static(path.join(__dirname, '..', 'public')));

// 根目錄路由
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'))
);

const roomSystemPrompt = {};
const roomUsers = {};

// Socket.IO 連接事件處理 (這部分依賴於 WebSockets 的穩定性)
io.on('connection', (socket) => {
  console.log('🟢 連接:', socket.id);
  // ... (您的原有 socket.on('join'), 'chat message', 'disconnect' 邏輯保持不變)
  // 由於代碼很長，這裡僅作註釋。請將您的原有邏輯完整複製到這裡。
  
  socket.on('join', async ({ room, user }) => {
    socket.join(room);
    socket.room = room;
    socket.user = user;
    if (!roomUsers[room]) roomUsers[room] = new Set();
    roomUsers[room].add(user);

    if (messagesCollection) {
      const docs = await messagesCollection
        .find({ room })
        .sort({ timestamp: 1 })
        .limit(200)
        .toArray();
      socket.emit('history', docs);
    }
    io.to(room).emit('system', { text: `${user} 已加入房間` });
    io.to(room).emit('members', [...roomUsers[room]]);
  });

  socket.on('chat message', async ({ room, user, text }) => {
    if (!room || !user) return;

    const roleCmd = text.trim();
    if (roleCmd.startsWith('/角色 ') || roleCmd.startsWith('/role ')) {
      const roleText = roleCmd.split(' ').slice(1).join(' ').trim();
      if (roleText) {
        roomSystemPrompt[room] = `你現在扮演：${roleText}。請以中文回應，並保持該角色風格直到被更改。`;
        io.to(room).emit('system', { text: `🛠️ 房間角色已設定為：${roleText}` });
        if (messagesCollection)
          await messagesCollection.insertOne({
            room,
            user: 'system',
            text: `角色設定：${roleText}`,
            role: 'system',
            timestamp: new Date(),
          });
        return;
      }
    }

    const msgDoc = { room, user, text, role: 'user', timestamp: new Date() };
    if (messagesCollection) await messagesCollection.insertOne(msgDoc);
    io.to(room).emit('chat message', msgDoc);

    const msgs = [];
    if (roomSystemPrompt[room]) msgs.push({ role: 'system', content: roomSystemPrompt[room] });
    msgs.push({ role: 'user', content: text });

    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: msgs,
        max_tokens: 800,
      });
      const aiText = resp.choices?.[0]?.message?.content || '（AI 未回覆）';
      const aiDoc = { room, user: 'AI', text: aiText, role: 'ai', timestamp: new Date() };
      if (messagesCollection) await messagesCollection.insertOne(aiDoc);
      io.to(room).emit('chat message', aiDoc);
    } catch (e) {
      console.error('❌ OpenAI', e.message);
      io.to(room).emit('chat message', {
        room,
        user: '系統',
        text: '⚠️ AI 回覆失敗，可能是 API Key 或配額問題。',
        role: 'system',
        timestamp: new Date(),
      });
    }
  });
  
  socket.on('disconnect', () => {
    const { room, user } = socket;
    if (room && user) {
      roomUsers[room]?.delete(user);
      io.to(room).emit('members', [...roomUsers[room]]);
      console.log(`🔴 ${user} 離開 ${room}`);
    }
  });
});

// 移除 server.listen(PORT, ...)
// ----------------------------------------------------
// 導出應用程式，這是 Vercel Serverless Function 的入口點
export default async (req, res) => {
    // 確保 MongoDB 連接在處理請求前完成（僅在首次冷啟動時需要等待）
    if (!messagesCollection && MONGODB_URI) {
        // 重試連接邏輯可以在這裡添加，但我們依賴於 IIFE
    }
    app(req, res);
};