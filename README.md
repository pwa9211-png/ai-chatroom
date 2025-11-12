# AI 多人聊天室（進階版） - 部署說明 (Vercel & MongoDB Atlas)

這個專案是一個**中文介面**的多人即時聊天室，特色如下：
- 使用 Socket.IO 實現即時多人聊天
- 訊息會儲存到 MongoDB Atlas（雲端）
- 支援多房間（room）
- 使用者可在聊天室輸入 `/角色 角色名` 讓 AI 在該房間扮演指定角色
- 可部署到 Vercel（免費方案可用）

---

## 一、準備
1. GitHub 帳號（將此專案上傳至你的 GitHub repository）  
2. Vercel 帳號（使用 GitHub 登入）  
3. OpenAI API Key（前往 https://platform.openai.com/create-api-key 取得）  
4. MongoDB Atlas（免費方案可用）
   - 建立 Cluster → 建立 Database User（記下使用者/密碼）→ Network Access 裡允許你的應用 IP（或 0.0.0.0/0 供測試）
   - 取得連線字串（Connection String），格式類似：
     ```
     mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
     ```

---

## 二、設定環境變數（在 Vercel 介面設定）
在 Vercel 專案 Settings → Environment Variables，新增下列變數：

- `OPENAI_API_KEY` = 你的 OpenAI API Key  
- `MONGODB_URI` = 你從 MongoDB Atlas 取得的連線字串  
- （可選）`DB_NAME` = 你的資料庫名稱（預設：`ai_chatroom_db`）

---

## 三、部署步驟（快速）
1. 建立一個新的 GitHub repository，將此專案內容上傳  
2. 到 Vercel，New Project → Import Git Repository → 選擇剛才的 repo  
3. 在 Import 階段或部署後到 Settings -> Environment Variables 加入 `OPENAI_API_KEY` 與 `MONGODB_URI`  
4. Deploy（數分鐘內完成），部署成功後會拿到一個 URL，任何人即可訪問

---

## 四、使用說明
- 進入 `index.html` 頁面，輸入暱稱與房間名稱即可加入  
- 在聊天框輸入 `/角色 老師` 即可讓 AI 在該房間後續回覆中扮演「老師」角色  
- 所有訊息會同步儲存在 MongoDB 的 `messages` collection

---

## 五、注意事項
- 不要把 `OPENAI_API_KEY` 放在前端！務必透過 Vercel 的 Environment Variables 設定。  
- 若要支援大量同時使用者，建議使用付費的 OpenAI 與 MongoDB 配額，或改用更強的雲端方案。  
- 若 Vercel 在運行上有 serverless 限制（例如長連線限制），考慮改用 Render / Railway 或自架 VPS。

---

祝你部署順利！有任何問題我可以繼續協助。  
