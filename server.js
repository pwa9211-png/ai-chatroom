// server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

// 兼容 ES Module 的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server);

// 环境变量
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DB_NAME = process.env.DB_NAME || 'ai_chatroom_db';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let messagesCollection = null;

// 连接 MongoDB（异步立即执行）
(async () => {
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI 未设置，消息将不会持久化');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    messagesCollection = client.db(DB_NAME).collection('messages');
    await messagesCollection.createIndex({ room: 1, timestamp: 1 });
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB 连接失败:', err.message);
  }
})();

// 静态文件托管
app.use(express.static(path.join(__dirname, 'public')));

// 根路由显式返回 index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 房间级系统提示缓存
const roomSystemPrompt = {}; // { roomId: "你是老师..." }

io.on('connection', (socket) => {
  console.log('🟢 连接:', socket.id);

  socket.on('join', async ({ room, user }) => {
    socket.join(room);
    console.log(`📥 ${user} 加入 ${room}`);

    // 发送历史消息
    if (messagesCollection) {
      const history = await messagesCollection
        .find({ room })
        .sort({ timestamp: 1 })
        .limit(200)
        .toArray();
      socket.emit('history', history);
    }

    // 广播系统消息
    io.to(room).emit('system', { text: `${user} 已加入房間` });
  });

  socket.on('chat message', async ({ room, user, text }) => {
    if (!room || !user) return;

    // 处理角色指令
    const roleCmd = text.trim();
    if (roleCmd.startsWith('/角色 ') || roleCmd.startsWith('/role ')) {
      const roleText = roleCmd.split(' ').slice(1).join(' ').trim();
      if (roleText) {
        roomSystemPrompt[room] = `你現在扮演：${roleText}。請以中文回應，並保持該角色風格直到被更改。`;
        io.to(room).emit('system', { text: `🛠️ 房間角色已設定為：${roleText}` });
        if (messagesCollection) {
          await messagesCollection.insertOne({
            room,
            user: 'system',
            text: `角色設定：${roleText}`,
            role: 'system',
            timestamp: new Date(),
          });
        }
        return;
      }
    }

    // 保存用户消息
    const msgDoc = { room, user, text, role: 'user', timestamp: new Date() };
    if (messagesCollection) await messagesCollection.insertOne(msgDoc);
    io.to(room).emit('chat message', msgDoc);

    // 构造 OpenAI 消息数组
    const msgs = [];
    if (roomSystemPrompt[room]) {
      msgs.push({ role: 'system', content: roomSystemPrompt[room] });
    }
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
    } catch (err) {
      console.error('❌ OpenAI 错误:', err.message);
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
    console.log('🔴 斷線:', socket.id);
  });
});

// Vercel 不需要监听端口，但本地开发需要
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`✅ 伺服器啟動，埠號：${PORT}`)
);

export default app;   // 导出供 Vercel 使用