const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config();

function now() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

class JsonPool {
    constructor() {
        this.file = process.env.DATA_FILE || path.resolve(__dirname, "..", "data", "audit-db.json");
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.data = this.load();
    }

    load() {
        if (!fs.existsSync(this.file)) {
            return {
                users: [],
                audits: [],
                audit_delete_history: [],
                counters: { users: 1, audits: 1, audit_delete_history: 1 }
            };
        }
        return JSON.parse(fs.readFileSync(this.file, "utf8"));
    }

    save() {
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }

    nextId(table) {
        const id = this.data.counters[table] || 1;
        this.data.counters[table] = id + 1;
        return id;
    }

    async query(sql) {
        const text = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (text.startsWith("create table")) return [[]];

        if (text.includes("from audits a inner join")) {
            const latest = new Map();
            for (const row of this.data.audits) {
                const key = `${row.standard}:${row.clause}`;
                if (!latest.has(key) || latest.get(key).id < row.id) latest.set(key, row);
            }
            const limitMatch = text.match(/limit\s+(\d+)/);
            let rows = Array.from(latest.values()).sort((a, b) => b.id - a.id);
            if (limitMatch) rows = rows.slice(0, Number(limitMatch[1]));
            return [rows];
        }

        if (text.startsWith("select * from audit_delete_history")) {
            return [this.data.audit_delete_history.slice().sort((a, b) => b.id - a.id).slice(0, 50)];
        }

        if (text.startsWith("select id, email, role from users")) {
            return [this.data.users.slice().sort((a, b) => a.id - b.id).map(({ id, email, role }) => ({ id, email, role }))];
        }

        return [[]];
    }

    async execute(sql, params = []) {
        const text = sql.replace(/\s+/g, " ").trim().toLowerCase();

        if (text.startsWith("insert into users") && text.includes("on duplicate key update")) {
            const [email, password] = params;
            const existing = this.data.users.find((user) => user.email === email);
            if (existing) {
                existing.role = "admin";
                existing.password = password;
            } else {
                this.data.users.push({ id: this.nextId("users"), email, password, role: "admin" });
            }
            this.save();
            return [{ affectedRows: 1 }];
        }

        if (text.startsWith("select email, role from users")) {
            const [email, password] = params;
            const user = this.data.users.find((item) => item.email === email && item.password === password);
            return [user ? [{ email: user.email, role: user.role }] : []];
        }

        if (text.startsWith("insert into users")) {
            const [email, password, role] = params;
            if (this.data.users.some((user) => user.email === email)) {
                const error = new Error("Duplicate entry");
                error.code = "ER_DUP_ENTRY";
                throw error;
            }
            this.data.users.push({ id: this.nextId("users"), email, password, role });
            this.save();
            return [{ affectedRows: 1 }];
        }

        if (text.startsWith("select clause, status, evidence, evidence_file, notes, created_at, updated_at from audits where standard")) {
            const [standard] = params;
            return [this.data.audits.filter((row) => row.standard === standard).sort((a, b) => a.id - b.id)];
        }

        if (text.startsWith("select id, evidence_file from audits")) {
            const [standard, clause] = params;
            const row = this.data.audits.filter((item) => item.standard === standard && item.clause === clause).sort((a, b) => b.id - a.id)[0];
            return [row ? [{ id: row.id, evidence_file: row.evidence_file }] : []];
        }

        if (text.startsWith("update audits set")) {
            const [status, evidence, evidenceFile, notes, id] = params;
            const row = this.data.audits.find((item) => item.id === Number(id));
            if (row) {
                Object.assign(row, { status, evidence, evidence_file: evidenceFile, notes, updated_at: now() });
                this.save();
            }
            return [{ affectedRows: row ? 1 : 0 }];
        }

        if (text.startsWith("insert into audits")) {
            const [standard, clause, status, evidence, evidenceFile, notes] = params;
            this.data.audits.push({
                id: this.nextId("audits"),
                standard,
                clause,
                status,
                evidence,
                evidence_file: evidenceFile,
                notes,
                created_at: now(),
                updated_at: null
            });
            this.save();
            return [{ affectedRows: 1 }];
        }

        if (text.startsWith("select * from audits where id")) {
            const [id] = params;
            return [this.data.audits.filter((row) => row.id === Number(id))];
        }

        if (text.startsWith("select * from audits where standard")) {
            const [standard, clause] = params;
            return [this.data.audits.filter((row) => row.standard === standard && row.clause === clause)];
        }

        if (text.startsWith("insert into audit_delete_history")) {
            const [standard, clause, status, evidence, evidenceFile, notes, recordCreatedAt, recordUpdatedAt, deletedBy] = params;
            this.data.audit_delete_history.push({
                id: this.nextId("audit_delete_history"),
                standard,
                clause,
                status,
                evidence,
                evidence_file: evidenceFile,
                notes,
                record_created_at: recordCreatedAt,
                record_updated_at: recordUpdatedAt,
                deleted_by: deletedBy,
                deleted_at: now()
            });
            this.save();
            return [{ affectedRows: 1 }];
        }

        if (text.startsWith("delete from audits where id")) {
            const [id] = params;
            const before = this.data.audits.length;
            this.data.audits = this.data.audits.filter((row) => row.id !== Number(id));
            this.save();
            return [{ affectedRows: before - this.data.audits.length }];
        }

        if (text.startsWith("delete from audits where standard")) {
            const [standard, clause] = params;
            const before = this.data.audits.length;
            this.data.audits = this.data.audits.filter((row) => row.standard !== standard || row.clause !== clause);
            this.save();
            return [{ affectedRows: before - this.data.audits.length }];
        }

        if (text.startsWith("select email from users where id")) {
            const [id] = params;
            const user = this.data.users.find((item) => item.id === Number(id));
            return [user ? [{ email: user.email }] : []];
        }

        if (text.startsWith("update users set role")) {
            const [role, id] = params;
            const user = this.data.users.find((item) => item.id === Number(id));
            if (user) {
                user.role = role;
                this.save();
            }
            return [{ affectedRows: user ? 1 : 0 }];
        }

        return [[]];
    }
}

const pool = process.env.STORAGE_MODE === "json"
    ? new JsonPool()
    : mysql.createPool({
        host: process.env.DB_HOST || "127.0.0.1",
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "iso42001_audit",
        port: Number(process.env.DB_PORT || 3307),
        waitForConnections: true,
        connectionLimit: 10,
        namedPlaceholders: false
    });

module.exports = { pool };
