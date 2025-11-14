// api/index.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
// 移除 path 和 fileURLToPath 的導入，因為不再需要它們來處理靜態文件路徑
// import path from 'path';
// import { fileURLToPath } from 'url';

// 移除路徑變數的定義
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

const app = express();
// 雖然創建了 server，但不會調用 listen
const server = createServer(app); 
// 在 Vercel 環境中，Socket.IO 需要 CORS 設置
const io = new Server(server, { 
    transports: ['websocket'],
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

// ❗ 移除處理靜態文件的代碼 (app.use(express.static(...)) 和 app.get('/'))
// ❗ 讓 Vercel 負責服務 public/index.html 和 public/chat.html

const roomSystemPrompt = {};
const roomUsers = {};

io.on('connection', (socket) => {
  console.log('🟢 連接:', socket.id);

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

// ❗ 移除 server.listen(...)
// 導出 Express 應用程式作為 Vercel Serverless Function 的入口點
export default app;