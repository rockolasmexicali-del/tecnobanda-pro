const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const db = require('./database');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const chokidar = require('chokidar');

// --- SERVER METADATA ---
const SERVER_VERSION = "3.3.0 (Cloud Optimized & Complete)";
const START_TIME = new Date().toISOString();

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED SERVER STARTING...`);
console.log(`📂 Version: ${SERVER_VERSION}`);
console.log(`🕒 Start Time: ${START_TIME}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// --- ANTI-CRASH ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ ERROR (Unhandled Rejection):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('\n❌ ERROR (Uncaught Exception):', err.message);
});

// --- GLOBALS & CONFIG ---
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const INTROS_DIR = path.join(UPLOADS_DIR, 'intros');
const AMBIENT_DIR = path.join(UPLOADS_DIR, 'ambient');
const MUSICA_JSON_PATH = path.join(__dirname, 'musica.json');

[UPLOADS_DIR, INTROS_DIR, AMBIENT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function getConfig() {
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (!fs.existsSync(configPath)) return {};
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (process.platform === 'linux' && config.musicPath && config.musicPath.includes(':')) {
            config.musicPath = 'musica';
        }
        return config;
    } catch (e) { return {}; }
}

function getMusicDir() {
    const config = getConfig();
    let mPath = config.musicPath || 'musica';
    if (!path.isAbsolute(mPath)) mPath = path.join(__dirname, mPath);
    if (!fs.existsSync(mPath)) try { fs.mkdirSync(mPath, { recursive: true }); } catch (e) { }
    return mPath;
}

function logActivity(action, details) {
    db.run("INSERT INTO audit_logs (action, details) VALUES (?, ?)", [action, details]);
}

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(__dirname));

// --- SOCKET LOGIC ---
const otpStore = new Map();

io.on('connection', (socket) => {
    console.log(`[Socket] 🔗 Conexión [${socket.id}]`);
    socket.on('join_user', (email) => {
        if (email) {
            const cleanEmail = email.trim().toLowerCase();
            db.get("SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1", [cleanEmail], (err, user) => {
                if (user) {
                    socket.join(cleanEmail);
                    console.log(`[Socket] 👤 User ${cleanEmail} joined.`);
                }
            });
        }
    });

    socket.on('join_admin', () => {
        socket.join('admin_room');
    });

    socket.on('admin_message', (data) => {
        const { message, target } = data;
        if (target === 'ALL') io.emit('admin_message', { message });
        else io.to(target.trim().toLowerCase()).emit('admin_message', { message });
    });
});

// --- EMAIL TRANSPORTER ---
function getMailTransporter() {
    const config = getConfig();
    if (config.emailServer && config.emailServer.user) {
        return nodemailer.createTransport({
            service: config.emailServer.service || 'gmail',
            auth: { user: config.emailServer.user, pass: config.emailServer.pass },
            tls: { rejectUnauthorized: false }
        });
    }
    return null;
}

// --- API ENDPOINTS (CORREGIDOS) ---

// 1. Registro (Faltaba en la 3.2.0)
app.post('/api/register', (req, res) => {
    const { name, email, phone, deviceId, referralCode } = req.body;
    const cleanEmail = email ? email.trim().toLowerCase() : '';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    db.get("SELECT * FROM users WHERE LOWER(TRIM(email)) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (row) return res.status(409).json({ error: "Dispositivo ya registrado" });

        const proceedWithReg = (finalRefCode) => {
            const myCode = (name || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5) + "-" + Math.floor(1000 + Math.random() * 9000);
            db.run("INSERT INTO users (name, email, phone, device_id, ip_address, last_seen, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
                [name, cleanEmail, phone, deviceId, ip, myCode, finalRefCode], function (err) {
                    if (err) return res.status(500).json({ error: err.message });
                    io.emit('update_users');
                    res.json({ success: true, user: { name, email: cleanEmail, phone, referralCode: myCode } });
                });
        };

        if (referralCode && referralCode.trim() !== "") {
            db.get("SELECT id FROM users WHERE UPPER(referral_code) = UPPER(?) LIMIT 1", [referralCode.trim()], (err, padrino) => {
                if (!padrino) return res.status(400).json({ error: "Código de referido inválido" });
                proceedWithReg(referralCode.trim());
            });
        } else proceedWithReg(null);
    });
});

// 2. Auth OTP
app.post('/api/auth/request-otp', async (req, res) => {
    const { email } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email, { otp, expires: Date.now() + 300000 });
        const transporter = getMailTransporter();
        if (transporter) {
            try {
                await transporter.sendMail({
                    from: `"TecnoBanda" <${getConfig().emailServer.user}>`,
                    to: email,
                    subject: 'Tu Clave de Acceso',
                    html: `<h1>${otp}</h1>`
                });
                res.json({ success: true });
            } catch (e) { res.status(500).json({ error: "Error de email" }); }
        } else res.status(500).json({ error: "Email no configurado" });
    });
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp, deviceId, referralCode } = req.body;
    const stored = otpStore.get(email);
    if (stored && stored.otp === otp && stored.expires > Date.now()) {
        otpStore.delete(email);
        const cleanEmail = email.trim().toLowerCase();
        db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, user) => {
            if (user) {
                res.json({ success: true, user: { name: user.name, email: user.email, referralCode: user.referral_code } });
            } else {
                const myCode = "TB-" + Math.random().toString(36).substr(2, 5).toUpperCase();
                db.run("INSERT INTO users (name, email, device_id, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)",
                    ['Usuario', cleanEmail, deviceId, myCode, referralCode], () => {
                        res.json({ success: true, user: { name: 'Usuario', email: cleanEmail, referralCode: myCode } });
                    });
            }
        });
    } else res.status(401).json({ error: "Clave incorrecta" });
});

// 3. Ping & Licenses
app.post('/api/ping', (req, res) => {
    const { deviceId, email } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    db.get("SELECT * FROM licenses WHERE LOWER(user_email) = ? AND original_device_id = ? AND status='USED' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)",
        [email.toLowerCase(), deviceId], (err, lic) => {
            if (!lic) return res.json({ status: "inactive" });
            res.json({ status: "active", type: lic.type, expiresAt: lic.expires_at });
        });
});

app.post('/api/activate', (req, res) => {
    const { key, deviceId, email } = req.body;
    db.get("SELECT * FROM licenses WHERE key = ? AND status='UNUSED'", [key], (err, lic) => {
        if (!lic) return res.status(400).json({ error: "Clave inválida" });
        let exp = null; const now = new Date();
        if (lic.type === '1_DAY') exp = new Date(now.getTime() + 86400000).toISOString();
        else if (lic.type === '30_DAYS') exp = new Date(now.getTime() + 2592000000).toISOString();
        else exp = new Date(2099, 0, 1).toISOString();

        db.run("UPDATE licenses SET status='USED', user_email=?, expires_at=?, original_device_id=? WHERE key=?",
            [email.toLowerCase(), exp, deviceId, key], () => {
                io.emit('update_licenses');
                res.json({ success: true, type: lic.type, expiresAt: exp });
            });
    });
});

// 4. Playlists
app.get('/api/playlists', (req, res) => {
    db.all("SELECT * FROM playlists WHERE user_email = ?", [req.query.email], (err, rows) => {
        res.json(rows.map(r => ({ ...r, songs: JSON.parse(r.songs || '[]') })));
    });
});

app.post('/api/playlists', (req, res) => {
    const { email, name } = req.body;
    db.run("INSERT INTO playlists (user_email, name, songs) VALUES (?, ?, '[]')", [email, name], function () {
        res.json({ id: this.lastID, name, songs: [] });
    });
});

// --- VIGILANTE & B2 SYNC ---
async function updateManifest() {
    try {
        const mDir = getMusicDir();
        if (!fs.existsSync(mDir)) return;
        const config = getConfig();
        const files = fs.readdirSync(mDir).filter(f => f.endsWith('.zip') || f.endsWith('.rar'));
        const database = files.map(f => ({
            title: f.replace('.zip', '').replace('.rar', ''),
            artist: "Banda",
            isCompressed: true,
            archiveFile: `https://${config.endpoint}/file/${config.bucketName}/${encodeURIComponent(f).replace(/%20/g, '+')}`,
            dateAdded: fs.statSync(path.join(mDir, f)).mtime.toISOString()
        }));
        fs.writeFileSync(MUSICA_JSON_PATH, JSON.stringify(database, null, 2));
        io.emit('database_updated', database);
    } catch (e) { }
}

app.get('/api/config', (req, res) => res.json(getConfig()));

app.get('*', (req, res, next) => {
    if (req.url.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ UNIFIED SERVER V3.3.0 ACTIVO EN PUERTO ${PORT}`);
    updateManifest();
});
