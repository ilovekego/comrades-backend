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
const { nanoid } = require("nanoid");
const SessionModel = require("../models/session");

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

async function createGenerator(mode, phoneNumber = null) {

    const sessionDir = `./session_${Date.now()}`;

    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    console.log("🚀 Starting Generator...");
    console.log("📂 Session Folder:", sessionDir);
    console.log("🔹 Mode:", mode);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: true,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {

        const { connection, lastDisconnect } = update;

        console.log("📡 Connection Update:", update);

        if (connection === "open") {

            console.log("✅ Device Successfully Linked!");

            const credsFile = fs.readFileSync(`${sessionDir}/creds.json`, "utf-8");
            const vinnieId = "Vinnie~MD~" + nanoid(10);

            await SessionModel.create({
                sessionId: vinnieId,
                fullCreds: Buffer.from(credsFile).toString("base64")
            });

            console.log("🆔 SESSION ID:", vinnieId);

            const userJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

            const welcome = `
┏━━━━━━━━━━━━━━━━━━━━━━━━┓
┃   ${toFancy('VINNIE BOT SYSTEM')}   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━┛

${toFancy('Link Successful')} ✅

${toFancy('Your Session ID')}:
👇👇👇

\`\`\`
${vinnieId}
\`\`\`

Tap and hold above to copy.
            `;

            await sock.sendMessage(userJid, { text: welcome });

            console.log("📤 Session ID sent to user.");

            setTimeout(() => {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log("🧹 Session Folder Cleaned");
            }, 10000);
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("❌ Connection Closed. Reason:", reason);

            if (reason === DisconnectReason.loggedOut) {
                console.log("🚪 Logged Out");
            }
        }
    });

    if (mode === "pair" && phoneNumber && !state.creds.registered) {
        console.log("⏳ Waiting before requesting pairing code...");
        await delay(8000);
        const code = await sock.requestPairingCode(phoneNumber);
        console.log("🔑 PAIRING CODE:", code);
    }
}

module.exports = createGenerator;
