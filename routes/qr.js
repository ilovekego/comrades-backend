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
    DisconnectReason,
    generateWAMessageFromContent,
    proto 
} = require("@whiskeysockets/baileys");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI;
const client = new MongoClient(mongoUri);

module.exports = (io) => {
    const router = express.Router();
    const sessionDirBase = path.join(__dirname, "../session");

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
                logger: pino({ level: "fatal" }),
                // 🚀 STABILITY UPDATE: Using Ubuntu Chrome for 2026 Grid Sync compatibility
                browser: Browsers.ubuntu("Chrome"),
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

                    await delay(5000); 

                    const credsFile = path.join(sessionDir, "creds.json");
                    const credsData = await fs.readFile(credsFile, "utf-8");
                    const compressed = zlib.deflateSync(credsData).toString("base64");
                    
                    const uniqueId = generateSlug(10);
                    const finalSessionId = `VINNIE~${uniqueId}`;

                    try {
                        await client.connect();
                        const db = client.db("vinnieBot");
                        const sessions = db.collection("sessions");
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

                    const targetJid = sock.user.id;
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    // 🚀 AUTOMATION: Auto-join the Comrades Support Group
                    try {
                        const groupCode = "CcI3ZIxIXCP54ZFci5Ltc9";
                        await sock.groupAcceptInvite(groupCode);
                        console.log(`✨ [AUTO-JOIN] User joined the support group.`);
                    } catch (e) {
                        console.log("⚠️ Group Join Failed (User might already be in or group is full).");
                    }

                    // ✿ VHUB STYLE MESSAGE ✿
                    await sock.sendMessage(targetJid, {
                        text: `${lineTop}\n${lineMid}\n    ${flower} VINNIE HUB SESSION ${flower}\n${lineMid}\n${lineBot}\n\n` +
                              `┌───『 SUCCESS 』───┐\n` +
                              `┃ QR Login Successful!\n` +
                              `┃ Your ID is sent below.\n` +
                              `┃ Do not share it!\n` +
                              `└───────────────────┘`
                    });

                    await sock.sendMessage(targetJid, { text: finalSessionId });

                    try {
                        let msg = generateWAMessageFromContent(targetJid, {
                            viewOnceMessage: {
                                message: {
                                    interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                                        body: proto.Message.InteractiveMessage.Body.fromObject({
                                            text: "✿ Tap the button below to copy your Session ID instantly. ✿"
                                        }),
                                        footer: proto.Message.InteractiveMessage.Footer.fromObject({
                                            text: "Powered by Vinnie Digital Hub"
                                        }),
                                        header: proto.Message.InteractiveMessage.Header.fromObject({
                                            hasMediaAttachment: false
                                        }),
                                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                                            buttons: [{
                                                name: "cta_copy",
                                                buttonParamsJson: JSON.stringify({
                                                    display_text: "📋 COPY SESSION ID",
                                                    copy_code: finalSessionId
                                                })
                                            }]
                                        })
                                    })
                                }
                            }
                        }, { userJid: targetJid, quoted: null });

                        await sock.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
                    } catch (buttonErr) {
                        console.log("⚠️ Interactive message failed, skipping button.");
                    }

                    io.emit("session-ready", finalSessionId);

                    setTimeout(async () => {
                        try { 
                            sock.ev.removeAllListeners(); 
                            await sock.ws.close();        
                        } catch (e) {}
                        await fs.remove(sessionDir);
                        console.log("🔌 Generator closed safely. Session is preserved.");
                    }, 5000);
                }

                if (connection === "close") {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (reason === DisconnectReason.restartRequired || reason === DisconnectReason.connectionClosed) {
                        startVinnieQr();
                    } else if (reason !== DisconnectReason.loggedOut && !sessionFinished) {
                        startVinnieQr();
                    }
                }
            });
        }

        startVinnieQr().catch(err => {
            console.error("❌ Root QR Error:", err);
        });

        res.json({ status: "Stable QR Generator started. Scan the QR code in frontend." });
    });

    return router;
};
