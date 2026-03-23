const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    delay,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const pino = require("pino");
const SessionModel = require("../models/session");

// Elite Small-Caps / Bold Formatter
function toFancy(text) {
    const bold = { 
        'a':'𝐚','b':'𝐛','c':'𝐜','d':'𝐝','e':'𝐞','f':'𝐟','g':'𝐠','h':'𝐡','i':'𝐢','j':'𝐣',
        'k':'𝐤','l':'𝐥','m':'𝐦','n':'𝐧','o':'𝐨','p':'𝐩','q':'𝐪','r':'𝐫','s':'𝐬','t':'𝐭',
        'u':'𝐮','v':'𝐯','w':'𝐰','x':'𝐱','y':'𝐲','z':'𝐳',
        'A':'𝐀','B':'𝐁','C':'𝐂','D':'𝐃','E':'𝐄','F':'𝐅','G':'𝐆','H':'𝐇','I':'𝐈','J':'𝐉',
        'K':'𝐊','L':'𝐋','M':'𝐌','N':'𝐍','O':'𝐎','P':'𝐏','Q':'𝐐','R':'𝐑','S':'𝐒','T':'𝐓',
        'U':'𝐔','V':'𝐕','W':'𝐖','X':'𝐗','Y':'𝐘','Z':'𝐙',
        '0':'𝟎','1':'𝟏','2':'𝟐','3':'𝟑','4':'𝟒','5':'𝟓','6':'𝟔','7':'𝟕','8':'𝟖','9':'𝟗'
    };
    return text.split('').map(c => bold[c] || c).join('');
}

async function createGenerator(mode, phoneNumber = null, io = null) {
    // Unique session per request to prevent cross-talk
    const sessionDir = `./temp_auth_${Date.now()}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`📡 [ENGINE]: Mode -> ${mode} | Target -> ${phoneNumber || 'QR'}`);

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: mode === "qr",
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false
    });

    // Handle QR emission to frontend
    if (mode === "qr" && io) {
        sock.ev.on("connection.update", (update) => {
            if (update.qr) io.emit("qr", update.qr);
        });
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            console.log("✅ [SUCCESS]: Handshake established.");

            try {
                // 1. Generate the TRUE Session ID (The Creds themselves)
                const credsFile = fs.readFileSync(`${sessionDir}/creds.json`, "utf-8");
                const sessionData = Buffer.from(credsFile).toString("base64");
                const vinnieId = "Vinnie~MD~" + sessionData; // Now the ID IS the session!

                // 2. Save to DB for redundancy
                await SessionModel.create({
                    sessionId: vinnieId.substring(0, 20), // Store short version for lookup
                    fullCreds: sessionData
                }).catch(() => {});

                // 3. Reliable JID Target
                const userJid = sock.user.id.includes(':') 
                    ? sock.user.id.split(':')[0] + '@s.whatsapp.net' 
                    : sock.user.id;

                const welcome = `┌────────────────────────┈\n` +
                                `│      *ᴠ-ʜᴜʙ_sᴇssɪᴏɴ_ʟᴏɢ* \n` +
                                `└────────────────────────┈\n\n` +
                                `┌─『 ʟɪɴᴋ_sᴜᴄᴄᴇssғᴜʟ 』\n` +
                                `│ ✅ *sᴛᴀᴛᴜs:* ᴀᴄᴛɪᴠᴀᴛᴇᴅ\n` +
                                `│ 🛡️ *sʜɪᴇʟᴅ:* ᴏɴʟɪɴᴇ\n` +
                                `└────────────────────────┈\n\n` +
                                `*ʏᴏᴜʀ_sᴇssɪᴏɴ_ɪᴅ:* \n` +
                                `\`\`\`${vinnieId}\`\`\`\n\n` +
                                `_ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ᴛʜɪs ᴄᴏᴅᴇ_`;

                // 4. Send the ID to WhatsApp
                await sock.sendMessage(userJid, { text: welcome });
                console.log("📤 [DONE]: Session ID sent to target.");

                // 5. Cleanup with enough delay to flush the buffer
                setTimeout(() => {
                    sock.logout();
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                    console.log("🧹 [CLEAN]: Temp files removed.");
                }, 15000);

            } catch (err) {
                console.error("❌ [ERROR]: Delivery Failed", err);
            }
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                // Optional: Reconnect logic here
            }
        }
    });

    // --- 🔑 PAIRING CODE HANDSHAKE ---
    if (mode === "pair" && phoneNumber && !state.creds.registered) {
        // Kenyan Fix: Ensure 254
        let cleanNumber = phoneNumber.replace(/\D/g, "");
        if (cleanNumber.startsWith('0')) cleanNumber = '254' + cleanNumber.substring(1);
        if (cleanNumber.startsWith('7') || cleanNumber.startsWith('1')) cleanNumber = '254' + cleanNumber;

        console.log(`⏳ [PAIR]: Requesting code for ${cleanNumber}`);
        
        // Wait for socket to stabilize
        await delay(5000);
        
        try {
            const code = await sock.requestPairingCode(cleanNumber);
            console.log("🔑 [CODE]:", code);
            if (io) io.emit("pairingCode", code); // Send to frontend
        } catch (err) {
            console.error("❌ [PAIR_ERR]:", err);
        }
    }
}

module.exports = createGenerator;
