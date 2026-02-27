const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Determinar ruta de base de datos (Prioriza carpeta persistente /data)
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}

let dbPath = path.join(DATA_DIR, 'licenses.db');

// Migración automática: Si existe en la raíz pero no en /data, moverlo
const oldPath = path.join(__dirname, 'licenses.db');
if (fs.existsSync(oldPath) && !fs.existsSync(dbPath)) {
    console.log("🚚 Migrando base de datos a carpeta persistente...");
    try { fs.renameSync(oldPath, dbPath); } catch (e) { dbPath = oldPath; }
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log(`✅ Base de Datos activa en: ${dbPath}`);
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        // Users Table - FIXED: Removed UNIQUE constraint from device_id
        // Now email is the primary identifier, allowing multiple users per device
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            email TEXT UNIQUE NOT NULL,
            phone TEXT,
            device_id TEXT,
            ip_address TEXT,
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_seen DATETIME
        )`);

        // Licenses Table - FIXED: Licenses tied to email AND original device
        db.run(`CREATE TABLE IF NOT EXISTS licenses (
            key TEXT PRIMARY KEY,
            type TEXT, -- '1_DAY', '30_DAYS', 'PERMANENT'
            status TEXT DEFAULT 'UNUSED', -- 'UNUSED', 'USED'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            used_by_device TEXT,
            user_email TEXT,
            expires_at DATETIME,
            last_device_check DATETIME,
            original_device_id TEXT,
            FOREIGN KEY(user_email) REFERENCES users(email)
        )`);

        // Activations Log (Optional history)
        db.run(`CREATE TABLE IF NOT EXISTS activations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key TEXT,
            device_id TEXT,
            activated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Audit Logs Table
        db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT,
            details TEXT,
            admin_user TEXT DEFAULT 'Admin',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Playlists Table - Tied to user email
        db.run(`CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL,
            name TEXT NOT NULL,
            songs TEXT DEFAULT '[]', -- JSON string of song objects
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_email) REFERENCES users(email)
        )`);

        // Migration helper
        const migrate = (sql, label) => {
            db.run(sql, (err) => {
                if (err) {
                    if (err.message.includes("duplicate column name")) return;
                    console.error(`[DB Migration] ❌ Error in ${label}:`, err.message);
                } else {
                    console.log(`[DB Migration] ✅ Success: ${label}`);
                }
            });
        };

        migrate("ALTER TABLE licenses ADD COLUMN user_email TEXT", "licenses.user_email");
        migrate("ALTER TABLE users ADD COLUMN ip_address TEXT", "users.ip_address");
        migrate("ALTER TABLE licenses ADD COLUMN last_device_check DATETIME", "licenses.last_device_check");
        migrate("ALTER TABLE licenses ADD COLUMN original_device_id TEXT", "licenses.original_device_id");
        migrate("ALTER TABLE activations ADD COLUMN price_paid REAL DEFAULT 0", "activations.price_paid");
        migrate("ALTER TABLE users ADD COLUMN referral_code TEXT", "users.referral_code");
        migrate("ALTER TABLE users ADD COLUMN referred_by TEXT", "users.referred_by");
        migrate("ALTER TABLE users ADD COLUMN referral_points INTEGER DEFAULT 0", "users.referral_points");
        migrate("ALTER TABLE users ADD COLUMN pending_gifts INTEGER DEFAULT 0", "users.pending_gifts");
        migrate("ALTER TABLE users ADD COLUMN total_gifts INTEGER DEFAULT 0", "users.total_gifts");

        // Ensure all users have a referral code
        generateMissingReferralCodes();

        console.log("Database initialized and migrations checked.");
    });
}

function generateMissingReferralCodes() {
    db.all("SELECT id, name FROM users WHERE referral_code IS NULL", (err, rows) => {
        if (err) return;
        rows.forEach(user => {
            const code = generateReferralCode(user.name);
            db.run("UPDATE users SET referral_code = ? WHERE id = ?", [code, user.id]);
        });
    });
}

function generateReferralCode(name) {
    const base = (name || 'USER').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5);
    const random = Math.floor(1000 + Math.random() * 9000);
    return `${base}-${random}`;
}

module.exports = db;
