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

const SERVER_VERSION = "5.0.0 (Clean Refresh)";
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

// Configuración de Multer para Audios (Admin)
const audioStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.params.type === 'ambient' ? 'ambient' : 'intros';
        cb(null, path.join(UPLOADS_DIR, type));
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadAudio = multer({ storage: audioStorage });

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
    const mail = config.emailServer || {};
    const user = process.env.SMTP_USER || mail.user;
    const pass = process.env.SMTP_PASS || mail.pass;
    const service = process.env.SMTP_SERVICE || mail.service || 'gmail';

    if (user && pass) {
        return nodemailer.createTransport({
            service: service,
            auth: { user: user, pass: pass },
            tls: { rejectUnauthorized: false }
        });
    }
    return null;
}

function logActivity(action, details) {
    db.run("INSERT INTO audit_logs (action, details, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)", [action, details]);
}

// Ensure Audit Logs table
db.run("CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, details TEXT, admin_user TEXT DEFAULT 'System', created_at TEXT)");
db.run("CREATE TABLE IF NOT EXISTS activations (id INTEGER PRIMARY KEY AUTOINCREMENT, license_key TEXT, device_id TEXT, price_paid REAL, activated_at TEXT DEFAULT CURRENT_TIMESTAMP)");

// --- CORE API ---
app.get('/api/health', (req, res) => res.json({ status: "alive", version: SERVER_VERSION, uptime: Math.floor(process.uptime()) }));
app.get('/api/config', (req, res) => res.json(getConfig()));

// --- AUTH: REQUEST OTP ---
app.post('/api/auth/request-otp', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });
    const cleanEmail = email.toLowerCase().trim();

    db.get("SELECT * FROM users WHERE LOWER(email) = ?", [cleanEmail], async (err, user) => {
        if (!user) return res.status(404).json({ error: "No existe cuenta con este correo" });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(cleanEmail, { otp, expires: Date.now() + 300000 });

        const transporter = getMailTransporter();
        if (transporter) {
            try {
                const config = getConfig();
                const fromName = config.emailServer?.fromName || "TecnoBanda Support";
                const fromEmail = config.emailServer?.user || "soporte@tecnobanda.com";

                await transporter.sendMail({
                    from: `"${fromName}" <${fromEmail}>`,
                    to: cleanEmail,
                    subject: `${otp} es tu clave de acceso`,
                    html: `<h1>Clave: ${otp}</h1><p>Válida por 5 minutos.</p>`
                });
                res.json({ success: true });
            } catch (e) {
                console.error("❌ ERROR SMTP:", e);
                res.status(500).json({ error: "Error de correo. Verifica la clave SMTP." });
            }
        } else {
            console.log(`[DEV-MODE] OTP for ${cleanEmail}: ${otp}`);
            res.json({ success: true, simulated: true });
        }
    });
});

// --- AUTH: VERIFY OTP & LOGIN / REGISTER ---
app.post('/api/auth/verify-otp', (req, res) => {
    const { email, otp, deviceId, referralCode } = req.body;
    const cleanEmail = email?.toLowerCase().trim();
    const stored = otpStore.get(cleanEmail);

    if (stored && stored.otp === otp && stored.expires > Date.now()) {
        otpStore.delete(cleanEmail);

        db.get("SELECT * FROM users WHERE LOWER(email) = ?", [cleanEmail], (err, user) => {
            if (user) {
                // USUARIO EXISTE: Actualizar dispositivo y entrar
                db.run("UPDATE users SET device_id = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?", [deviceId, user.id]);
                res.json({ success: true, user: { name: user.name, email: user.email, phone: user.phone, referralCode: user.referral_code } });
            } else {
                // USUARIO NUEVO (Vía OTP): Validar referido si existe
                handleNewUserRegistration(null, cleanEmail, '', deviceId, referralCode, res);
            }
        });
    } else {
        res.status(401).json({ error: "Clave inválida o expirada" });
    }
});

// --- AUTH: DIRECT REGISTER ---
app.post('/api/register', (req, res) => {
    const { name, email, phone, deviceId, referralCode } = req.body;
    const cleanEmail = email?.toLowerCase().trim();

    db.get("SELECT id FROM users WHERE LOWER(email) = ?", [cleanEmail], (err, user) => {
        if (user) return res.status(409).json({ error: "Este correo ya está registrado" });
        handleNewUserRegistration(name, cleanEmail, phone, deviceId, referralCode, res);
    });
});

// Función compartida para registrar nuevos usuarios
function handleNewUserRegistration(name, email, phone, deviceId, referralCode, res) {
    const finalName = name || 'Usuario';
    const myCode = (finalName || 'USR').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5) + "-" + Math.floor(1000 + Math.random() * 9000);

    const proceed = (refBy) => {
        db.run("INSERT INTO users (name, email, phone, device_id, last_seen, referral_code, referred_by) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)",
            [finalName, email, phone, deviceId, myCode, refBy], function (err) {
                if (err) return res.status(500).json({ error: err.message });
                io.emit('update_users');
                res.json({ success: true, user: { name: finalName, email, phone, referralCode: myCode } });
            });
    };

    if (referralCode && referralCode.trim() !== "") {
        const cleanRef = referralCode.trim().toUpperCase();
        db.get("SELECT id FROM users WHERE UPPER(referral_code) = ?", [cleanRef], (err, row) => {
            if (!row) return res.status(400).json({ error: "El código de referido no es válido" });
            proceed(cleanRef);
        });
    } else {
        proceed(null);
    }
}

// --- CORE FUNCTIONALITY ---
app.post('/api/ping', (req, res) => {
    const { deviceId, email, name } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    const cleanEmail = email.toLowerCase().trim();
    db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (!row) return res.json({ status: "logout" });
        db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
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
        const now = new Date();
        let exp = null;
        if (lic.type === '1_DAY') exp = new Date(now.getTime() + 86400000).toISOString();
        else if (lic.type === '30_DAYS') exp = new Date(now.getTime() + 2592000000).toISOString();
        else exp = new Date(2100, 0, 1).toISOString();
        db.run("UPDATE licenses SET status='USED', user_email=?, expires_at=?, original_device_id=? WHERE key=?",
            [email.toLowerCase(), exp, deviceId, key], () => {
                db.run("INSERT INTO activations (license_key, device_id, price_paid) VALUES (?, ?, ?)", [key, deviceId, 0]);
                io.emit('update_licenses');
                io.emit('update_income');
                res.json({ success: true, type: lic.type, expiresAt: exp });
            });
    });
});

// --- ADMIN API ---
app.get('/api/admin/config', (req, res) => res.json(getConfig()));
app.post('/api/admin/config', (req, res) => {
    if (saveConfig({ ...getConfig(), ...req.body })) {
        io.emit('config_updated');
        res.json({ success: true });
    } else res.status(500).json({ error: "Fail" });
});

app.get('/api/admin/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY last_seen DESC", (err, rows) => res.json(rows || []));
});

app.get('/api/admin/audios/:type', (req, res) => {
    const dir = path.join(UPLOADS_DIR, req.params.type);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav')).map(f => ({ name: f, url: `/uploads/${req.params.type}/${f}` })));
});

app.get('/api/admin/music-library', (req, res) => {
    if (fs.existsSync(MUSICA_JSON_PATH)) res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
    else res.json([]);
});

app.get('*', (req, res, next) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/uploads')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('join_admin', () => socket.join('admin_room'));
    socket.on('join_user', (email) => socket.join(email.toLowerCase().trim()));
});

server.listen(PORT, '0.0.0.0', () => { console.log(`✅ DISCO-SERVER LIVE ON PORT ${PORT}`); });
