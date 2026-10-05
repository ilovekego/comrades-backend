import express from "express";
import fetch from "node-fetch"; // 🚀 Added for API Requests
import QRCode from "qrcode";
import path from "path";
import fs from "fs-extra";
import pino from "pino";
import zlib from "zlib";
import { fileURLToPath } from 'url';
import * as baileys from "@whiskeysockets/baileys"; 

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
    jidNormalizedUser 
} = baileys;

// ESM fix for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
        // 🚀 EXTRACT ALL NEW FRONTEND TOGGLES AND SETTINGS
        const { 
            sessionType, 
            mode, 
            prefix, 
            autobio, 
            antilink, 
            antimention, 
            autoreact, 
            autosave, 
            typing, 
            recording 
        } = req.body;
        
        const socketId = Date.now().toString();
        const sessionDir = path.join(sessionDirBase, socketId);
        await fs.ensureDir(sessionDir);

        console.log("🚀 Starting stable QR Generator with full configuration payload...");

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
                    
                    let finalSessionId = `VINNIE~${compressed}`;

                    if (sessionType !== 'long') {
                        finalSessionId = `VHUB~${generateSlug(8)}`;
                        console.log(`☁️ Skipping local vault storage (Handled via centralized database vault)...`);
                    }

                    const targetJid = jidNormalizedUser(sock.user.id);
                    const ownerNumberExtracted = targetJid.split('@')[0];
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

                    // ━━━━━ 🚀 HEROKU AUTO-DEPLOYMENT PIPELINE ━━━━━
                    if (mode === 'auto') {
                        try {
                            await sock.sendMessage(targetJid, { text: "🚀 *Auto-Deploy Initiated*\nProvisioning your dedicated server with your custom preferences..." });
                            
                            const herokuApi = "https://api.heroku.com";
                            const headers = {
                                'Accept': 'application/vnd.heroku+json; version=3',
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.HEROKU_API_KEY}`
                            };

                            // 1. App Creation
                            const appName = `vhub-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
                            const createRes = await fetch(`${herokuApi}/apps`, {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({ name: appName, region: 'eu' })
                            });
                            
                            if (!createRes.ok) throw new Error("Failed to provision Heroku app");

                            // 2. Config Var Injection (Includes all UI toggles, database fallback handles itself)
                            await fetch(`${herokuApi}/apps/${appName}/config-vars`, {
                                method: 'PATCH',
                                headers,
                                body: JSON.stringify({
                                    SESSION_ID: finalSessionId,
                                    OWNER_NUMBER: ownerNumberExtracted,
                                    PREFIX: prefix || '.',
                                    MODE: 'public',
                                    AUTOBIO: autobio ? 'true' : 'false',
                                    ANTILINK: antilink ? 'true' : 'false',
                                    ANTIMENTION: antimention ? 'true' : 'false',
                                    AUTOREACT: autoreact ? 'true' : 'false',
                                    AUTOSAVE: autosave ? 'true' : 'false',
                                    TYPING: typing ? 'true' : 'false',
                                    RECORDING: recording ? 'true' : 'false',
                                    HEROKU_APP_NAME: appName,
                                    HEROKU_API_KEY: process.env.HEROKU_API_KEY,
                                    CHANGELOG_URL: "https://gist.githubusercontent.com/ilovekego/301acc758d2b68b6cc981b67662e289d/raw/d776125a72dc5887fdf2c184a05ad8168dc2ec85/changelog.json"
                                })
                            });

                            // 2.5 FORCE BUILDPACKS
                            await fetch(`${herokuApi}/apps/${appName}/buildpack-installations`, {
                                method: 'PUT',
                                headers,
                                body: JSON.stringify({
                                    updates: [
                                        { buildpack: "heroku/nodejs" },
                                        { buildpack: "https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest" },
                                        { buildpack: "https://github.com/clhuang/heroku-buildpack-webp-binaries.git" }
                                    ]
                                })
                            });

                            // 3. Silent Tarball Deployment
                            const githubRepoUrl = "https://github.com/Vinny256/COMRADES-MD-BOT/archive/refs/heads/main.tar.gz";
                            const buildRes = await fetch(`${herokuApi}/apps/${appName}/builds`, {
                                method: 'POST',
                                headers,
                                body: JSON.stringify({
                                    source_blob: { url: githubRepoUrl }
                                })
                            });
                            
                            if (!buildRes.ok) throw new Error("Failed to start build process");

                            // 4. Wake Dyno
                            await fetch(`${herokuApi}/apps/${appName}/formation/web`, {
                                method: 'PATCH',
                                headers,
                                body: JSON.stringify({ quantity: 1, size: "eco" })
                            });

                            await sock.sendMessage(targetJid, { 
                                text: `✅ *Deployment Successful!*\nYour bot [${appName}] is currently building with your customized worker toggles. It will be online in ~60 seconds.` 
                            });
                            
                        } catch (err) {
                            console.error("Auto-Deploy Error:", err);
                            await sock.sendMessage(targetJid, { 
                                text: `❌ *Auto-Deploy Failed*\nPlease use your Session ID to deploy manually. Error: ${err.message}` 
                            });
                        }
                    }

                    setTimeout(async () => {
                        try { 
                            sock.ev.removeAllListeners(); 
                            await sock.ws.close();        
                        } catch (e) {}
                        await fs.remove(sessionDir);
                        console.log("🔌 Generator closed safely.");
                    }, 20000); 
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
