const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const db = require('./database');
const multer = require('multer');

const SERVER_VERSION = "4.8.0 (The God-Mode Sync)";
const PORT = process.env.PORT || 3000;
const otpStore = new Map();

console.log(`\n=========================================`);
console.log(`🚀 UNIFIED CLOUD SERVER v${SERVER_VERSION}`);
console.log(`=========================================\n`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MUSICA_JSON_PATH = path.join(__dirname, 'musica.json');
[UPLOADS_DIR, path.join(UPLOADS_DIR, 'intros'), path.join(UPLOADS_DIR, 'ambient')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/admin', express.static(path.join(__dirname, 'admin')));
app.use('/uploads', express.static(UPLOADS_DIR));

function getConfig() {
    try {
        const p = path.join(__dirname, 'config.json');
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    } catch (e) { return {}; }
}

function saveConfig(config) {
    try { fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 4)); return true; }
    catch (e) { return false; }
}

function getMailTransporter() {
    const config = getConfig();
    const mail = config.emailServer;
    if (mail && mail.user && mail.pass) {
        return nodemailer.createTransport({
            service: mail.service || 'gmail',
            auth: { user: mail.user, pass: mail.pass },
            tls: { rejectUnauthorized: false }
        });
    }
    return null;
}

function logActivity(action, details) {
    db.run("INSERT INTO audit_logs (action, details) VALUES (?, ?)", [action, details]);
}

// --- CORE API ---
app.get('/api/health', (req, res) => res.json({ status: "alive", version: SERVER_VERSION, uptime: Math.floor(process.uptime()) }));
app.get('/api/config', (req, res) => res.json(getConfig()));

// --- AUTH & PING ---
app.post('/api/auth/request-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });
    const cleanEmail = email.toLowerCase().trim();
    db.get("SELECT * FROM users WHERE LOWER(email) = ?", [cleanEmail], async (err, user) => {
        if (!user) return res.status(404).json({ error: "Registro no encontrado con ese correo" });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(cleanEmail, { otp, expires: Date.now() + 300000 });
        const transporter = getMailTransporter();
        if (transporter) {
            try {
                await transporter.sendMail({
                    from: `"TecnoBanda Support" <${getConfig().emailServer.user}>`,
                    to: cleanEmail,
                    subject: 'Tu Clave de Acceso',
                    html: `<h1>Clave: ${otp}</h1><p>Válida por 5 minutos.</p>`
                });
                res.json({ success: true });
            } catch (e) { res.status(500).json({ error: "Error SMTP (revisa configuración en Admin)" }); }
        } else {
            console.log(`[SIMULATED-OTP] Email: ${cleanEmail} -> Code: ${otp}`);
            res.json({ success: true, simulated: true });
        }
    });
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp, deviceId, referralCode } = req.body;
    const cleanEmail = email?.toLowerCase().trim();
    const stored = otpStore.get(cleanEmail);
    if (stored && stored.otp === otp && stored.expires > Date.now()) {
        otpStore.delete(cleanEmail);
        db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, user) => {
            if (user) {
                res.json({ success: true, user: { name: user.name, email: user.email, phone: user.phone, referralCode: user.referral_code } });
            } else {
                db.get("SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1", [cleanEmail], (err, existing) => {
                    const name = existing?.name || 'Usuario';
                    const phone = existing?.phone || '';
                    const myCode = (name || 'USR').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5) + "-" + Math.floor(1000 + Math.random() * 9000);
                    db.run("INSERT INTO users (name, email, phone, device_id, last_seen, referral_code, referred_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
                        [name, cleanEmail, phone, deviceId, myCode, referralCode], () => {
                            res.json({ success: true, user: { name, email: cleanEmail, phone, referralCode: myCode } });
                        });
                });
            }
        });
    } else res.status(401).json({ error: "Clave inválida o expirada" });
});

app.post('/api/register', (req, res) => {
    const { name, email, phone, deviceId, referralCode } = req.body;
    const cleanEmail = email?.toLowerCase().trim();
    db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, exists) => {
        if (exists) return res.status(409).json({ error: "Este dispositivo ya está registrado" });
        const myCode = (name || 'USR').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5) + "-" + Math.floor(1000 + Math.random() * 9000);
        db.run("INSERT INTO users (name, email, phone, device_id, last_seen, referral_code, referred_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
            [name, cleanEmail, phone, deviceId, myCode, referralCode], () => {
                res.json({ success: true, user: { name, email: cleanEmail, phone, referralCode: myCode } });
            });
    });
});

app.post('/api/ping', (req, res) => {
    const { deviceId, email, name } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    const cleanEmail = email.toLowerCase().trim();
    db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (!row) {
            db.run("INSERT OR IGNORE INTO users (name, email, device_id, last_seen) VALUES (?, ?, ?, CURRENT_TIMESTAMP)", [name || 'Usuario', cleanEmail, deviceId]);
        } else db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        db.get("SELECT * FROM licenses WHERE LOWER(user_email) = ? AND original_device_id = ? AND status='USED' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY expires_at DESC LIMIT 1",
            [cleanEmail, deviceId], (err, lic) => {
                res.json({ status: lic ? "active" : "inactive", type: lic?.type, expiresAt: lic?.expires_at });
            });
    });
});

app.post('/api/activate', (req, res) => {
    const { key, deviceId, email } = req.body;
    db.get("SELECT * FROM licenses WHERE key = ? AND status='UNUSED'", [key], (err, lic) => {
        if (!lic) return res.status(400).json({ error: "Llave inválida" });
        let exp = null; const now = new Date();
        if (lic.type === '1_DAY') exp = new Date(now.getTime() + 86400000).toISOString();
        else if (lic.type === '30_DAYS') exp = new Date(now.getTime() + 2592000000).toISOString();
        else exp = new Date(2100, 0, 1).toISOString();
        db.run("UPDATE licenses SET status='USED', user_email=?, expires_at=?, original_device_id=? WHERE key=?",
            [email.toLowerCase(), exp, deviceId, key], () => {
                db.run("INSERT INTO activations (license_key, device_id, price_paid) VALUES (?, ?, ?)", [key, deviceId, 0]);
                res.json({ success: true, type: lic.type, expiresAt: exp });
            });
    });
});

// --- USER PROFILE & PLAYLISTS ---
app.patch('/api/users/profile', (req, res) => {
    const { email, deviceId, name, phone } = req.body;
    db.run("UPDATE users SET name = ?, phone = ?, last_seen = CURRENT_TIMESTAMP WHERE LOWER(email) = ? AND device_id = ?",
        [name, phone, email.toLowerCase(), deviceId], function (err) {
            res.json({ success: !err });
        });
});

app.get('/api/playlists', (req, res) => {
    db.all("SELECT * FROM playlists WHERE LOWER(user_email) = ?", [req.query.email?.toLowerCase()], (err, rows) => {
        res.json(rows.map(r => ({ ...r, songs: r.songs ? JSON.parse(r.songs) : [] })));
    });
});

app.post('/api/playlists', (req, res) => {
    const { email, name } = req.body;
    db.run("INSERT INTO playlists (user_email, name, songs) VALUES (?, ?, '[]')", [email.toLowerCase(), name], function (err) {
        res.json({ id: this.lastID, name: name, songs: [] });
    });
});

app.patch('/api/playlists/:id', (req, res) => {
    const { id } = req.params;
    const { name, songs } = req.body;
    if (name !== undefined) db.run("UPDATE playlists SET name = ? WHERE id = ?", [name, id]);
    if (songs !== undefined) db.run("UPDATE playlists SET songs = ? WHERE id = ?", [JSON.stringify(songs), id]);
    res.json({ success: true });
});

// --- ADMIN API ---
app.get('/api/admin/config', (req, res) => res.json(getConfig()));
app.post('/api/admin/config', (req, res) => {
    if (saveConfig({ ...getConfig(), ...req.body })) res.json({ success: true }); else res.status(500).json({ error: "Fail" });
});

app.get('/api/admin/users', (req, res) => {
    db.all("SELECT u.*, l.type as license_type, l.expires_at FROM users u LEFT JOIN licenses l ON LOWER(u.email) = LOWER(l.user_email) AND u.device_id = l.original_device_id AND l.status='USED' ORDER BY u.last_seen DESC", (err, rows) => res.json(rows || []));
});

app.get('/api/admin/stats', (req, res) => {
    db.get("SELECT COUNT(*) as u, (SELECT SUM(price_paid) FROM activations) as i FROM users", (e, row) => {
        res.json({ totalUsers: row?.u || 0, weeklyUsers: row?.u || 0, weeklyIncome: row?.i || 0 });
    });
});

app.get('/api/admin/active-licenses', (req, res) => db.all("SELECT * FROM licenses ORDER BY status DESC", (err, rows) => res.json(rows || [])));

app.post('/api/admin/generate', (req, res) => {
    const { type, count } = req.body;
    const keys = [];
    for (let i = 0; i < (count || 1); i++) {
        const key = "TB-" + Math.random().toString(36).substr(2, 9).toUpperCase();
        db.run("INSERT INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')", [key, type]);
        keys.push(key);
    }
    res.json({ success: true, keys });
});

app.get('/api/proxy-sync', async (req, res) => {
    try { const r = await fetch(req.query.url); res.json(await r.json()); } catch (e) {
        if (fs.existsSync(MUSICA_JSON_PATH)) res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
        else res.status(500).json({ error: "Offline" });
    }
});

server.listen(PORT, '0.0.0.0', () => { console.log(`✅ ULTIMATE SERVER ${SERVER_VERSION} LIVE ON PORT ${PORT}`); });
