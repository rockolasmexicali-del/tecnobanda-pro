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
const SERVER_VERSION = "3.6.0 (Enterprise Cloud Unified)";
const START_TIME = new Date().toISOString();

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED SERVER STARTING...`);
console.log(`📂 Version: ${SERVER_VERSION}`);
console.log(`🕒 Start Time: ${START_TIME}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// --- ANTI-CRASH ---
process.on('unhandledRejection', (r) => console.error('❌ Rejection:', r));
process.on('uncaughtException', (e) => console.error('❌ Exception:', e.message));

// --- FILESYSTEM ---
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
        if (process.platform === 'linux' && config.musicPath && config.musicPath.includes(':')) config.musicPath = 'musica';
        return config;
    } catch (e) { return {}; }
}

function saveConfig(config) {
    try { fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4)); return true; }
    catch (e) { return false; }
}

function getMusicDir() {
    const config = getConfig();
    let mPath = config.musicPath || 'musica';
    if (!path.isAbsolute(mPath)) mPath = path.join(__dirname, mPath);
    if (!fs.existsSync(mPath)) try { fs.mkdirSync(mPath, { recursive: true }); } catch (e) { }
    return mPath;
}

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    if (!req.url.includes('/api/health')) console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use(express.static(__dirname));

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('join_user', (email) => { if (email) socket.join(email.trim().toLowerCase()); });
    socket.on('join_admin', () => socket.join('admin_room'));
    socket.on('admin_message', (data) => {
        const { message, target } = data;
        if (target === 'ALL') io.emit('admin_message', { message });
        else io.to(target.trim().toLowerCase()).emit('admin_message', { message });
    });
});

// --- API: PUBLIC UTILS ---
app.get('/api/health', (req, res) => res.json({ status: "alive", version: SERVER_VERSION, uptime: process.uptime() }));
app.get('/api/config', (req, res) => res.json(getConfig()));

app.get('/api/proxy-sync', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("Falta URL");
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        if (fs.existsSync(MUSICA_JSON_PATH)) return res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
        res.status(500).json({ error: e.message });
    }
});

// --- API: AUTH ---
const otpStore = new Map();
function getMailTransporter() {
    const c = getConfig();
    const s = c.emailServer;
    if (s && s.user) return nodemailer.createTransport({ service: s.service || 'gmail', auth: { user: s.user, pass: s.pass }, tls: { rejectUnauthorized: false } });
    return null;
}

app.post('/api/register', (req, res) => {
    const { name, email, phone, deviceId, referralCode } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (row) return res.status(409).json({ error: "Dispositivo ya registrado" });
        const myCode = (name || 'USER').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) + "-" + Math.floor(1000 + Math.random() * 9000);
        db.run("INSERT INTO users (name, email, phone, device_id, last_seen, referral_code, referred_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
            [name, cleanEmail, phone, deviceId, myCode, referralCode], () => {
                io.emit('update_users');
                res.json({ success: true, user: { name, email: cleanEmail, referralCode: myCode } });
            });
    });
});

app.post('/api/auth/request-otp', async (req, res) => {
    const { email } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (!user) return res.status(404).json({ error: "Correo no registrado" });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email, { otp, expires: Date.now() + 300000 });
        const tp = getMailTransporter();
        if (tp) {
            try { await tp.sendMail({ from: `"Soporte" <${getConfig().emailServer.user}>`, to: email, subject: 'Tu Clave TecnoBanda', html: `<h1 style="font-size:3rem; letter-spacing:10px;">${otp}</h1>` }); res.json({ success: true }); }
            catch (e) { res.status(500).json({ error: "Error SMTP" }); }
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
            if (user) res.json({ success: true, user: { name: user.name, email: user.email, referralCode: user.referral_code } });
            else {
                const myCode = "TB-" + Math.random().toString(36).substr(2, 5).toUpperCase();
                db.run("INSERT INTO users (name, email, device_id, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)", ['Usuario', cleanEmail, deviceId, myCode, referralCode], () => {
                    res.json({ success: true, user: { name: 'Usuario', email: cleanEmail, referralCode: myCode } });
                });
            }
        });
    } else res.status(401).json({ error: "Clave incorrecta" });
});

// --- API: LICENSES & PING ---
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
        if (!lic) return res.status(400).json({ error: "Clave inválida o usada" });
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

// --- API: ADMIN --- (FULL MODULES)
app.get('/api/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as total FROM users", (e1, users) => {
        db.get("SELECT COUNT(*) as total FROM activations", (e2, acts) => {
            db.get("SELECT SUM(price_paid) as total FROM activations", (e3, income) => {
                db.all("SELECT * FROM users ORDER BY last_seen DESC LIMIT 10", (e4, recent) => {
                    res.json({ weeklyUsers: users.total, weeklyActivations: acts.total, weeklyIncome: income.total || 0, users: recent });
                });
            });
        });
    });
});

app.get('/api/admin/users', (req, res) => {
    db.all("SELECT u.*, l.type as license_type, l.expires_at FROM users u LEFT JOIN licenses l ON u.email = l.user_email AND u.device_id = l.original_device_id AND l.status = 'USED' ORDER BY u.last_seen DESC", (err, rows) => res.json(rows));
});

app.delete('/api/admin/users/:id', (req, res) => {
    db.get("SELECT email FROM users WHERE id = ?", [req.params.id], (err, user) => {
        if (!user) return res.status(404).json({ error: "No encontrado" });
        db.run("DELETE FROM users WHERE email = ?", [user.email], () => {
            db.run("DELETE FROM licenses WHERE user_email = ?", [user.email]);
            io.to(user.email).emit('force_logout', { message: "Cuenta eliminada" });
            io.emit('update_users');
            res.json({ success: true });
        });
    });
});

app.get('/api/admin/activations', (req, res) => db.all("SELECT * FROM activations ORDER BY timestamp DESC", (err, rows) => res.json(rows)));
app.get('/api/admin/logs', (req, res) => db.all("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100", (err, rows) => res.json(rows)));

app.get('/api/admin/audios/:type', (req, res) => {
    const dir = path.join(UPLOADS_DIR, req.params.type);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav')).map(f => ({ name: f, url: `/uploads/${req.params.type}/${f}` })));
});

// --- API: CONFIG UPDATES ---
app.patch('/api/admin/config', (req, res) => {
    const config = getConfig();
    const updated = { ...config, ...req.body };
    if (saveConfig(updated)) res.json({ success: true });
    else res.status(500).json({ error: "No se pudo guardar config.json" });
});

app.post('/api/admin/licenses/generate', (req, res) => {
    const { type, quantity } = req.body;
    const prefix = type === '1_DAY' ? 'TB-DIA-' : (type === '30_DAYS' ? 'TB-MES-' : 'TB-PERM-');
    for (let i = 0; i < quantity; i++) {
        const key = prefix + Math.random().toString(36).substr(2, 6).toUpperCase() + "-" + Math.random().toString(36).substr(2, 6).toUpperCase();
        db.run("INSERT INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')", [key, type]);
    }
    io.emit('update_licenses');
    res.json({ success: true });
});

// --- PLAYLISTS ---
app.get('/api/playlists', (req, res) => db.all("SELECT * FROM playlists WHERE user_email = ?", [req.query.email], (err, rows) => res.json(rows.map(r => ({ ...r, songs: JSON.parse(r.songs || '[]') })))));
app.post('/api/playlists', (req, res) => {
    db.run("INSERT INTO playlists (user_email, name, songs) VALUES (?, ?, '[]')", [req.body.email, req.body.name], function () { res.json({ id: this.lastID, name: req.body.name, songs: [] }); });
});

// --- VIGILANTE ---
async function updateManifest() {
    try {
        const mDir = getMusicDir(); if (!fs.existsSync(mDir)) return;
        const config = getConfig();
        const files = fs.readdirSync(mDir).filter(f => f.endsWith('.zip') || f.endsWith('.rar'));
        const database = files.map(f => ({
            title: f.replace('.zip', '').replace('.rar', ''),
            artist: "Biblioteca", isCompressed: true,
            archiveFile: `https://${config.endpoint}/file/${config.bucketName}/${encodeURIComponent(f).replace(/%20/g, '+')}`,
            dateAdded: fs.statSync(path.join(mDir, f)).mtime.toISOString()
        }));
        fs.writeFileSync(MUSICA_JSON_PATH, JSON.stringify(database, null, 2));
        io.emit('database_updated', database);
    } catch (e) { }
}

app.get('*', (req, res, next) => { if (req.url.startsWith('/api') || req.url.startsWith('/uploads')) return next(); res.sendFile(path.join(__dirname, 'index.html')); });

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ ULTIMATE UNIFIED SERVER V3.6.0 LIVE ON PORT ${PORT}`);
    updateManifest();
});
