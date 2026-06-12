# 🤖 Advanced Session OTP Bot

## ✅ Features
- ➕ Add Single Account
- 📦 Add ZIP (bulk sessions)
- 📚 Manage Stock
- 🔄 Auto Price (auto set price)
- 📊 Statistics + Top Users
- 📢 Broadcast to all users
- 👥 User Info + quick ban/add balance
- 💰 Change Balance (add/deduct)
- 🚫 Ban / Unban User
- 🏷 Discount % (toggle on/off)
- 📈 Referral Commission %
- 🔗 Support URL (change anytime)
- 💳 Payments (UPI ID + USDT Address)
- 💎 Set USDT Rate
- 💾 Backup Users (JSON file)
- ♻️ Restore Users (from JSON)
- 🔴/🟢 Bot ON/OFF toggle
- UPI + USDT deposit with screenshot
- Admin approves/rejects deposits inline

## 🚀 Setup

### Step 1: Install Node.js
```
node -v  # must be 16+
```

### Step 2: Install dependencies
```
npm install
```

### Step 3: Configure
Edit `index.js` top section:
```js
const BOT_TOKEN = 'YOUR_BOT_TOKEN';   // from @BotFather
const ADMIN_ID = 123456789;           // your Telegram ID
```

### Step 4: Run
```
npm start
```

## 📋 Admin Commands
- `/admin` - Open admin dashboard
- `/approve <user_id> <amount>` - Manual approve deposit
- `/ban <user_id>` - Ban user
- `/unban <user_id>` - Unban user
- `/addbalance <user_id> <amount>` - Add/deduct balance
- `/stats` - Quick statistics
- `/cancel` - Cancel any ongoing action

## 📦 ZIP Format
ZIP file should contain text files where each line is a session:
```
+91XXXXXXXXXX:SESSION_STRING
+91XXXXXXXXXX:SESSION_STRING:PASSWORD
SESSION_STRING_ONLY
```

## 💡 Notes
- Use `nodemon` for auto-restart in development
- Bot uses SQLite database (store.db) — no external DB needed
- All settings changeable from admin panel without restart
