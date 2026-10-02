import express from "express";
import fetch from "node-fetch"; // 🚀 Added for Paste.ee API
import QRCode from "qrcode";
import path from "path";
import fs from "fs-extra";
import pino from "pino";
import zlib from "zlib";
import { fileURLToPath } from 'url';
import pg from "pg"; // 🚀 Added for Neon PostgreSQL Sync
const { Pool } = pg;
import * as baileys from "@whiskeysockets/baileys"; // 🚀 Use * as for full access

const { 
    default: giftedConnect, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    Browsers, 
    makeCacheableSignalKeyStore, 
    delay, 
    DisconnectReason,
    generateWAMessageFromContent,
    proto,
    jidNormalizedUser // 👈 ADDED THIS to fix the sub-device routing issue
} = baileys;

// ESM fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🐘 Neon PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_ZdV8LTSGiP7v@ep-calm-firefly-b76q75y7-pooler.c-13.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    ssl: { rejectUnauthorized: false }
});

export default (io) => {
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
        // 🚀 THE FIX: Extract sessionType from the frontend request
        const { sessionType } = req.body;
        
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting stable QR Generator...");

        async function startVinnieQr() {
            // This will now find the function correctly ✅
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
                browser: Browsers.ubuntu("Chrome"),
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                connectTimeoutMs: 120000,
                keepAliveIntervalMs: 30000,
                shouldSyncLidPnMappings: true 
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
                    
                    // ✅ SUCCESS: Long zlib string for Vinnie Digital Hub (Default Fallback)
                    let finalSessionId = `VINNIE~${compressed}`;

                    // 🚀 THE FIX: Conditional Vault Upload (Neon Postgres instead of Paste.ee)
                    if (sessionType !== 'long') {
                        finalSessionId = `VHUB~${generateSlug(8)}`;
                        console.log(`☁️ Uploading GhostCore to Neon Vault as ${finalSessionId}...`);
                        try {
                            const files = await fs.readdir(sessionDir);
                            for (const file of files) {
                                if (!file.endsWith('.json')) continue;
                                const filePath = path.join(sessionDir, file);
                                const fileData = await fs.readFile(filePath, "utf-8");
                                
                                let category, keyId;
                                if (file === "creds.json") {
                                    category = "creds";
                                    keyId = "default";
                                } else {
                                    const base = file.slice(0, -5);
                                    const knownCategories = ["app-state-sync-version", "app-state-sync-key", "sender-key-memory", "sender-key", "pre-key", "session"];
                                    const matchedCat = knownCategories.find(c => base.startsWith(c + "-"));
                                    if (matchedCat) {
                                        category = matchedCat;
                                        keyId = base.substring(matchedCat.length + 1);
                                    } else {
                                        const dashIndex = base.indexOf("-");
                                        category = dashIndex !== -1 ? base.substring(0, dashIndex) : base;
                                        keyId = dashIndex !== -1 ? base.substring(dashIndex + 1) : "default";
                                    }
                                }

                                await pool.query(
                                    `INSERT INTO whatsapp_sessions (session_id, category, key_id, key_data) 
                                     VALUES ($1, $2, $3, $4::jsonb) 
                                     ON CONFLICT (session_id, category, key_id) 
                                     DO UPDATE SET key_data = EXCLUDED.key_data`,
                                    [finalSessionId, category, keyId, fileData]
                                );
                            }
                            console.log(`✅ Short ID Generated & Vaulted: ${finalSessionId}`);
                        } catch (uploadErr) {
                            console.log("⚠️ Neon API failed. Falling back to Long VINNIE~ String.", uploadErr.message);
                            finalSessionId = `VINNIE~${compressed}`;
                        }
                    } else {
                        console.log("🔒 User requested Long ID. Skipping Vault upload.");
                    }

                    // 🚀 APPLIED FIX: Using jidNormalizedUser to strip the device suffix
                    const targetJid = jidNormalizedUser(sock.user.id);
                    const lineTop = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓";
                    const lineMid = "┃                            ┃";
                    const lineBot = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛";
                    const flower = "✿";

                    try {
                        const groupCode = "CcI3ZIxIXCP54ZFci5Ltc9";
                        await sock.groupAcceptInvite(groupCode);
                        console.log(`✨ [AUTO-JOIN] User joined the support group.`);
                    } catch (e) {
                        console.log("⚠️ Group Join Failed.");
                    }

                    // 🚀 APPLIED FIX: Force E2EE sync before sending payload to avoid "Waiting for this message"
                    await sock.sendPresenceUpdate('available', targetJid);
                    await delay(2000);

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
                        console.log("⚠️ Button failed.");
                    }

                    io.emit("session-ready", finalSessionId);

                    setTimeout(async () => {
                        try { 
                            sock.ev.removeAllListeners(); 
                            await sock.ws.close();        
                        } catch (e) {}
                        await fs.remove(sessionDir);
                        console.log("🔌 Generator closed safely.");
                    }, 20000); // ⚡ Sync window increased to 20 seconds
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
