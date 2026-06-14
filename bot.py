import os
import re
import zipfile
import json
import asyncio
from datetime import datetime
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telegram import Update, ReplyKeyboardMarkup, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, MessageHandler, filters, ConversationHandler

# ============ CONFIG ============
BOT_TOKEN = os.environ.get("BOT_TOKEN")  # Render environment se lega
ADMIN_IDS = [6106058051]  # Apna ID daalo

# Folders
SESSION_FOLDER = "sessions"
os.makedirs(SESSION_FOLDER, exist_ok=True)

# Memory storage
active_numbers = {}
rented_numbers = {}
user_balances = {}

PRICES = {"good": 100, "cheap": 50}

# ============ OTP EXTRACTOR ============
def extract_otp(text):
    patterns = [r'\b(\d{4,6})\b', r'OTP[:\s]*(\d{4,6})', r'code[:\s]*(\d{4,6})']
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1)
    return None

# ============ KEYBOARDS ============
def main_keyboard(user_id=None):
    keyboard = [
        ["🛒 Buy Account", "📱 Buy Sessions"],
        ["👤 Profile", "💰 Deposit"],
        ["📊 My Stats", "⭐ Support"]
    ]
    if user_id in ADMIN_IDS:
        keyboard.append(["⚙️ Admin Panel"])
    return ReplyKeyboardMarkup(keyboard, resize_keyboard=True)

def account_type_keyboard():
    keyboard = [
        [InlineKeyboardButton("✅ Good Quality (₹100)", callback_data="type_good")],
        [InlineKeyboardButton("⚠️ Cheap Quality (₹50)", callback_data="type_cheap")]
    ]
    return InlineKeyboardMarkup(keyboard)

def admin_keyboard():
    keyboard = [
        [InlineKeyboardButton("📦 Add Number via ZIP", callback_data="admin_add_zip")],
        [InlineKeyboardButton("📋 List Numbers", callback_data="admin_list")],
        [InlineKeyboardButton("📊 Stats", callback_data="admin_stats")],
        [InlineKeyboardButton("🗑️ Remove Number", callback_data="admin_remove")]
    ]
    return InlineKeyboardMarkup(keyboard)

# ============ LOGIN FROM SESSION ============
async def login_from_session(session_string, number, bot):
    try:
        client = TelegramClient(StringSession(session_string), 6, "eb06d4abfb49dc3eeb1aeb98ae0f581e")
        await client.connect()
        
        if not await client.is_user_authorized():
            return {"success": False, "message": "Session expired"}
        
        if not number:
            me = await client.get_me()
            number = me.phone
        
        @client.on(events.NewMessage(incoming=True))
        async def handle_otp(event):
            message = event.raw_text
            if number in rented_numbers:
                user_id = rented_numbers[number]["user_id"]
                otp = extract_otp(message)
                if otp:
                    await bot.send_message(
                        user_id,
                        f"🔐 *OTP RECEIVED!*\n\n📞 `{number}`\n🔑 `{otp}`",
                        parse_mode="Markdown"
                    )
                    del rented_numbers[number]
        
        active_numbers[number] = {"client": client, "session_string": session_string}
        return {"success": True, "number": number}
    except Exception as e:
        return {"success": False, "message": str(e)}

# ============ BOT HANDLERS ============
async def start(update, context):
    await update.message.reply_text(
        "👋 *Welcome To TG-King Robot!*\n\nUse buttons below 👇",
        reply_markup=main_keyboard(update.effective_user.id),
        parse_mode="Markdown"
    )

async def buy_account(update, context):
    await update.message.reply_text(
        "*Select Account Type:*",
        reply_markup=account_type_keyboard(),
        parse_mode="Markdown"
    )

async def handle_account_type(update, context):
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    acc_type = query.data.split("_")[1]
    price = PRICES[acc_type]
    
    balance = user_balances.get(user_id, 0)
    if balance < price:
        await query.edit_message_text(f"❌ Insufficient balance! Need ₹{price}")
        return
    
    available = None
    for num in active_numbers:
        if num not in rented_numbers:
            available = num
            break
    
    if not available:
        await query.edit_message_text("❌ No numbers available! Try again later.")
        return
    
    rented_numbers[available] = {"user_id": user_id, "type": acc_type}
    user_balances[user_id] = balance - price
    
    await query.edit_message_text(
        f"✅ *Number Rented!*\n\n📞 `{available}`\n💰 Deducted: ₹{price}\n⏳ Waiting for OTP...",
        parse_mode="Markdown"
    )
    
    await asyncio.sleep(120)
    if available in rented_numbers:
        user_balances[user_id] = user_balances.get(user_id, 0) + price
        del rented_numbers[available]

async def profile(update, context):
    user_id = update.effective_user.id
    await update.message.reply_text(
        f"👤 *Profile*\n💰 Balance: ₹{user_balances.get(user_id, 0)}",
        parse_mode="Markdown"
    )

async def admin_panel(update, context):
    if update.effective_user.id not in ADMIN_IDS:
        return
    await update.message.reply_text("⚙️ *Admin Panel*", reply_markup=admin_keyboard(), parse_mode="Markdown")

async def handle_zip_upload(update, context):
    if update.effective_user.id not in ADMIN_IDS:
        return
    
    if not update.message.document or not update.message.document.file_name.endswith('.zip'):
        await update.message.reply_text("❌ Send a valid ZIP file!")
        return
    
    await update.message.reply_text("🔄 Processing...")
    
    file = await context.bot.get_file(update.message.document.file_id)
    temp_zip = f"{SESSION_FOLDER}/temp_{datetime.now().timestamp()}.zip"
    await file.download_to_drive(temp_zip)
    
    try:
        with zipfile.ZipFile(temp_zip, 'r') as zipf:
            session_string = None
            for name in zipf.namelist():
                if name.endswith('.txt') or name.endswith('.session'):
                    with zipf.open(name) as f:
                        content = f.read().decode('utf-8')
                        if len(content) < 500 and ':' in content:
                            session_string = content.strip()
                            break
            
            if session_string:
                result = await login_from_session(session_string, None, context.bot)
                if result["success"]:
                    await update.message.reply_text(f"✅ {result['number']} added successfully!")
                else:
                    await update.message.reply_text(f"❌ {result['message']}")
            else:
                await update.message.reply_text("❌ No valid session found in ZIP")
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {str(e)}")
    finally:
        os.remove(temp_zip)

async def admin_list(update, context):
    query = update.callback_query
    await query.answer()
    msg = "*📞 Numbers*\n\n"
    for num in active_numbers:
        status = "🔴 In Use" if num in rented_numbers else "🟢 Available"
        msg += f"• `{num}` - {status}\n"
    await query.edit_message_text(msg or "No numbers", parse_mode="Markdown")

async def admin_stats(update, context):
    query = update.callback_query
    await query.answer()
    msg = f"📊 *Stats*\n\nTotal: {len(active_numbers)}\nRented: {len(rented_numbers)}\nUsers: {len(user_balances)}"
    await query.edit_message_text(msg, parse_mode="Markdown")

async def back_to_admin(update, context):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("⚙️ *Admin Panel*", reply_markup=admin_keyboard(), parse_mode="Markdown")

async def back_to_main(update, context):
    query = update.callback_query
    await query.answer()
    await query.edit_message_text("👋 Welcome!", reply_markup=main_keyboard(query.from_user.id))

# ============ MAIN ============
def main():
    app = Application.builder().token(BOT_TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.Regex("🛒 Buy Account"), buy_account))
    app.add_handler(MessageHandler(filters.Regex("👤 Profile"), profile))
    app.add_handler(MessageHandler(filters.Regex("⚙️ Admin Panel"), admin_panel))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_zip_upload))
    
    app.add_handler(CallbackQueryHandler(handle_account_type, pattern="type_"))
    app.add_handler(CallbackQueryHandler(admin_list, pattern="admin_list"))
    app.add_handler(CallbackQueryHandler(admin_stats, pattern="admin_stats"))
    app.add_handler(CallbackQueryHandler(back_to_admin, pattern="admin_back"))
    app.add_handler(CallbackQueryHandler(back_to_main, pattern="back_main"))
    app.add_handler(CallbackQueryHandler(lambda u,c: None, pattern="admin_add_zip"))
    app.add_handler(CallbackQueryHandler(lambda u,c: None, pattern="admin_remove"))
    
    user_balances[6106058051] = 1000
    
    print("🤖 Bot Started!")
    app.run_polling()

if __name__ == "__main__":
    main()
