const crypto = require("crypto");

function md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
}

async function ensureSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(30) NOT NULL DEFAULT 'viewer'
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audits (
            id INT AUTO_INCREMENT PRIMARY KEY,
            standard VARCHAR(50) NOT NULL DEFAULT 'iso42001',
            clause VARCHAR(100) NOT NULL,
            status VARCHAR(50) NOT NULL,
            evidence TEXT NOT NULL,
            evidence_file VARCHAR(255) NULL,
            notes TEXT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_delete_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            standard VARCHAR(50) NOT NULL,
            clause VARCHAR(100) NOT NULL,
            status VARCHAR(50) NOT NULL,
            evidence TEXT NULL,
            evidence_file VARCHAR(255) NULL,
            notes TEXT NULL,
            record_created_at DATETIME NULL,
            record_updated_at DATETIME NULL,
            deleted_by VARCHAR(255) NULL,
            deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.execute(
        "INSERT INTO users (email, password, role) VALUES (?, ?, 'admin') ON DUPLICATE KEY UPDATE role = 'admin'",
        ["admin@test.com", md5("12345")]
    );
}

module.exports = { ensureSchema, md5 };
