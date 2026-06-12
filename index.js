// ============================================================
// ADVANCED SESSION OTP BOT - FULL FEATURED
// Features: Add Single/ZIP, Auto Price, Discount, USDT Rate,
//           Support URL, Payments, Restore Users, Unban, etc.
// ============================================================

const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ============ CONFIGURATION ============
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // <-- Apna BotFather token yahan daalo
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '6106058051');
const API_PORT = process.env.PORT || 3000;
const ADMIN_IDS = [ADMIN_ID];

// ============ DEAMON OTP API CONFIG ============
const DEAMON_API_KEY = process.env.DEAMON_API_KEY || '';
const DEAMON_API_SECRET = process.env.DEAMON_API_SECRET || '';
const DEAMON_API_BASE = 'https://api.deamonotp.com'; // Deamon OTP ka API base URL

// Deamon OTP se real OTP fetch karne ka function
async function fetchRealOTP(phone) {
  if (!DEAMON_API_KEY) {
    // API key nahi hai to random OTP (fallback)
    return { success: false, error: 'DEAMON_API_KEY not set in .env' };
  }
  try {
    const https = require('https');
    const url = `${DEAMON_API_BASE}/api/otp?phone=${encodeURIComponent(phone)}&apikey=${DEAMON_API_KEY}`;
    return await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'x-api-secret': DEAMON_API_SECRET } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch(e) {
            resolve({ success: false, error: 'Invalid API response', raw: data });
          }
        });
      }).on('error', (e) => resolve({ success: false, error: e.message }));
    });
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// Deamon OTP se balance check
async function checkDeamonBalance() {
  if (!DEAMON_API_KEY) return null;
  try {
    const https = require('https');
    const url = `${DEAMON_API_BASE}/api/balance?apikey=${DEAMON_API_KEY}`;
    return await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'x-api-secret': DEAMON_API_SECRET } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  } catch(e) { return null; }
}

// ============ DATABASE SETUP ============
const db = new sqlite3.Database('store.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    balance REAL DEFAULT 0,
    referred_by INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_banned INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE,
    phone TEXT,
    password TEXT,
    price REAL,
    status TEXT DEFAULT 'available',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    session_id TEXT,
    phone TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS otp_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    session_id TEXT,
    otp TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL,
    type TEXT,
    description TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount REAL DEFAULT 0,
    screenshot TEXT,
    method TEXT DEFAULT 'UPI',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Default settings
const defaultSettings = [
  ['bot_status', 'on'],
  ['ref_percent', '5'],
  ['auto_price', '120'],
  ['auto_price_enabled', 'off'],
  ['discount_percent', '0'],
  ['discount_enabled', 'off'],
  ['usdt_rate', '83'],
  ['support_url', 'https://t.me/support'],
  ['upi_id', 'yourshop@okhdfcbank'],
  ['usdt_address', 'YOUR_USDT_TRC20_ADDRESS'],
];
defaultSettings.forEach(([key, value]) => {
  db.run("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", [key, value]);
});

// ============ HELPER FUNCTIONS ============
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
  });
}

async function getSetting(key) {
  const row = await dbGet('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}
async function setSetting(key, value) {
  await dbRun('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime("now"))', [key, value]);
}

async function getOrCreateUser(user) {
  let existing = await dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
  if (!existing) {
    await dbRun('INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)',
      [user.id, user.username || '', user.first_name || '']);
    existing = await dbGet('SELECT * FROM users WHERE id = ?', [user.id]);
  }
  return existing;
}

async function updateBalance(userId, amount, type, description) {
  await dbRun('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
  await dbRun('INSERT INTO transactions (user_id, amount, type, description, status) VALUES (?, ?, ?, ?, ?)',
    [userId, amount, type, description, 'completed']);
}

async function getStats() {
  return dbGet(`SELECT 
    (SELECT COUNT(*) FROM users) as total_users,
    (SELECT COUNT(*) FROM sessions WHERE status = 'sold') as sessions_sold,
    (SELECT COUNT(*) FROM sessions WHERE status = 'available') as available,
    (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type IN ('purchase','admin') AND amount > 0) as revenue,
    (SELECT COUNT(*) FROM deposits WHERE status = 'pending') as pending_deposits,
    (SELECT COALESCE(SUM(balance),0) FROM users) as total_wallet
  `);
}

async function getSessionPrice() {
  const autoEnabled = await getSetting('auto_price_enabled');
  if (autoEnabled === 'on') return parseFloat(await getSetting('auto_price'));
  const row = await dbGet('SELECT price FROM sessions WHERE status = "available" LIMIT 1');
  return row ? row.price : parseFloat(await getSetting('auto_price'));
}

async function purchaseSession(userId) {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        const session = await dbGet('SELECT * FROM sessions WHERE status = "available" ORDER BY created_at ASC LIMIT 1');
        if (!session) return reject(new Error('No sessions available'));

        const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) return reject(new Error('User not found'));

        let price = session.price;
        const discountEnabled = await getSetting('discount_enabled');
        if (discountEnabled === 'on') {
          const dp = parseFloat(await getSetting('discount_percent'));
          price = price - (price * dp / 100);
        }

        if (user.balance < price) return reject(new Error(`Insufficient balance! Need ₹${price.toFixed(2)}, have ₹${user.balance.toFixed(2)}`));

        await dbRun('UPDATE sessions SET status = "sold" WHERE id = ?', [session.id]);
        await dbRun('UPDATE users SET balance = balance - ? WHERE id = ?', [price, userId]);
        await dbRun('INSERT INTO transactions (user_id, amount, type, description, status) VALUES (?, ?, ?, ?, ?)',
          [userId, -price, 'purchase', `Purchased session ${session.session_id}`, 'completed']);
        await dbRun('INSERT OR IGNORE INTO user_sessions (user_id, session_id, phone) VALUES (?, ?, ?)',
          [userId, session.session_id, session.phone]);
        await dbRun('UPDATE users SET session_id = ? WHERE id = ?', [session.session_id, userId]);

        // Referral reward
        if (user.referred_by) {
          const refPercent = parseFloat(await getSetting('ref_percent'));
          const reward = price * refPercent / 100;
          await updateBalance(user.referred_by, reward, 'referral', `Referral reward from user ${userId}`);
          try { await bot.telegram.sendMessage(user.referred_by, `🎉 Referral reward: ₹${reward.toFixed(2)} added!`); } catch(e) {}
        }

        resolve({ ...session, price });
      } catch(e) { reject(e); }
    });
  });
}

// ============ BOT SETUP ============
const bot = new Telegraf(BOT_TOKEN);
let userStates = {}; // holds multi-step states for both admin and users

// ============ MIDDLEWARE ============
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return;
  const status = await getSetting('bot_status');
  if (status === 'off' && !ADMIN_IDS.includes(ctx.from.id)) {
    return ctx.reply('🔴 Bot is currently offline for maintenance. Please wait...');
  }
  await getOrCreateUser(ctx.from);
  const user = await dbGet('SELECT is_banned FROM users WHERE id = ?', [ctx.from.id]);
  if (user?.is_banned && !ADMIN_IDS.includes(ctx.from.id)) {
    return ctx.reply('🚫 You are banned from using this bot.');
  }
  return next();
});

// ============ /cancel command ============
bot.command('cancel', async (ctx) => {
  delete userStates[ctx.from.id];
  await ctx.reply('❌ Action cancelled.', Markup.keyboard([
    ['🛒 Buy Session', '📱 My Session'],
    ['🔑 Get OTP', '👤 My Profile'],
    ['💰 Deposit', '❓ Support']
  ]).resize());
});

// ============ /start ============
bot.start(async (ctx) => {
  const args = ctx.message.text.split(' ');
  const refCode = args[1];
  const user = await getOrCreateUser(ctx.from);

  // Handle referral
  if (refCode && refCode !== String(ctx.from.id)) {
    const referrer = await dbGet('SELECT id FROM users WHERE id = ?', [parseInt(refCode)]);
    if (referrer && !user.referred_by) {
      await dbRun('UPDATE users SET referred_by = ? WHERE id = ?', [referrer.id, ctx.from.id]);
    }
  }

  const balance = user.balance || 0;
  const sessionRow = await dbGet('SELECT session_id FROM users WHERE id = ?', [ctx.from.id]);
  const hasSession = sessionRow?.session_id;
  const stock = await dbGet('SELECT COUNT(*) as c FROM sessions WHERE status = "available"');
  const price = await getSessionPrice();
  const upiId = await getSetting('upi_id');

  await ctx.reply(
`🤖 *Welcome to Session OTP Bot!*

👋 Hello, ${ctx.from.first_name}!

💰 Balance: ₹${parseFloat(balance).toFixed(2)}
🔑 Session: ${hasSession ? '✅ Active' : '❌ None'}
📦 Stock: ${stock?.c || 0} sessions
💵 Price: ₹${price}

🏦 UPI: \`${upiId}\`

Use buttons below 👇`,
    { parse_mode: 'Markdown', ...Markup.keyboard([
      ['🛒 Buy Session', '📱 My Session'],
      ['🔑 Get OTP', '👤 My Profile'],
      ['💰 Deposit', '❓ Support']
    ]).resize() }
  );
});

// ============ USER: BUY SESSION ============
bot.hears('🛒 Buy Session', async (ctx) => {
  const stock = await dbGet('SELECT COUNT(*) as c FROM sessions WHERE status = "available"');
  if (!stock || stock.c === 0) return ctx.reply('❌ No sessions available right now. Please wait for restock.');

  const price = await getSessionPrice();
  const discountEnabled = await getSetting('discount_enabled');
  const dp = parseFloat(await getSetting('discount_percent'));
  const finalPrice = discountEnabled === 'on' ? price - (price * dp / 100) : price;

  let msg = `🛒 *Buy Session*\n\n📦 Available: ${stock.c}\n💵 Price: ₹${finalPrice.toFixed(2)}`;
  if (discountEnabled === 'on') msg += `\n🏷️ Discount: ${dp}% OFF`;

  await ctx.reply(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Buy Now', 'confirm_buy')],
      [Markup.button.callback('❌ Cancel', 'cancel_buy')]
    ])
  });
});

bot.action('confirm_buy', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    const session = await purchaseSession(ctx.from.id);
    await ctx.reply(
`✅ *Purchase Successful!*

🔑 Session ID: \`${session.session_id}\`
📱 Phone: \`${session.phone}\`
${session.password ? `🔐 Password: \`${session.password}\`` : ''}
💵 Paid: ₹${parseFloat(session.price).toFixed(2)}

Now press *🔑 Get OTP* to get login code!`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply(`❌ Failed: ${e.message}`);
  }
});

bot.action('cancel_buy', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('❌ Cancelled.');
});

// ============ USER: GET OTP ============
bot.hears('🔑 Get OTP', async (ctx) => {
  const userRow = await dbGet('SELECT session_id FROM users WHERE id = ?', [ctx.from.id]);
  if (!userRow?.session_id) return ctx.reply('❌ You have no active session. Buy one first!');

  const sessRow = await dbGet('SELECT phone FROM user_sessions WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [ctx.from.id]);
  if (!sessRow) return ctx.reply('❌ Session details not found. Contact support.');

  await ctx.reply(`⏳ Fetching OTP for \`${sessRow.phone}\`...\n\nPlease wait...`, { parse_mode: 'Markdown' });

  // Deamon OTP API se real OTP fetch karo
  const apiResult = await fetchRealOTP(sessRow.phone);

  if (apiResult && apiResult.success && apiResult.otp) {
    const otp = apiResult.otp;
    await dbRun('INSERT INTO otp_requests (user_id, session_id, otp, status) VALUES (?, ?, ?, ?)',
      [ctx.from.id, userRow.session_id, otp, 'delivered']);
    await ctx.reply(
`✅ *OTP Received!*

📱 Phone: \`${sessRow.phone}\`
🔑 OTP: \`${otp}\`

⚠️ Valid for 5 minutes only!`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const errMsg = apiResult?.error || 'API connection failed';
    console.log('Deamon OTP API Error:', errMsg, JSON.stringify(apiResult));
    if (!DEAMON_API_KEY) {
      await ctx.reply('⚠️ *OTP API Not Configured!*\n\nAdmin se contact karein - DEAMON_API_KEY set nahi hai .env mein.', { parse_mode: 'Markdown' });
    } else {
      await ctx.reply(
`❌ *OTP Fetch Failed!*

📱 Phone: \`${sessRow.phone}\`
❗ Error: ${errMsg}

Dobara try karein ya support se contact karein.`,
        { parse_mode: 'Markdown' }
      );
    }
  }
});

// ============ USER: MY SESSION ============
bot.hears('📱 My Session', async (ctx) => {
  const userRow = await dbGet('SELECT * FROM users WHERE id = ?', [ctx.from.id]);
  if (!userRow?.session_id) return ctx.reply('❌ No active session. Use 🛒 Buy Session.');
  const sess = await dbGet('SELECT * FROM user_sessions WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [ctx.from.id]);
  await ctx.reply(
`📱 *Your Session*

🔑 ID: \`${userRow.session_id}\`
📞 Phone: \`${sess?.phone || 'N/A'}\`
📅 Since: ${sess?.created_at || 'N/A'}

Press *🔑 Get OTP* to get login code.`,
    { parse_mode: 'Markdown' }
  );
});

// ============ USER: MY PROFILE ============
bot.hears('👤 My Profile', async (ctx) => {
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [ctx.from.id]);
  const txCount = await dbGet('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?', [ctx.from.id]);
  const sessCount = await dbGet('SELECT COUNT(*) as c FROM user_sessions WHERE user_id = ?', [ctx.from.id]);
  const refLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=${ctx.from.id}`;
  await ctx.reply(
`👤 *Your Profile*

🆔 ID: \`${user.id}\`
👤 Name: ${user.first_name}
💰 Balance: ₹${parseFloat(user.balance).toFixed(2)}
🔑 Sessions: ${sessCount?.c || 0}
📝 Transactions: ${txCount?.c || 0}
🔗 Ref Link: \`${refLink}\``,
    { parse_mode: 'Markdown' }
  );
});

// ============ USER: DEPOSIT ============
bot.hears('💰 Deposit', async (ctx) => {
  const upiId = await getSetting('upi_id');
  const usdtAddr = await getSetting('usdt_address');
  const usdtRate = await getSetting('usdt_rate');
  await ctx.reply(
`💰 *Add Funds*

Choose payment method:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🏦 UPI / Bank', 'deposit_upi')],
        [Markup.button.callback('💎 USDT (Crypto)', 'deposit_usdt')]
      ])
    }
  );
});

bot.action('deposit_upi', async (ctx) => {
  await ctx.answerCbQuery();
  const upiId = await getSetting('upi_id');
  userStates[ctx.from.id] = { step: 'deposit_upi_screenshot' };
  await ctx.reply(
`🏦 *UPI Deposit*

Send payment to:
🆔 UPI ID: \`${upiId}\`

Minimum: ₹50

After payment, send screenshot here 👇`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('deposit_usdt', async (ctx) => {
  await ctx.answerCbQuery();
  const addr = await getSetting('usdt_address');
  const rate = await getSetting('usdt_rate');
  userStates[ctx.from.id] = { step: 'deposit_usdt_screenshot' };
  await ctx.reply(
`💎 *USDT Deposit (TRC20)*

Address: \`${addr}\`
Rate: 1 USDT = ₹${rate}

After sending, send transaction screenshot here 👇`,
    { parse_mode: 'Markdown' }
  );
});

// ============ USER: SUPPORT ============
bot.hears('❓ Support', async (ctx) => {
  const supportUrl = await getSetting('support_url');
  await ctx.reply(
`❓ *Support*

Need help? Contact us!

👨‍💻 Response: within 6-12 hours`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.url('📞 Contact Support', supportUrl)]
      ])
    }
  );
});

// ============ ADMIN: /admin command ============
bot.command('admin', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply('❌ Unauthorized!');
  await showAdminPanel(ctx);
});

bot.hears('🎛 Admin Panel', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  await showAdminPanel(ctx);
});

async function showAdminPanel(ctx) {
  const stats = await getStats();
  const botStatus = await getSetting('bot_status');
  await ctx.reply(
`🖥 *ADVANCED ADMIN DASHBOARD*

Status: ${botStatus === 'on' ? '🟢 Bot is ON' : '🔴 Bot is OFF'}

👥 Users: ${stats.total_users}
📦 Sold: ${stats.sessions_sold}
📦 Available: ${stats.available}
💰 Revenue: ₹${parseFloat(stats.revenue).toFixed(2)}
💸 Pending Deposits: ${stats.pending_deposits}
💼 Total Wallets: ₹${parseFloat(stats.total_wallet).toFixed(2)}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Single Acc', 'a_add_single'), Markup.button.callback('📦 Add ZIP', 'a_add_zip')],
        [Markup.button.callback('📚 Manage Stock', 'a_manage_stock'), Markup.button.callback('🔄 Auto Price', 'a_auto_price')],
        [Markup.button.callback('📊 Statistics', 'a_stats'), Markup.button.callback('📢 Broadcast', 'a_broadcast'), Markup.button.callback('👥 User Info', 'a_user_info')],
        [Markup.button.callback('💰 Change Balance', 'a_change_balance'), Markup.button.callback('🚫 Ban User', 'a_ban_user')],
        [Markup.button.callback('🏷 Discount', 'a_discount'), Markup.button.callback('📈 Ref %', 'a_ref_percent')],
        [Markup.button.callback('🔗 Support URL', 'a_support_url'), Markup.button.callback('💳 Payments', 'a_payments')],
        [Markup.button.callback('💎 Set USDT Rate', 'a_usdt_rate')],
        [Markup.button.callback('💾 Backup Users', 'a_backup'), Markup.button.callback('♻️ Restore Users', 'a_restore')],
        [Markup.button.callback(botStatus === 'on' ? '🔴 Turn OFF Bot' : '🟢 Turn ON Bot', 'a_toggle_bot')]
      ])
    }
  );
}

// ======== ADMIN ACTIONS ========

// Add Single Account
bot.action('a_add_single', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_add_session_id' };
  await ctx.reply('➕ *Add Single Account*\n\nStep 1: Enter Session ID (string)\nExample: `1BQANOTEuc...`\n\nType /cancel to abort', { parse_mode: 'Markdown' });
});

// Add ZIP
bot.action('a_add_zip', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_zip_price', data: {} };
  await ctx.reply('📦 *Add ZIP File*\n\nStep 1: Enter price for all sessions in ZIP:\nExample: `120`\n\nType /cancel to abort', { parse_mode: 'Markdown' });
});

// Manage Stock
bot.action('a_manage_stock', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const sessions = await dbAll('SELECT * FROM sessions ORDER BY status ASC, created_at DESC LIMIT 30');
  if (sessions.length === 0) return ctx.reply('📭 No sessions in database.');
  let msg = '📚 *Sessions (latest 30)*\n\n';
  sessions.forEach(s => {
    msg += `#${s.id} | ${s.status === 'available' ? '🟢' : '🔴'} | \`${s.session_id?.substring(0,15)}...\` | ₹${s.price}\n`;
  });
  userStates[ctx.from.id] = { step: 'admin_delete_session' };
  await ctx.reply(msg, { parse_mode: 'Markdown' });
  await ctx.reply('Enter session *#ID* to delete, or type `cancel`:', { parse_mode: 'Markdown' });
});

// Auto Price
bot.action('a_auto_price', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const current = await getSetting('auto_price');
  const enabled = await getSetting('auto_price_enabled');
  userStates[ctx.from.id] = { step: 'admin_auto_price' };
  await ctx.reply(
`🔄 *Auto Price*

Current Price: ₹${current}
Status: ${enabled === 'on' ? '✅ ON' : '❌ OFF'}

Send new price or type \`toggle\` to toggle ON/OFF:`,
    { parse_mode: 'Markdown' }
  );
});

// Statistics
bot.action('a_stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const stats = await getStats();
  const topUsers = await dbAll('SELECT id, first_name, balance FROM users ORDER BY balance DESC LIMIT 5');
  let topMsg = topUsers.map((u, i) => `${i+1}. ${u.first_name} (${u.id}) - ₹${parseFloat(u.balance).toFixed(2)}`).join('\n');
  await ctx.reply(
`📊 *Full Statistics*

👥 Total Users: ${stats.total_users}
📦 Sessions Sold: ${stats.sessions_sold}
📦 Available: ${stats.available}
💰 Revenue: ₹${parseFloat(stats.revenue).toFixed(2)}
💸 Pending Deposits: ${stats.pending_deposits}
💼 Total Wallet Balance: ₹${parseFloat(stats.total_wallet).toFixed(2)}

🏆 *Top Balances:*
${topMsg}`,
    { parse_mode: 'Markdown' }
  );
});

// Broadcast
bot.action('a_broadcast', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_broadcast' };
  await ctx.reply('📢 *Broadcast*\n\nSend your message (supports Markdown).\n\nType /cancel to abort:', { parse_mode: 'Markdown' });
});

// User Info
bot.action('a_user_info', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_user_info' };
  await ctx.reply('👥 Enter User ID to view info:');
});

// Change Balance
bot.action('a_change_balance', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_bal_userid' };
  await ctx.reply('💰 *Change Balance*\n\nEnter User ID:\n(Type /cancel to abort)', { parse_mode: 'Markdown' });
});

// Ban User
bot.action('a_ban_user', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_ban' };
  await ctx.reply('🚫 *Ban/Unban User*\n\nEnter User ID:\n(User will be banned if active, or unbanned if already banned)', { parse_mode: 'Markdown' });
});

// Discount
bot.action('a_discount', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const dp = await getSetting('discount_percent');
  const enabled = await getSetting('discount_enabled');
  userStates[ctx.from.id] = { step: 'admin_discount' };
  await ctx.reply(
`🏷 *Discount Settings*

Current: ${dp}%
Status: ${enabled === 'on' ? '✅ ON' : '❌ OFF'}

Send discount % (e.g. 10) or type \`toggle\`:`,
    { parse_mode: 'Markdown' }
  );
});

// Ref Percent
bot.action('a_ref_percent', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const rp = await getSetting('ref_percent');
  userStates[ctx.from.id] = { step: 'admin_ref_percent' };
  await ctx.reply(`📈 *Referral Commission*\n\nCurrent: ${rp}%\n\nEnter new percentage:`, { parse_mode: 'Markdown' });
});

// Support URL
bot.action('a_support_url', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const url = await getSetting('support_url');
  userStates[ctx.from.id] = { step: 'admin_support_url' };
  await ctx.reply(`🔗 *Support URL*\n\nCurrent: ${url}\n\nEnter new support URL:`, { parse_mode: 'Markdown' });
});

// Payments
bot.action('a_payments', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const upi = await getSetting('upi_id');
  const usdt = await getSetting('usdt_address');
  const rate = await getSetting('usdt_rate');
  userStates[ctx.from.id] = { step: 'admin_payments' };
  await ctx.reply(
`💳 *Payment Settings*

🏦 UPI ID: \`${upi}\`
💎 USDT (TRC20): \`${usdt}\`
📈 USDT Rate: ₹${rate}

What to change?
Reply: \`upi <new_upi>\` 
or \`usdt <address>\``,
    { parse_mode: 'Markdown' }
  );
});

// USDT Rate
bot.action('a_usdt_rate', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const rate = await getSetting('usdt_rate');
  userStates[ctx.from.id] = { step: 'admin_usdt_rate' };
  await ctx.reply(`💎 *USDT Rate*\n\nCurrent: 1 USDT = ₹${rate}\n\nEnter new rate:`, { parse_mode: 'Markdown' });
});

// Backup Users
bot.action('a_backup', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const users = await dbAll('SELECT * FROM users');
  const sessions = await dbAll('SELECT * FROM sessions');
  const backupData = JSON.stringify({ users, sessions, timestamp: new Date().toISOString() }, null, 2);
  const filePath = '/tmp/backup_' + Date.now() + '.json';
  fs.writeFileSync(filePath, backupData);
  await ctx.replyWithDocument({ source: filePath, filename: 'backup.json' });
  await ctx.reply(`✅ Backup complete!\n👥 Users: ${users.length}\n📦 Sessions: ${sessions.length}`);
  fs.unlinkSync(filePath);
});

// Restore Users
bot.action('a_restore', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  userStates[ctx.from.id] = { step: 'admin_restore' };
  await ctx.reply('♻️ *Restore Users*\n\nSend the backup JSON file to restore:\n\n⚠️ This will merge data with existing database.', { parse_mode: 'Markdown' });
});

// Toggle Bot
bot.action('a_toggle_bot', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const current = await getSetting('bot_status');
  const newStatus = current === 'on' ? 'off' : 'on';
  await setSetting('bot_status', newStatus);
  await ctx.reply(`${newStatus === 'on' ? '🟢 Bot is now ONLINE' : '🔴 Bot is now OFFLINE'}`);
});

// ======== ADMIN PENDING DEPOSITS ========
bot.action(/^approve_dep_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const depId = parseInt(ctx.match[1]);
  userStates[ctx.from.id] = { step: 'admin_approve_dep', depId };
  await ctx.reply(`Enter amount to approve for deposit #${depId}:`);
});

bot.action(/^reject_dep_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const depId = parseInt(ctx.match[1]);
  const dep = await dbGet('SELECT * FROM deposits WHERE id = ?', [depId]);
  if (!dep) return ctx.reply('Not found.');
  await dbRun('UPDATE deposits SET status = "rejected" WHERE id = ?', [depId]);
  await ctx.reply(`❌ Deposit #${depId} rejected.`);
  try { await bot.telegram.sendMessage(dep.user_id, `❌ Your deposit request was rejected. Contact support if needed.`); } catch(e) {}
});

// ======== PHOTO HANDLER (Deposit Screenshot) ========
bot.on('photo', async (ctx) => {
  const state = userStates[ctx.from.id];
  if (!state) return;

  if (state.step === 'deposit_upi_screenshot' || state.step === 'deposit_usdt_screenshot') {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const method = state.step === 'deposit_upi_screenshot' ? 'UPI' : 'USDT';
    const depResult = await dbRun('INSERT INTO deposits (user_id, screenshot, method, status) VALUES (?, ?, ?, ?)',
      [ctx.from.id, photo.file_id, method, 'pending']);
    delete userStates[ctx.from.id];
    await ctx.reply(`✅ Deposit request submitted!\n\nMethod: ${method}\nAdmin will verify and credit your balance.`);

    for (const adminId of ADMIN_IDS) {
      try {
        await ctx.telegram.sendPhoto(adminId, photo.file_id, {
          caption: `💰 *New ${method} Deposit Request*\n\nUser: ${ctx.from.first_name} (ID: \`${ctx.from.id}\`)\nDeposit ID: #${depResult.lastID}`,
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`✅ Approve #${depResult.lastID}`, `approve_dep_${depResult.lastID}`),
             Markup.button.callback(`❌ Reject #${depResult.lastID}`, `reject_dep_${depResult.lastID}`)]
          ])
        });
      } catch(e) {}
    }
  }

  if (state.step === 'admin_restore') {
    // ignore photo for restore, need document
  }
});

// ======== DOCUMENT HANDLER (ZIP + Restore) ========
bot.on('document', async (ctx) => {
  const state = userStates[ctx.from.id];
  if (!state || !ADMIN_IDS.includes(ctx.from.id)) return;

  if (state.step === 'admin_zip_upload') {
    const price = state.data?.price || parseFloat(await getSetting('auto_price'));
    const doc = ctx.message.document;
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    await ctx.reply('⏳ Downloading and processing ZIP...');
    try {
      const https = require('https');
      const http = require('http');
      const zipPath = '/tmp/sessions_' + Date.now() + '.zip';
      const file = fs.createWriteStream(zipPath);
      const protocol = fileLink.href.startsWith('https') ? https : http;
      await new Promise((resolve, reject) => {
        protocol.get(fileLink.href, res => { res.pipe(file); file.on('finish', resolve); }).on('error', reject);
      });
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();
      let added = 0, skipped = 0;
      for (const entry of entries) {
        if (!entry.isDirectory) {
          const content = zip.readAsText(entry);
          const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            let sessionId, phone = 'N/A', password = null;
            if (line.includes(':')) {
              const parts = line.split(':');
              phone = parts[0];
              if (parts.length === 3) { sessionId = parts[1]; password = parts[2]; }
              else if (parts.length === 2) { sessionId = parts[1]; }
              else { sessionId = line; }
            } else {
              sessionId = line;
            }
            if (!sessionId || sessionId.length < 3) continue;
            try {
              await dbRun('INSERT OR IGNORE INTO sessions (session_id, phone, password, price) VALUES (?, ?, ?, ?)',
                [sessionId, phone, password, price]);
              added++;
            } catch(e) { skipped++; }
          }
        }
      }
      fs.unlinkSync(zipPath);
      delete userStates[ctx.from.id];
      await ctx.reply(`✅ ZIP processed!\n✅ Added: ${added}\n⚠️ Skipped (duplicates): ${skipped}\n💵 Price: ₹${price}`);
    } catch(e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  }

  if (state.step === 'admin_restore') {
    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
      const https = require('https');
      const http = require('http');
      let data = '';
      await new Promise((resolve, reject) => {
        const protocol = fileLink.href.startsWith('https') ? https : http;
        protocol.get(fileLink.href, res => {
          res.on('data', chunk => data += chunk);
          res.on('end', resolve);
        }).on('error', reject);
      });
      const backup = JSON.parse(data);
      let restored = 0;
      for (const user of backup.users || []) {
        try {
          await dbRun(`INSERT OR IGNORE INTO users (id, username, first_name, balance, referred_by, created_at, is_banned) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [user.id, user.username, user.first_name, user.balance, user.referred_by, user.created_at, user.is_banned]);
          restored++;
        } catch(e) {}
      }
      delete userStates[ctx.from.id];
      await ctx.reply(`✅ Restore complete!\n👥 Restored: ${restored} users`);
    } catch(e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  }
});

// ======== TEXT MESSAGE HANDLER (All multi-step flows) ========
bot.on('text', async (ctx) => {
  const state = userStates[ctx.from.id];
  if (!state) return;
  const text = ctx.message.text.trim();

  // ---- ADD SINGLE SESSION ----
  if (state.step === 'admin_add_session_id') {
    state.data = { session_id: text };
    state.step = 'admin_add_phone';
    return ctx.reply('Step 2: Enter phone number (e.g. +919876543210):');
  }
  if (state.step === 'admin_add_phone') {
    state.data.phone = text;
    state.step = 'admin_add_password';
    return ctx.reply('Step 3: Enter password (or type `none`):',{ parse_mode: 'Markdown' });
  }
  if (state.step === 'admin_add_password') {
    state.data.password = text === 'none' ? null : text;
    state.step = 'admin_add_price';
    return ctx.reply('Step 4: Enter price (₹):');
  }
  if (state.step === 'admin_add_price') {
    const price = parseFloat(text);
    if (isNaN(price)) return ctx.reply('❌ Invalid price!');
    try {
      await dbRun('INSERT INTO sessions (session_id, phone, password, price) VALUES (?, ?, ?, ?)',
        [state.data.session_id, state.data.phone, state.data.password, price]);
      delete userStates[ctx.from.id];
      await ctx.reply(`✅ Session added!\n🔑 ID: ${state.data.session_id}\n📱 Phone: ${state.data.phone}\n💵 Price: ₹${price}`);
    } catch(e) {
      if (e.message.includes('UNIQUE')) ctx.reply('❌ Session ID already exists!');
      else ctx.reply(`❌ Error: ${e.message}`);
      delete userStates[ctx.from.id];
    }
    return;
  }

  // ---- ZIP PRICE ----
  if (state.step === 'admin_zip_price') {
    const price = parseFloat(text);
    if (isNaN(price)) return ctx.reply('❌ Invalid price!');
    state.data.price = price;
    state.step = 'admin_zip_upload';
    return ctx.reply(`💵 Price set: ₹${price}\n\nNow send the ZIP file containing session files.`);
  }

  // ---- DELETE SESSION ----
  if (state.step === 'admin_delete_session') {
    if (text.toLowerCase() === 'cancel') { delete userStates[ctx.from.id]; return ctx.reply('Cancelled.'); }
    const id = parseInt(text);
    if (isNaN(id)) return ctx.reply('❌ Invalid ID!');
    const result = await dbRun('DELETE FROM sessions WHERE id = ? AND status = "available"', [id]);
    delete userStates[ctx.from.id];
    return ctx.reply(result.changes > 0 ? `✅ Session #${id} deleted.` : `❌ Not found or already sold.`);
  }

  // ---- AUTO PRICE ----
  if (state.step === 'admin_auto_price') {
    if (text.toLowerCase() === 'toggle') {
      const cur = await getSetting('auto_price_enabled');
      await setSetting('auto_price_enabled', cur === 'on' ? 'off' : 'on');
      delete userStates[ctx.from.id];
      return ctx.reply(`✅ Auto Price: ${cur === 'on' ? '❌ OFF' : '✅ ON'}`);
    }
    const price = parseFloat(text);
    if (isNaN(price)) return ctx.reply('❌ Invalid price!');
    await setSetting('auto_price', text);
    await setSetting('auto_price_enabled', 'on');
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ Auto Price set to ₹${price} and ENABLED.`);
  }

  // ---- BROADCAST ----
  if (state.step === 'admin_broadcast') {
    const users = await dbAll('SELECT id FROM users');
    let sent = 0, failed = 0;
    await ctx.reply(`📢 Broadcasting to ${users.length} users...`);
    for (const u of users) {
      try { await bot.telegram.sendMessage(u.id, text, { parse_mode: 'Markdown' }); sent++; }
      catch(e) { failed++; }
      await new Promise(r => setTimeout(r, 50));
    }
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
  }

  // ---- USER INFO ----
  if (state.step === 'admin_user_info') {
    const uid = parseInt(text);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [uid]);
    delete userStates[ctx.from.id];
    if (!user) return ctx.reply('❌ User not found.');
    const txCount = await dbGet('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?', [uid]);
    const sessCount = await dbGet('SELECT COUNT(*) as c FROM user_sessions WHERE user_id = ?', [uid]);
    return ctx.reply(
`👤 *User Info*

🆔 ID: \`${user.id}\`
👤 Name: ${user.first_name}
🔖 Username: @${user.username || 'N/A'}
💰 Balance: ₹${parseFloat(user.balance).toFixed(2)}
📦 Sessions bought: ${sessCount?.c || 0}
📝 Transactions: ${txCount?.c || 0}
🚫 Banned: ${user.is_banned ? 'Yes' : 'No'}
📅 Joined: ${user.created_at}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`💰 Add Balance`, `qbal_add_${uid}`), Markup.button.callback(`🚫 Ban/Unban`, `qban_${uid}`)]
        ])
      }
    );
  }

  // ---- CHANGE BALANCE: user id ----
  if (state.step === 'admin_bal_userid') {
    const uid = parseInt(text);
    const user = await dbGet('SELECT id, first_name, balance FROM users WHERE id = ?', [uid]);
    if (!user) return ctx.reply('❌ User not found.');
    state.step = 'admin_bal_amount';
    state.data = { userId: uid, name: user.first_name };
    return ctx.reply(`💰 User: ${user.first_name} (${uid})\nBalance: ₹${parseFloat(user.balance).toFixed(2)}\n\n💵 Amount (Negative to deduct):\n(Type /cancel to abort)`);
  }
  if (state.step === 'admin_bal_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount)) return ctx.reply('❌ Invalid amount!');
    await updateBalance(state.data.userId, amount, 'admin', `Admin ${amount > 0 ? 'added' : 'deducted'} ₹${Math.abs(amount)}`);
    delete userStates[ctx.from.id];
    await ctx.reply(`✅ ${amount > 0 ? 'Added' : 'Deducted'} ₹${Math.abs(amount)} ${amount > 0 ? 'to' : 'from'} ${state.data.name} (${state.data.userId})`);
    try { await bot.telegram.sendMessage(state.data.userId, `${amount > 0 ? '✅' : '⚠️'} Your balance has been ${amount > 0 ? 'credited' : 'debited'} by ₹${Math.abs(amount)}.`); } catch(e) {}
    return;
  }

  // ---- BAN/UNBAN ----
  if (state.step === 'admin_ban') {
    const uid = parseInt(text);
    const user = await dbGet('SELECT id, first_name, is_banned FROM users WHERE id = ?', [uid]);
    if (!user) { delete userStates[ctx.from.id]; return ctx.reply('❌ User not found.'); }
    const newBan = user.is_banned ? 0 : 1;
    await dbRun('UPDATE users SET is_banned = ? WHERE id = ?', [newBan, uid]);
    delete userStates[ctx.from.id];
    const action = newBan ? '🚫 Banned' : '✅ Unbanned';
    await ctx.reply(`${action}: ${user.first_name} (${uid})`);
    try { await bot.telegram.sendMessage(uid, newBan ? '🚫 You have been banned.' : '✅ You have been unbanned.'); } catch(e) {}
    return;
  }

  // ---- DISCOUNT ----
  if (state.step === 'admin_discount') {
    if (text.toLowerCase() === 'toggle') {
      const cur = await getSetting('discount_enabled');
      await setSetting('discount_enabled', cur === 'on' ? 'off' : 'on');
      delete userStates[ctx.from.id];
      return ctx.reply(`✅ Discount: ${cur === 'on' ? '❌ OFF' : '✅ ON'}`);
    }
    const dp = parseFloat(text);
    if (isNaN(dp) || dp < 0 || dp > 100) return ctx.reply('❌ Invalid percentage!');
    await setSetting('discount_percent', text);
    await setSetting('discount_enabled', 'on');
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ Discount set to ${dp}% and ENABLED.`);
  }

  // ---- REF PERCENT ----
  if (state.step === 'admin_ref_percent') {
    const rp = parseFloat(text);
    if (isNaN(rp)) return ctx.reply('❌ Invalid!');
    await setSetting('ref_percent', text);
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ Referral commission set to ${rp}%`);
  }

  // ---- SUPPORT URL ----
  if (state.step === 'admin_support_url') {
    await setSetting('support_url', text);
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ Support URL updated to: ${text}`);
  }

  // ---- PAYMENTS ----
  if (state.step === 'admin_payments') {
    const parts = text.split(' ');
    if (parts[0] === 'upi' && parts[1]) {
      await setSetting('upi_id', parts[1]);
      delete userStates[ctx.from.id];
      return ctx.reply(`✅ UPI ID updated: ${parts[1]}`);
    } else if (parts[0] === 'usdt' && parts[1]) {
      await setSetting('usdt_address', parts[1]);
      delete userStates[ctx.from.id];
      return ctx.reply(`✅ USDT Address updated.`);
    }
    return ctx.reply('❌ Format: `upi <id>` or `usdt <address>`', { parse_mode: 'Markdown' });
  }

  // ---- USDT RATE ----
  if (state.step === 'admin_usdt_rate') {
    const rate = parseFloat(text);
    if (isNaN(rate)) return ctx.reply('❌ Invalid rate!');
    await setSetting('usdt_rate', text);
    delete userStates[ctx.from.id];
    return ctx.reply(`✅ USDT Rate: 1 USDT = ₹${rate}`);
  }

  // ---- APPROVE DEPOSIT ----
  if (state.step === 'admin_approve_dep') {
    const amount = parseFloat(text);
    if (isNaN(amount)) return ctx.reply('❌ Invalid amount!');
    const dep = await dbGet('SELECT * FROM deposits WHERE id = ?', [state.depId]);
    if (!dep) { delete userStates[ctx.from.id]; return ctx.reply('❌ Not found.'); }
    await dbRun('UPDATE deposits SET status = "approved", amount = ? WHERE id = ?', [amount, dep.id]);
    await updateBalance(dep.user_id, amount, 'deposit', `Deposit ₹${amount} approved`);
    delete userStates[ctx.from.id];
    await ctx.reply(`✅ Approved ₹${amount} for deposit #${dep.id}`);
    try { await bot.telegram.sendMessage(dep.user_id, `✅ Your deposit of ₹${amount} has been approved and added to your wallet!`); } catch(e) {}
    return;
  }
});

// ======== QUICK INLINE CALLBACKS from User Info ========
bot.action(/^qbal_add_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  const user = await dbGet('SELECT first_name, balance FROM users WHERE id = ?', [uid]);
  userStates[ctx.from.id] = { step: 'admin_bal_amount', data: { userId: uid, name: user?.first_name } };
  await ctx.reply(`💰 Enter amount for ${user?.first_name} (${uid})\nCurrent: ₹${parseFloat(user?.balance||0).toFixed(2)}\n(Negative to deduct):`);
});

bot.action(/^qban_(\d+)$/, async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCbQuery('❌');
  await ctx.answerCbQuery();
  const uid = parseInt(ctx.match[1]);
  const user = await dbGet('SELECT first_name, is_banned FROM users WHERE id = ?', [uid]);
  if (!user) return ctx.reply('Not found');
  const newBan = user.is_banned ? 0 : 1;
  await dbRun('UPDATE users SET is_banned = ? WHERE id = ?', [newBan, uid]);
  await ctx.reply(`${newBan ? '🚫 Banned' : '✅ Unbanned'}: ${user.first_name} (${uid})`);
  try { await bot.telegram.sendMessage(uid, newBan ? '🚫 You have been banned.' : '✅ You have been unbanned.'); } catch(e) {}
});

// ======== ADMIN COMMANDS ========
bot.command('approve', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /approve <user_id> <amount>');
  const uid = parseInt(args[1]), amount = parseFloat(args[2]);
  await updateBalance(uid, amount, 'deposit', `Deposit ₹${amount} approved`);
  await ctx.reply(`✅ ₹${amount} credited to user ${uid}`);
  try { await bot.telegram.sendMessage(uid, `✅ ₹${amount} has been added to your wallet!`); } catch(e) {}
});

bot.command('unban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (!args[1]) return ctx.reply('Usage: /unban <user_id>');
  const uid = parseInt(args[1]);
  await dbRun('UPDATE users SET is_banned = 0 WHERE id = ?', [uid]);
  await ctx.reply(`✅ User ${uid} unbanned.`);
});

bot.command('ban', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (!args[1]) return ctx.reply('Usage: /ban <user_id>');
  const uid = parseInt(args[1]);
  await dbRun('UPDATE users SET is_banned = 1 WHERE id = ?', [uid]);
  await ctx.reply(`✅ User ${uid} banned.`);
  try { await bot.telegram.sendMessage(uid, '🚫 You have been banned.'); } catch(e) {}
});

bot.command('stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const stats = await getStats();
  await ctx.reply(`📊 Users: ${stats.total_users} | Sold: ${stats.sessions_sold} | Available: ${stats.available} | Revenue: ₹${parseFloat(stats.revenue).toFixed(2)}`);
});

bot.command('addbalance', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 3) return ctx.reply('Usage: /addbalance <user_id> <amount>');
  const uid = parseInt(args[1]), amount = parseFloat(args[2]);
  await updateBalance(uid, amount, 'admin', `Admin balance change: ₹${amount}`);
  await ctx.reply(`✅ ₹${amount} updated for user ${uid}`);
  try { await bot.telegram.sendMessage(uid, `${amount>0?'✅':'⚠️'} Balance updated by ₹${amount}`); } catch(e) {}
});

// ======== EXPRESS API ========
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.post('/api/request_otp', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.json({ success: false, error: 'session_id required' });
  const session = await dbGet('SELECT user_id FROM user_sessions WHERE session_id = ?', [session_id]);
  if (!session) return res.json({ success: false, error: 'Invalid session' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  res.json({ success: true, otp });
});

app.listen(API_PORT, () => console.log(`✅ API on port ${API_PORT}`));
bot.launch().then(() => console.log('🤖 ADVANCED BOT RUNNING'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
