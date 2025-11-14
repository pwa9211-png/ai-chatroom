// server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(io, { transports: ['websocket'] });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.DB_NAME || 'ai_chatroom_db';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let messagesCollection = null;

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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const roomSystemPrompt = {};   // { roomId: "你是老师..." }
const roomUsers = {};          // { roomId: Set([user1, user2]) }

io.on('connection', (socket) => {
  console.log('🟢 连接:', socket.id);

  socket.on('join', async ({ room, user }) => {
    socket.join(room);
    socket.room = room;
    socket.user = user;
    if (!roomUsers[room]) roomUsers[room] = new Set();
    roomUsers[room].add(user);
    console.log(`📥 ${user} 加入 ${room}`);

    // 历史消息
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

    // AI 回答
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ 伺服器啟動，埠號：${PORT}`));

export default app;