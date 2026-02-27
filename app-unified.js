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
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const chokidar = require('chokidar');

const SERVER_VERSION = "5.2.0 (Admin & SMTP Fix)";
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

// Configuración de Multer
const audioStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.params.type === 'ambient' ? 'ambient' : 'intros';
        cb(null, path.join(UPLOADS_DIR, type));
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const uploadAudio = multer({ storage: audioStorage });

function getMusicDir() {
    const config = getConfig();
    let mPath = config.musicPath || 'musica';
    if (!path.isAbsolute(mPath)) mPath = path.join(__dirname, mPath);
    if (!fs.existsSync(mPath)) fs.mkdirSync(mPath, { recursive: true });
    return mPath;
}

const musicStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, getMusicDir()),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const musicUpload = multer({ storage: musicStorage });

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

    const user = (process.env.SMTP_USER && process.env.SMTP_USER.trim() !== "") ? process.env.SMTP_USER : mail.user;
    const pass = (process.env.SMTP_PASS && process.env.SMTP_PASS.trim() !== "") ? process.env.SMTP_PASS : mail.pass;
    const service = (process.env.SMTP_SERVICE && process.env.SMTP_SERVICE.trim() !== "") ? process.env.SMTP_SERVICE : (mail.service || 'gmail');

    if (user && pass) {
        // Debug: Log masked credentials
        const masked = pass.length > 6 ? `${pass.substring(0, 3)}...${pass.substring(pass.length - 3)}` : "***";
        console.log(`[SMTP] Conectando con: ${user} | Pass: ${masked}`);

        return nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 465,
            secure: true,
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

// --- DATABASE LOCAL (Para que la app pueda usar el servidor como fuente directa) ---
app.get('/api/musica', (req, res) => {
    if (fs.existsSync(MUSICA_JSON_PATH)) {
        res.json(JSON.parse(fs.readFileSync(MUSICA_JSON_PATH, 'utf8')));
    } else {
        res.json([]);
    }
});

// --- PROXY SYNC (Para evitar CORS en la base de datos de música) ---
app.get('/api/proxy-sync', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "URL requerida" });
    try {
        const response = await fetch(targetUrl, {
            headers: { 'User-Agent': 'TecnoBanda-Server/5.0' }
        });
        if (!response.ok) throw new Error(`Fallo al obtener DB (Status: ${response.status})`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error("❌ ERROR PROXY-SYNC:", e.message);
        res.status(500).json({ error: "No se pudo sincronizar la base de datos", details: e.message });
    }
});

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
                db.run("UPDATE users SET device_id = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?", [deviceId, user.id]);
                res.json({ success: true, user: { name: user.name, email: user.email, phone: user.phone, referralCode: user.referral_code } });
            } else {
                handleNewUserRegistration(null, cleanEmail, '', deviceId, referralCode, res);
            }
        });
    } else {
        res.status(401).json({ error: "Clave inválida o expirada" });
    }
});

app.post('/api/register', (req, res) => {
    const { name, email, phone, deviceId, referralCode } = req.body;
    const cleanEmail = email?.toLowerCase().trim();

    db.get("SELECT id FROM users WHERE LOWER(email) = ?", [cleanEmail], (err, user) => {
        if (user) return res.status(409).json({ error: "Este correo ya está registrado" });
        handleNewUserRegistration(name, cleanEmail, phone, deviceId, referralCode, res);
    });
});

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
    const { deviceId, email } = req.body;
    if (!email || !deviceId) return res.json({ status: "logout" });
    const cleanEmail = email.toLowerCase().trim();
    db.get("SELECT * FROM users WHERE LOWER(email) = ? AND device_id = ?", [cleanEmail, deviceId], (err, row) => {
        if (!row) return res.json({ status: "logout" });
        db.run("UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
        db.get("SELECT * FROM licenses WHERE LOWER(user_email) = ? AND original_device_id = ? AND status='USED' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) ORDER BY expires_at DESC LIMIT 1",
            [cleanEmail, deviceId], (err, lic) => {
                res.json({
                    status: lic ? "active" : "inactive",
                    type: lic?.type,
                    expiresAt: lic?.expires_at,
                    pendingGifts: row.pending_gifts || 0
                });
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
                // --- Lógica de Referidos ---
                handleReferralPoint(email);

                db.run("INSERT INTO activations (license_key, device_id, price_paid) VALUES (?, ?, ?)", [key, deviceId, 0]);
                io.emit('update_licenses');
                io.emit('update_income');
                res.json({ success: true, type: lic.type, expiresAt: exp });
            });
    });
});

// --- ADMIN API: LICENSES ---
app.post('/api/admin/generate', (req, res) => {
    const { type, count } = req.body;
    const qty = count || 1;
    const keys = [];
    const stmt = db.prepare("INSERT INTO licenses (key, type, status) VALUES (?, ?, 'UNUSED')");
    for (let i = 0; i < qty; i++) {
        const key = `TB-${type === 'PERMANENT' ? 'PERM' : type === '30_DAYS' ? 'MES' : 'DIA'}-${Math.random().toString(36).substr(2, 6).toUpperCase()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
        keys.push(key);
        stmt.run(key, type);
    }
    stmt.finalize();
    io.emit('update_licenses');
    res.json({ message: `${qty} keys generated`, keys });
});

app.get('/api/admin/active-licenses', (req, res) => {
    db.all(`SELECT l.*, u.name as user_name FROM licenses l LEFT JOIN users u ON l.user_email = u.email AND l.original_device_id = u.device_id ORDER BY l.created_at DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.delete('/api/admin/licenses/:key', (req, res) => {
    db.run("DELETE FROM licenses WHERE key = ?", [req.params.key], () => {
        io.emit('update_licenses');
        res.json({ success: true });
    });
});

// --- ADMIN API: CONFIG ---
app.get('/api/admin/config', (req, res) => {
    res.json(getConfig());
});

app.post('/api/admin/config', (req, res) => {
    const config = getConfig();
    // Deep merge limited to one level for key objects
    const newConfig = { ...config, ...req.body };

    if (req.body.emailServer) {
        newConfig.emailServer = { ...(config.emailServer || {}), ...req.body.emailServer };
    }
    if (req.body.prices) {
        newConfig.prices = { ...(config.prices || {}), ...req.body.prices };
    }

    if (saveConfig(newConfig)) {
        console.log("[Config] Ajustes guardados correctamente.");
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "No se pudo guardar la configuración" });
    }
});

// --- ADMIN API: USERS ---
app.get('/api/admin/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY last_seen DESC", (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users/edit', (req, res) => {
    const { id, name, email, phone } = req.body;
    db.run("UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?", [name, email.toLowerCase().trim(), phone, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('update_users');
        res.json({ success: true });
    });
});

app.delete('/api/admin/users/:id', (req, res) => {
    db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        io.emit('update_users');
        res.json({ success: true });
    });
});

// --- ADMIN API: STATS & HISTORY ---
app.get('/api/admin/stats', (req, res) => {
    const stats = {};
    // This is a simplified version of stats
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        stats.totalUsers = row ? row.count : 0;
        db.get("SELECT COUNT(*) as count FROM licenses WHERE status='USED'", (err, row) => {
            stats.weeklyActivations = row ? row.count : 0; // Simplified to total for now
            db.get("SELECT SUM(price_paid) as sum FROM activations", (err, row) => {
                stats.weeklyIncome = row ? row.sum || 0 : 0;
                db.all("SELECT * FROM users ORDER BY registered_at DESC LIMIT 10", (err, users) => {
                    stats.users = users || [];
                    stats.weeklyUsers = users.length; // Simplified
                    res.json(stats);
                });
            });
        });
    });
});

app.get('/api/admin/history', (req, res) => {
    db.all(`SELECT a.*, l.type as license_type, u.name as user_name, u.email as user_email 
            FROM activations a 
            JOIN licenses l ON a.license_key = l.key 
            LEFT JOIN users u ON l.user_email = u.email 
            ORDER BY a.activated_at DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

// --- ADMIN API: KEY MANAGEMENT ---
app.post('/api/admin/licenses/revoke', (req, res) => {
    const { deviceId } = req.body;
    db.run("UPDATE licenses SET status = 'REVOKED' WHERE original_device_id = ?", [deviceId], (err) => {
        io.emit('update_licenses');
        res.json({ success: true });
    });
});

app.delete('/api/admin/licenses-all/unused', (req, res) => {
    db.run("DELETE FROM licenses WHERE status = 'UNUSED'", (err) => {
        io.emit('update_licenses');
        res.json({ success: true });
    });
});

// --- ADMIN API: MUSIC & AUDIOS ---
app.get('/api/admin/music-library', (req, res) => {
    const mDir = getMusicDir();
    if (!fs.existsSync(mDir)) return res.json([]);
    const files = fs.readdirSync(mDir).filter(f => f.toLowerCase().endsWith('.zip') || f.toLowerCase().endsWith('.rar') || f.toLowerCase().endsWith('.mp3'));
    res.json(files.map(f => {
        const stats = fs.statSync(path.join(mDir, f));
        return {
            name: f,
            size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
            size_bytes: stats.size,
            date: stats.mtime
        };
    }));
});

// -- Music Library Management --
app.post('/api/admin/music-library/upload', musicUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });
    logActivity('Librería', `Subida: ${req.file.originalname}`);
    res.json({ success: true });
});

app.delete('/api/admin/music-library/:filename', (req, res) => {
    const mDir = getMusicDir();
    const file = path.join(mDir, req.params.filename);
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logActivity('Librería', `Eliminado: ${req.params.filename}`);
        res.json({ success: true });
    } else res.status(404).json({ error: "Archivo no encontrado" });
});

app.post('/api/admin/music-library/sync', async (req, res) => {
    try {
        await updateManifest();
        res.json({ success: true, message: "Sincronización manual iniciada" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/music-library/rename', (req, res) => {
    const mDir = getMusicDir();
    const { oldName, newName } = req.body;
    const oldP = path.join(mDir, oldName);
    const newP = path.join(mDir, newName);
    if (fs.existsSync(oldP)) {
        fs.renameSync(oldP, newP);
        logActivity('Librería', `Renombrado: ${oldName} -> ${newName}`);
        res.json({ success: true });
    } else res.status(404).json({ error: "Archivo no encontrado" });
});

// -- Audio Management (Intros/Ambient) --
app.get('/api/admin/audios/:type', (req, res) => {
    const dir = path.join(UPLOADS_DIR, req.params.type);
    if (!fs.existsSync(dir)) return res.json([]);
    res.json(fs.readdirSync(dir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav')).map(f => ({ name: f, url: `/uploads/${req.params.type}/${f}` })));
});

app.post('/api/admin/audios/:type', uploadAudio.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });
    res.json({ success: true, name: req.file.filename, url: `/uploads/${req.params.type}/${req.file.filename}` });
});

app.delete('/api/admin/audios/:type/:filename', (req, res) => {
    const { type, filename } = req.params;
    const filePath = path.join(UPLOADS_DIR, type, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } else res.status(404).json({ error: "Archivo no encontrado" });
});

// -- Audit Logs --
app.get('/api/admin/audit-logs', (req, res) => {
    db.all("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200", (err, rows) => {
        res.json(rows || []);
    });
});

// --- PLAYLISTS ---
app.get('/api/playlists', (req, res) => {
    const { email } = req.query;
    db.all("SELECT * FROM playlists WHERE user_email = ? ORDER BY updated_at DESC", [email], (err, rows) => {
        res.json((rows || []).map(r => ({ ...r, songs: JSON.parse(r.songs || '[]') })));
    });
});
app.post('/api/playlists', (req, res) => {
    const { email, name } = req.body;
    db.run("INSERT INTO playlists (user_email, name, songs) VALUES (?, ?, '[]')", [email, name], function () {
        res.json({ id: this.lastID, name, songs: [] });
    });
});
app.patch('/api/playlists/:id', (req, res) => {
    const { name, songs } = req.body;
    db.run("UPDATE playlists SET name = COALESCE(?, name), songs = COALESCE(?, songs), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [name, songs ? JSON.stringify(songs) : null, req.params.id], () => res.json({ success: true }));
});
app.delete('/api/playlists/:id', (req, res) => {
    db.run("DELETE FROM playlists WHERE id = ?", [req.params.id], () => res.json({ success: true }));
});

// --- GIFTS & REFERRALS API ---
app.get('/api/users/gifts', (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email requerido" });
    db.get("SELECT pending_gifts FROM users WHERE LOWER(email) = ?", [email.toLowerCase().trim()], (err, user) => {
        res.json({ pendingGifts: user ? user.pending_gifts : 0 });
    });
});

app.post('/api/users/gifts/claim', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email requerido" });
    const cleanEmail = email.toLowerCase().trim();

    db.get("SELECT pending_gifts FROM users WHERE LOWER(email) = ?", [cleanEmail], (err, user) => {
        if (err) return res.status(500).json({ error: "Error al obtener datos del usuario" });
        if (!user || user.pending_gifts <= 0) return res.status(400).json({ error: "No tienes regalos pendientes para reclamar" });

        // Decrement pending_gifts and generate a new 1-day license
        db.run("UPDATE users SET pending_gifts = pending_gifts - 1 WHERE LOWER(email) = ?", [cleanEmail], async function (err) {
            if (err) return res.status(500).json({ error: "Error al actualizar regalos pendientes" });

            const key = `GIFT-1D-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
            db.run("INSERT INTO licenses (key, type, status) VALUES (?, '1_DAY', 'UNUSED')", [key], async function (err) {
                if (err) {
                    db.run("UPDATE users SET pending_gifts = pending_gifts + 1 WHERE LOWER(email) = ?", [cleanEmail]);
                    return res.status(500).json({ error: "Error al generar la licencia de regalo" });
                }

                // --- Enviar Correo con el Regalo ---
                const transporter = getMailTransporter();
                if (transporter) {
                    try {
                        const config = getConfig();
                        const fromName = config.emailServer?.fromName || "TecnoBanda Regalos";
                        const fromEmail = config.emailServer?.user;
                        await transporter.sendMail({
                            from: `"${fromName}" <${fromEmail}>`,
                            to: cleanEmail,
                            subject: "¡Felicidades! Aquí tienes tu Licencia de Regalo 🎁",
                            html: `
                                <div style="font-family: sans-serif; padding: 20px; text-align: center;">
                                    <h1 style="color: #FFD700;">¡Felicidades! 🎉</h1>
                                    <p>Has ganado este regalo por referir amigos a TecnoBanda.</p>
                                    <div style="background: #f4f4f4; padding: 15px; border-radius: 10px; margin: 20px 0;">
                                        <p style="font-size: 0.9rem; color: #666; margin-bottom: 5px;">Tu código de activación:</p>
                                        <h2 style="letter-spacing: 2px; color: #333; margin: 0;">${key}</h2>
                                    </div>
                                    <p>Este código te otorga <b>1 DÍA GRATIS</b> de acceso Premium.</p>
                                    <p style="font-size: 0.8rem; color: #888;">Cópialo y actívalo desde el menú de la aplicación.</p>
                                </div>
                            `
                        });
                        console.log(`[Regalo] Email enviado con éxito a ${cleanEmail}`);
                    } catch (e) { console.error("❌ ERROR SMTP REGALO:", e); }
                }

                io.emit('update_licenses');
                io.to(cleanEmail).emit('new_gift', { message: "¡Has reclamado una licencia de regalo!", key: key });
                res.json({ success: true, key: key });
            });
        });
    });
});

// ==========================================
// INTEGRACIÓN VIGILANTE (B2 Sync)
// ==========================================
let watcher = null;

function getS3Client() {
    const config = getConfig();
    const endpoint = config.s3Endpoint ? `https://${config.s3Endpoint}` : 'https://s3.us-west-004.backblazeb2.com';
    return new S3Client({
        endpoint: endpoint,
        region: "us-west-004",
        credentials: {
            accessKeyId: config.b2KeyId || process.env.B2_KEY_ID || '004c11eb0fc379b0000000001',
            secretAccessKey: config.b2AppKey || process.env.B2_APP_KEY || 'K004VoxaMYYqfp/vO+i/CU19ItjipRk'
        }
    });
}

async function uploadToB2(filePath, fileName) {
    try {
        const config = getConfig();
        const bucket = config.bucketName || 'tecnobanda';
        const fileContent = fs.readFileSync(filePath);
        const s3Client = getS3Client();
        await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: fileName,
            Body: fileContent,
            ACL: 'public-read'
        }));
        console.log(`[Vigilante] Sincronizado: ${fileName} -> ${bucket}`);
    } catch (err) { console.error(`[Vigilante] Error subiendo ${fileName}:`, err); }
}

async function updateManifest() {
    try {
        const config = getConfig();
        const mDir = getMusicDir();
        if (!fs.existsSync(mDir)) return;

        const b2Domain = config.endpoint || 'f004.backblazeb2.com';
        const bucket = config.bucketName || 'tecnobanda';

        // Soportar Karaoke (zip/rar) y Música/Videos (mp3/mp4/mkv/avi)
        const extensions = ['.zip', '.rar', '.mp3', '.mp4', '.mkv', '.avi'];
        const files = fs.readdirSync(mDir).filter(f => extensions.some(ext => f.toLowerCase().endsWith(ext)));

        console.log(`[Vigilante] Generando base de datos para ${files.length} archivos...`);

        let database = files.map(f => {
            const stats = fs.statSync(path.join(mDir, f));
            let artist = "Desconocido", title = f.replace(/\.(zip|rar|mp3|mp4|mkv|avi)$/i, '');
            if (f.includes(' - ')) { const parts = title.split(' - '); artist = parts[0]; title = parts[1]; }

            const isCompressed = f.toLowerCase().endsWith('.zip') || f.toLowerCase().endsWith('.rar');

            return {
                title,
                artist,
                isCompressed: isCompressed,
                archiveFile: `https://${b2Domain}/file/${bucket}/${encodeURIComponent(f).replace(/%20/g, '+')}`,
                dateAdded: stats.mtime.toISOString()
            };
        });
        database.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
        fs.writeFileSync(MUSICA_JSON_PATH, JSON.stringify(database, null, 2));
        await uploadToB2(MUSICA_JSON_PATH, 'musica.json');
        io.emit('database_updated', database);
    } catch (e) { console.error('[Vigilante] Error manifest:', e); }
}

function startVigilante() {
    const mDir = getMusicDir();
    if (watcher) watcher.close();
    watcher = chokidar.watch(mDir, { ignoreInitial: true, persistent: true, awaitWriteFinish: true });
    watcher.on('add', () => updateManifest()).on('unlink', () => updateManifest());
    updateManifest();
}

app.get('*', (req, res, next) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/uploads')) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    socket.on('join_admin', () => socket.join('admin_room'));
    socket.on('join_user', (email) => {
        const userRoom = email.toLowerCase().trim();
        socket.join(userRoom);
        console.log(`[Socket] User joined room: ${userRoom}`);
    });

    // --- RECEPTOR DE MENSAJES DEL ADMIN ---
    socket.on('admin_message', (data) => {
        const { target, message } = data;
        console.log(`[Messenger] Admin -> ${target}: ${message}`);

        if (target === 'ALL') {
            // Enviar a todos los conectados
            io.emit('admin_message', { message, timestamp: new Date().toISOString() });
        } else {
            // Enviar a un usuario específico (por su sala de email)
            const userRoom = target.toLowerCase().trim();
            io.to(userRoom).emit('admin_message', { message, timestamp: new Date().toISOString() });
        }
    });
});

// --- REFERRALS LOGIC ---
async function handleReferralPoint(userEmail) {
    const cleanEmail = userEmail ? userEmail.trim().toLowerCase() : '';
    // Buscamos quién invitó a este correo (solo una vez)
    db.get("SELECT id, referred_by FROM users WHERE LOWER(email) = ? AND referred_by IS NOT NULL AND referred_by != '' LIMIT 1", [cleanEmail], (err, user) => {
        if (user && user.referred_by) {
            const padrinoCode = user.referred_by.trim();
            // Limpia vínculo para que solo dé 1 punto la primera vez (en todas las filas de este usuario child)
            db.run("UPDATE users SET referred_by = NULL WHERE LOWER(email) = ?", [cleanEmail], () => {
                // Buscamos al padrino (puede tener múltiples filas por dispositivo, tomamos una para ver puntos)
                db.get("SELECT email, referral_points FROM users WHERE UPPER(referral_code) = UPPER(?) LIMIT 1", [padrinoCode], (err, padrino) => {
                    if (padrino) {
                        const padrinoEmail = padrino.email.trim().toLowerCase();
                        const newPoints = (padrino.referral_points || 0) + 1;
                        const config = getConfig();
                        const meta = config.referralMeta || 5;

                        if (newPoints >= meta) {
                            // IMPORTANTE: Aquí solo marcamos el regalo pendiente.
                            // No generamos la licencia aquí para evitar duplicados.
                            // El usuario la generará al hacer clic en el regalo en su pantalla.
                            db.run("UPDATE users SET referral_points = 0, pending_gifts = pending_gifts + 1 WHERE LOWER(email) = ?", [padrinoEmail]);
                            console.log(`[Referidos] Padrino ${padrinoEmail} llegó a la meta. Regalo disponible.`);
                        } else {
                            db.run("UPDATE users SET referral_points = ? WHERE LOWER(email) = ?", [newPoints, padrinoEmail]);
                        }
                        io.emit('update_users');
                        console.log(`[Referidos] Padrino ${padrinoEmail} recibió 1 punto. Total: ${newPoints}/${meta}`);
                    }
                });
            });
        }
    });
}

async function generateGiftLicense(email) {
    const key = `GIFT-1D-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    db.run("INSERT INTO licenses (key, type, status) VALUES (?, '1_DAY', 'UNUSED')", [key], () => {
        console.log(`[Referidos] Regalo generado para ${email}: ${key}`);
        io.to(email).emit('new_gift', { message: "¡Has ganado una licencia de regalo!" });
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ DISCO-SERVER LIVE ON PORT ${PORT}`);
    startVigilante();
});
