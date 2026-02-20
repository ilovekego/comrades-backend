const express = require("express");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs-extra");
const pino = require("pino");
const zlib = require("zlib");
const { 
    default: giftedConnect, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    Browsers, 
    makeCacheableSignalKeyStore, 
    delay, 
    DisconnectReason 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);

module.exports = (io) => {
    const router = express.Router();
    const sessionDirBase = path.join(__dirname, "../session");

    // --- 🛠️ HELPER: Generate Random 10 Chars ---
    const generateSlug = (length = 10) => {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    };

    router.post("/", async (req, res) => {
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting stable QR Generator...");

        async function startVinnieQr() {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = giftedConnect({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "debug" }), // 📝 ENABLE FULL LOGGING
                browser: Browsers.macOS("Safari"),
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                connectTimeoutMs: 120000,
                keepAliveIntervalMs: 30000,
            });

            sock.ev.on("creds.update", saveCreds);

            let qrSent = false;
            let sessionFinished = false;

            sock.ev.on("connection.update", async (update) => {
                const { connection, qr, lastDisconnect } = update;
                
                // Log every Baileys instance
                console.log("📡 [QR_BAILEYS_EVENT]:", JSON.stringify(update, null, 2));

                if (qr && !qrSent) {
                    const qrDataUrl = await QRCode.toDataURL(qr, { scale: 4 });
                    io.emit("qr", qrDataUrl);
                    console.log("📡 QR emitted to frontend.");
                    qrSent = true;
                }

                if (connection === "open") {
                    if (sessionFinished) return;
                    sessionFinished = true;
                    console.log("✅ QR Scanned Successfully!");

                    await delay(10000); // Wait for keys to flush

                    // 1️⃣ COMPRESS EVERYTHING (ZLIB)
                    const credsFile = path.join(sessionDir, "creds.json");
                    const credsData = await fs.readFile(credsFile, "utf-8");
                    const compressed = zlib.deflateSync(credsData).toString("base64");
                    
                    // 2️⃣ FORMAT TO 10 CHARACTERS
                    const uniqueId = generateSlug(10);
                    const finalSessionId = `VINNIE~${uniqueId}`;

                    // 3️⃣ SAVE TO MONGODB (WITH 2HR TTL)
                    try {
                        await client.connect();
                        const db = client.db("vinnieBot");
                        const sessions = db.collection("sessions");
                        // Ensure TTL index
                        await sessions.createIndex({ "createdAt": 1 }, { expireAfterSeconds: 7200 });

                        await sessions.insertOne({
                            sessionId: finalSessionId,
                            data: compressed,
                            createdAt: new Date(),
                            status: "active"
                        });
                    } catch (dbErr) {
                        console.error("❌ MongoDB Error:", dbErr);
                    }

                    // 4️⃣ SEND STYLIZED MESSAGES (FLORAL/LINES)
                    const targetJid = sock.user.id;
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    // Message A: Stylized Header
                    await sock.sendMessage(targetJid, {
                        text: `${lineTop}\n${lineMid}\n    ${flower} VINNIE SESSION ID ${flower}\n${lineMid}\n${lineBot}\n\n` +
                              `┌───『 SUCCESS 』───┐\n` +
                              `┃ QR Login Successful!\n` +
                              `┃ Session expires in 2 hours.\n` +
                              `└───────────────────┘`
                    });

                    // Message B: The Raw ID (Separated for easy copy)
                    await sock.sendMessage(targetJid, { text: finalSessionId });

                    // Message C: The Copy Button
                    await sock.sendMessage(targetJid, {
                        viewOnce: true,
                        interactiveMessage: {
                            body: { text: "Tap the button below to copy your Session ID instantly." },
                            footer: { text: "Powered by Vinnie Digital Hub" },
                            nativeFlowMessage: {
                                buttons: [{
                                    name: "cta_copy",
                                    buttonParamsJson: JSON.stringify({
                                        display_text: "📋 COPY SESSION ID",
                                        copy_code: finalSessionId
                                    })
                                }]
                            }
                        }
                    });

                    io.emit("session-ready", finalSessionId);

                    setTimeout(async () => {
                        try { await sock.logout(); } catch (e) {}
                        await fs.remove(sessionDir);
                    }, 5000);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    
                    // 🚀 CRITICAL: 515 / RESTART LOGIC
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.connectionClosed) {
                        console.log("🔄 Stable Restarting (QR Context)...");
                        startVinnieQr();
                    } else if (reason !== DisconnectReason.loggedOut && !sessionFinished) {
                        console.log("🔄 Re-attempting connection...");
                        startVinnieQr();
                    } else if (reason === DisconnectReason.loggedOut) {
                        await fs.remove(sessionDir);
                    }
                }
            });
        }

        startVinnieQr().catch(err => {
            console.error("❌ Root QR Error:", err);
            res.status(500).json({ error: "Failed to start QR generator" });
        });

        res.json({ status: "Stable QR Generator started. Scan the QR code in frontend." });
    });

    return router;
};
