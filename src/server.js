const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { pool } = require("./db");
const { ensureSchema, md5 } = require("./schema");
const { standards, selectedStandardKey, standardControlExists } = require("./checklists");

const app = express();
const port = Number(process.env.PORT || 3000);
const rootDir = path.resolve(__dirname, "..");
const uploadRoot = path.join(rootDir, "uploads", "evidence_files");
const allowedStatuses = ["Not Started", "Compliant", "Partially Compliant", "Non-Compliant"];
const allowedExtensions = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "doc", "docx", "xls", "xlsx", "csv", "txt"]);

if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
}

fs.mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadRoot),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).slice(1).toLowerCase();
        const safeStandard = safePart(req.body.standard || "iso");
        const safeClause = safePart(req.body.clause || "clause");
        const safeBase = safePart(path.basename(file.originalname, path.extname(file.originalname))).slice(0, 50) || "evidence";
        const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
        cb(null, `${safeStandard}-${safeClause}-${stamp}-${crypto.randomBytes(4).toString("hex")}-${safeBase}.${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(1).toLowerCase();
        if (allowedExtensions.has(ext)) {
            cb(null, true);
            return;
        }
        cb(new Error("Only PDF, image, video, Word, Excel, CSV, and text files are allowed"));
    }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(rootDir, "public")));
app.use("/uploads", express.static(path.join(rootDir, "uploads")));
app.use(session({
    secret: process.env.SESSION_SECRET || "replace-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production"
    }
}));

function safePart(value) {
    return String(value).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function h(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function roleName(role) {
    return { admin: "Admin", auditor: "Auditor", viewer: "Viewer" }[role] || "Viewer";
}

function currentRole(req) {
    return req.session.role || "viewer";
}

function canSave(req) {
    return ["admin", "auditor"].includes(currentRole(req));
}

function canDelete(req) {
    return currentRole(req) === "admin";
}

function homeUrl(req) {
    return canDelete(req) ? "/dashboard" : "/home";
}

function statusClass(status) {
    return String(status || "Not Started").toLowerCase().replace(/\s+/g, "-");
}

function clauseDomId(clause) {
    return `clause-${safePart(clause)}`;
}

function evidenceFileName(filePath) {
    return path.basename(String(filePath || ""));
}

function evidenceFileUrl(filePath) {
    return filePath ? `/${String(filePath).replace(/^\/+/, "")}` : "";
}

function standardLabel(key) {
    return standards[key]?.label || "ISO 42001";
}

function savedAt(record) {
    return record ? (record.updated_at || record.created_at || "") : "";
}

function formatDate(value) {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString().replace("T", " ").slice(0, 19);
    return String(value);
}

function page(title, body, bodyClass = "") {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${h(title)}</title>
    <link rel="stylesheet" href="/assets/style.css?v=20260708">
</head>
<body${bodyClass ? ` class="${h(bodyClass)}"` : ""}>
${body}
</body>
</html>`;
}

function alertHtml(query) {
    if (query.saved) return `<section class="alert success-alert">Audit control saved successfully.</section>`;
    if (query.deleted) return `<section class="alert success-alert">Saved audit record deleted successfully.</section>`;
    if (query.registered) return `<section class="alert success-alert">Account created successfully. You are now logged in.</section>`;
    if (query.role_updated) return `<section class="alert success-alert">User role updated successfully.</section>`;
    if (query.error) return `<section class="alert error-alert">${h(query.error)}</section>`;
    return "";
}

function sidebar(req, active = "home", activeStandard = "") {
    const links = Object.entries(standards).map(([key, standard]) => {
        const selected = active === "audit" && key === activeStandard ? "active" : "";
        return `<a class="${selected}" href="/audit?standard=${h(key)}">${h(standard.label)}</a>`;
    }).join("");

    return `<aside class="sidebar">
        <div class="brand"><span class="brand-mark">ISO</span><span>Audit</span></div>
        <a class="${active === "dashboard" || active === "home" ? "active" : ""}" href="${h(homeUrl(req))}">Dashboard</a>
        ${links}
        <div class="sidebar-spacer"></div>
        <div class="sidebar-account">
            <span>${h(roleName(currentRole(req)))}</span>
            <small>${h(req.session.user)}</small>
        </div>
        <a href="/logout">Logout</a>
    </aside>`;
}

function requireAuth(req, res, next) {
    if (!req.session.user) {
        res.redirect("/login");
        return;
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) {
        res.redirect("/login");
        return;
    }
    if (!canDelete(req)) {
        res.redirect(`/home?error=${encodeURIComponent("Admin dashboard is only for admin users")}`);
        return;
    }
    next();
}

async function latestRecords(limit = 0) {
    const limitSql = limit ? ` LIMIT ${Number(limit)}` : "";
    const [records] = await pool.query(`
        SELECT a.id, a.standard, a.clause, a.status, a.evidence, a.evidence_file, a.notes, a.created_at, a.updated_at
        FROM audits a
        INNER JOIN (
            SELECT standard, clause, MAX(id) AS latest_id
            FROM audits
            GROUP BY standard, clause
        ) latest ON a.id = latest.latest_id
        ORDER BY a.id DESC${limitSql}
    `);
    return records;
}

function standardStats(records) {
    const stats = {};
    for (const [key, standard] of Object.entries(standards)) {
        stats[key] = { total: standard.controls.length, saved: 0, compliant: 0 };
    }
    for (const record of records) {
        const stat = stats[record.standard || "iso42001"];
        if (!stat) continue;
        stat.saved += 1;
        if (record.status === "Compliant") stat.compliant += 1;
    }
    return stats;
}

function standardCards(stats) {
    return Object.entries(standards).map(([key, standard]) => {
        const stat = stats[key];
        const progress = stat.total ? Math.round((stat.compliant / stat.total) * 100) : 0;
        return `<article class="standard-card">
            <div>
                <p class="eyebrow">${h(standard.module)}</p>
                <h2>${h(standard.label)}</h2>
                <p class="muted">${h(standard.description)}</p>
            </div>
            <div class="standard-meta">
                <span>${stat.total} controls</span>
                <span>${stat.saved} saved</span>
                <span>${progress}% compliant</span>
            </div>
            <div class="standard-actions">
                <a class="btn btn-secondary" href="/audit?standard=${h(key)}">Open Checklist</a>
                <a class="btn btn-secondary" href="/report?standard=${h(key)}">Export Report PDF</a>
            </div>
        </article>`;
    }).join("");
}

function recordsTable(records, { canDeleteRows = false } = {}) {
    if (records.length === 0) {
        return `<div class="empty-state"><h2>No records saved yet</h2><p class="muted">Open a checklist to begin reviewing audit controls.</p></div>`;
    }

    const actionHead = canDeleteRows ? "<th>Action</th>" : "";
    const rows = records.map((record) => {
        const file = record.evidence_file
            ? `<a class="evidence-link" href="${h(evidenceFileUrl(record.evidence_file))}" target="_blank" rel="noopener">Open ${h(evidenceFileName(record.evidence_file))}</a>`
            : `<span class="muted">No file</span>`;
        const action = canDeleteRows ? `<td>
            <form class="table-action-form" action="/audit/delete" method="POST" onsubmit="return confirm('Delete this saved audit record and its evidence file?');">
                <input type="hidden" name="record_id" value="${h(record.id)}">
                <input type="hidden" name="standard" value="${h(record.standard)}">
                <input type="hidden" name="clause" value="${h(record.clause)}">
                <input type="hidden" name="return_to" value="dashboard">
                <button class="btn btn-danger btn-small" type="submit">Delete</button>
            </form>
        </td>` : "";
        return `<tr>
            <td><strong>${h(standardLabel(record.standard))}</strong></td>
            <td><strong>${h(record.clause)}</strong></td>
            <td><span class="status-badge ${h(statusClass(record.status))}">${h(record.status)}</span></td>
            <td>${h(record.evidence)}</td>
            <td>${file}</td>
            <td>${h(record.notes)}</td>
            <td>${h(formatDate(savedAt(record)))}</td>
            ${action}
        </tr>`;
    }).join("");

    return `<div class="table-wrap">
        <table class="records-table">
            <thead><tr><th>Standard</th><th>Clause</th><th>Status</th><th>Evidence</th><th>Evidence File</th><th>Notes</th><th>Saved At</th>${actionHead}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

app.get("/", (_req, res) => {
    res.send(page("ISO Audit Tool", `<main class="hero-page">
        <nav class="navbar">
            <div class="brand"><span class="brand-mark">ISO</span><span>Audit Tool</span></div>
            <a class="nav-link" href="/login">Login</a>
        </nav>
        <section class="hero-content">
            <p class="eyebrow">ISO Audit Workspace</p>
            <h1>ISO 42001, ISO 27001, and ISO/IEC 27002 audit checklist tool</h1>
            <p class="hero-text">Record audit status, evidence references, files, findings, reports, user roles, and delete history in a Node.js + MySQL app.</p>
            <div class="hero-actions">
                <a class="btn btn-primary" href="/login">Login</a>
                <a class="btn btn-secondary" href="/register">Create Auditor / Viewer Account</a>
            </div>
        </section>
    </main>`));
});

app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
});

app.get("/login", (req, res) => {
    res.send(page("Login - ISO Audit Tool", `<main class="auth-page">
        <section class="auth-card">
            <a class="back-link" href="/">Back to home</a>
            <p class="eyebrow">Secure Auditor Access</p>
            <h1>Login</h1>
            <p class="muted">Enter your auditor credentials to continue.</p>
            ${alertHtml(req.query)}
            <form class="form" action="/login" method="POST">
                <label>Email<input type="email" name="email" placeholder="admin@test.com" required></label>
                <label>Password<input type="password" name="password" placeholder="Enter password" required></label>
                <button class="btn btn-primary full-width" type="submit">Login</button>
            </form>
            <p class="auth-links">Auditor or viewer? <a href="/register">Create your account</a></p>
        </section>
    </main>`));
});

async function handleLogin(req, res, next) {
    try {
        const email = String(req.body.email || "").trim();
        const password = md5(String(req.body.password || ""));
        const [rows] = await pool.execute("SELECT email, role FROM users WHERE email = ? AND password = ? LIMIT 1", [email, password]);
        if (rows.length !== 1) {
            res.redirect(`/login?error=${encodeURIComponent("Invalid login details")}`);
            return;
        }
        req.session.user = rows[0].email;
        req.session.role = rows[0].role || "viewer";
        res.redirect(req.session.role === "admin" ? "/dashboard" : "/home");
    } catch (error) {
        next(error);
    }
}

app.post("/login", handleLogin);

app.get("/register", (req, res) => {
    res.send(page("Create Account - ISO Audit Tool", `<main class="auth-page">
        <section class="auth-card">
            <a class="back-link" href="/login">Back to login</a>
            <p class="eyebrow">Create Auditor / Viewer Access</p>
            <h1>Create Account</h1>
            <p class="muted">Admin accounts cannot be created here. New users can register as auditor or viewer.</p>
            ${alertHtml(req.query)}
            <form class="form" action="/register" method="POST">
                <label>Email<input type="email" name="email" placeholder="name@example.com" required></label>
                <label>Password<input type="password" name="password" placeholder="Create password" required></label>
                <label>Confirm Password<input type="password" name="confirm_password" placeholder="Repeat password" required></label>
                <label>Account Type
                    <select name="role" required>
                        <option value="auditor">Auditor - can save audit records</option>
                        <option value="viewer">Viewer - can only view and export</option>
                    </select>
                </label>
                <button class="btn btn-primary full-width" type="submit">Create Account</button>
            </form>
        </section>
    </main>`));
});

async function handleRegister(req, res, next) {
    try {
        const email = String(req.body.email || "").trim();
        const password = String(req.body.password || "");
        const confirmPassword = String(req.body.confirm_password || "");
        const role = ["auditor", "viewer"].includes(req.body.role) ? req.body.role : "viewer";
        if (!email.includes("@")) return res.redirect(`/register?error=${encodeURIComponent("Enter a valid email address")}`);
        if (password.length < 5) return res.redirect(`/register?error=${encodeURIComponent("Password must be at least 5 characters")}`);
        if (password !== confirmPassword) return res.redirect(`/register?error=${encodeURIComponent("Password and confirm password do not match")}`);

        await pool.execute("INSERT INTO users (email, password, role) VALUES (?, ?, ?)", [email, md5(password), role]);
        req.session.user = email;
        req.session.role = role;
        res.redirect("/home?registered=1");
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") {
            res.redirect(`/register?error=${encodeURIComponent("Email already exists")}`);
            return;
        }
        next(error);
    }
}

app.post("/register", handleRegister);

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

app.get("/dashboard", requireAdmin, async (req, res, next) => {
    try {
        const records = await latestRecords();
        const [history] = await pool.query("SELECT * FROM audit_delete_history ORDER BY id DESC LIMIT 50");
        const [users] = await pool.query("SELECT id, email, role FROM users ORDER BY id ASC");
        const stats = standardStats(records);
        const compliantCount = records.filter((record) => record.status === "Compliant").length;
        const evidenceCount = records.filter((record) => String(record.evidence || "").trim()).length;
        const fileCount = records.filter((record) => String(record.evidence_file || "").trim()).length;

        const historyRows = history.length ? history.map((item) => `<tr>
            <td>${h(formatDate(item.deleted_at))}</td>
            <td><strong>${h(standardLabel(item.standard))}</strong></td>
            <td><strong>${h(item.clause)}</strong></td>
            <td><span class="status-badge ${h(statusClass(item.status))}">${h(item.status)}</span></td>
            <td>${h(item.evidence)}</td>
            <td>${item.evidence_file ? h(evidenceFileName(item.evidence_file)) : `<span class="muted">No file</span>`}</td>
            <td>${h(item.notes)}</td>
            <td>${h(item.deleted_by)}</td>
        </tr>`).join("") : "";

        const userRows = users.map((user) => `<tr>
            <td>${h(user.email)}</td>
            <td>${h(roleName(user.role))}</td>
            <td>
                <form class="role-form" action="/users/update-role" method="POST">
                    <input type="hidden" name="user_id" value="${h(user.id)}">
                    <select name="role">
                        ${["admin", "auditor", "viewer"].map((role) => `<option value="${role}" ${role === user.role ? "selected" : ""}>${h(roleName(role))}</option>`).join("")}
                    </select>
                    <button class="btn btn-secondary btn-small" type="submit">Update</button>
                </form>
            </td>
        </tr>`).join("");

        res.send(page("Dashboard - ISO Audit Tool", `<div class="app-layout">
            ${sidebar(req, "dashboard")}
            <main class="dashboard">
                <header class="dashboard-header">
                    <div>
                        <p class="eyebrow">Audit Workspace</p>
                        <h1>Welcome Auditor</h1>
                        <p class="muted">Signed in as ${h(req.session.user)} - Role: ${h(roleName(currentRole(req)))}</p>
                    </div>
                    <div class="header-actions">
                        <span class="role-badge">${h(roleName(currentRole(req)))}</span>
                        <a class="btn btn-secondary" href="/records-report">Export Saved Records PDF</a>
                        <a class="btn btn-primary" href="/audit?standard=iso42001">Start Audit</a>
                    </div>
                </header>
                ${alertHtml(req.query)}
                <section class="stats-grid">
                    <article class="stat-card"><span>Standards</span><strong>${Object.keys(standards).length}</strong><p>Available ISO audit modules.</p></article>
                    <article class="stat-card"><span>Saved Controls</span><strong>${records.length}</strong><p>Latest saved audit records.</p></article>
                    <article class="stat-card"><span>Compliant</span><strong>${compliantCount}</strong><p>Controls marked compliant.</p></article>
                    <article class="stat-card"><span>Deleted Logs</span><strong>${history.length}</strong><p>Recent delete history entries.</p></article>
                </section>
                <section class="standard-grid">${standardCards(stats)}</section>
                <section class="records-panel">
                    <div class="records-header">
                        <div><p class="eyebrow">Database Records</p><h2>Saved Audit Records</h2><p class="muted">Latest saved response for each audit clause.</p></div>
                        <div class="records-actions"><a class="btn btn-secondary btn-small" href="/records-report">Export PDF</a><span class="record-count">${evidenceCount} references / ${fileCount} files</span></div>
                    </div>
                    ${recordsTable(records, { canDeleteRows: true })}
                </section>
                <section class="records-panel">
                    <div class="records-header"><div><p class="eyebrow">User Roles</p><h2>Users</h2><p class="muted">Admin can update account roles.</p></div></div>
                    <div class="table-wrap"><table class="records-table role-table"><thead><tr><th>Email</th><th>Role</th><th>Action</th></tr></thead><tbody>${userRows}</tbody></table></div>
                </section>
                <section class="records-panel">
                    <div class="records-header"><div><p class="eyebrow">Delete History</p><h2>Deleted Audit Records</h2><p class="muted">Recent records deleted from ISO audit modules.</p></div><span class="record-count">${history.length} delete logs</span></div>
                    ${history.length ? `<div class="table-wrap"><table class="records-table history-table"><thead><tr><th>Deleted At</th><th>Standard</th><th>Clause</th><th>Old Status</th><th>Evidence</th><th>Evidence File</th><th>Notes</th><th>Deleted By</th></tr></thead><tbody>${historyRows}</tbody></table></div>` : `<div class="empty-state"><h2>No delete history yet</h2><p class="muted">When a saved audit record is deleted, its history will appear here.</p></div>`}
                </section>
            </main>
        </div>`));
    } catch (error) {
        next(error);
    }
});

app.get("/home", requireAuth, async (req, res, next) => {
    try {
        const records = await latestRecords(20);
        const stats = standardStats(records);
        res.send(page("User Home - ISO Audit Tool", `<div class="app-layout">
            ${sidebar(req, "home")}
            <main class="dashboard">
                <header class="dashboard-header">
                    <div><p class="eyebrow">User Workspace</p><h1>Welcome</h1><p class="muted">Signed in as ${h(req.session.user)} - Role: ${h(roleName(currentRole(req)))}</p></div>
                    <div class="header-actions"><span class="role-badge">${h(roleName(currentRole(req)))}</span><a class="btn btn-secondary" href="/records-report">Export Saved Records PDF</a></div>
                </header>
                ${alertHtml(req.query)}
                <section class="alert info-alert">${canSave(req) ? "Auditor mode: you can save audit records and export reports. Delete is admin only." : "Viewer mode: you can view audit records and export reports. Save and delete are disabled."}</section>
                <section class="standard-grid">${standardCards(stats)}</section>
                <section class="records-panel">
                    <div class="records-header">
                        <div><p class="eyebrow">Recent Records</p><h2>Saved Audit Records</h2><p class="muted">Latest saved records. Delete history and admin controls are only available to admin.</p></div>
                        <div class="records-actions"><a class="btn btn-secondary btn-small" href="/records-report">Export PDF</a><span class="record-count">${records.length} records</span></div>
                    </div>
                    ${recordsTable(records)}
                </section>
            </main>
        </div>`));
    } catch (error) {
        next(error);
    }
});

app.get("/audit", requireAuth, async (req, res, next) => {
    try {
        const standardKey = selectedStandardKey(req.query.standard);
        const currentStandard = standards[standardKey];
        const controls = currentStandard.controls;
        const [rows] = await pool.execute("SELECT clause, status, evidence, evidence_file, notes, created_at, updated_at FROM audits WHERE standard = ? ORDER BY id ASC", [standardKey]);
        const saved = Object.fromEntries(rows.map((row) => [row.clause, row]));
        const completed = controls.filter((control) => saved[control.id]?.status === "Compliant").length;
        const inProgress = controls.filter((control) => ["Partially Compliant", "Non-Compliant"].includes(saved[control.id]?.status)).length;
        const progress = controls.length ? Math.round((completed / controls.length) * 100) : 0;
        const disabled = canSave(req) ? "" : "disabled";

        const tabs = Object.entries(standards).map(([key, standard]) => `<a class="${key === standardKey ? "active" : ""}" href="/audit?standard=${h(key)}">${h(standard.label)}</a>`).join("");
        const cards = controls.map((control) => {
            const record = saved[control.id] || {};
            const status = record.status || "Not Started";
            const updatedAt = savedAt(record);
            const fileBlock = record.evidence_file ? `<div class="saved-file">
                <div class="saved-file-header"><span>Saved evidence file</span><a class="evidence-link" href="${h(evidenceFileUrl(record.evidence_file))}" target="_blank" rel="noopener">Open ${h(evidenceFileName(record.evidence_file))}</a></div>
            </div>` : "";
            const options = allowedStatuses.map((option) => `<option value="${h(option)}" ${option === status ? "selected" : ""}>${h(option)}</option>`).join("");
            return `<form id="${h(clauseDomId(control.id))}" class="audit-card" action="/audit/save" method="POST" enctype="multipart/form-data" data-status="${h(status)}" data-search="${h(`${currentStandard.label} ${control.id} ${control.section} ${control.title} ${control.question}`)}">
                <input type="hidden" name="standard" value="${h(standardKey)}">
                <input type="hidden" name="clause" value="${h(control.id)}">
                <div class="audit-card-header"><div><p class="eyebrow">${h(control.section)}</p><h2>${h(control.id)} - ${h(control.title)}</h2></div><span class="status-badge ${h(statusClass(status))}">${h(status)}</span></div>
                <p class="question">${h(control.question)}</p>
                <p class="evidence"><strong>Suggested evidence:</strong> ${h(control.evidence)}</p>
                <div class="audit-form-grid">
                    <label>Status<select name="status" class="status-field" required ${disabled}>${options}</select></label>
                    <label>Evidence Reference<input name="evidence" type="text" placeholder="policy.pdf / risk-register.xlsx" value="${h(record.evidence)}" ${disabled}></label>
                </div>
                <label class="file-field">Upload Evidence File<input name="evidence_file" type="file" accept=".pdf,image/*,video/*,.doc,.docx,.xls,.xlsx,.csv,.txt" ${disabled}><span class="field-help">Allowed: PDF, image, video, Word, Excel, CSV, or text file up to 50 MB.</span></label>
                ${fileBlock}
                <label>Audit Findings / Notes<textarea name="notes" placeholder="Write audit finding, gap, action owner, or evidence reference..." ${disabled}>${h(record.notes)}</textarea></label>
                <div class="audit-card-actions">
                    ${canSave(req) ? `<button class="btn btn-primary" type="submit">Save to Database</button>` : `<span class="save-message">View only</span>`}
                    ${updatedAt ? `<span class="save-message">Last saved: ${h(formatDate(updatedAt))}</span>${canDelete(req) ? `<button class="btn btn-danger" type="submit" formaction="/audit/delete" formmethod="POST" formnovalidate onclick="return confirm('Delete this saved audit record and its evidence file?');">Delete Saved</button>` : ""}` : `<span class="save-message">Not saved yet</span>`}
                </div>
            </form>`;
        }).join("");

        res.send(page(`${currentStandard.label} Checklist - Audit Tool`, `<div class="app-layout">
            ${sidebar(req, "audit", standardKey)}
            <main class="dashboard">
                <header class="dashboard-header">
                    <div><p class="eyebrow">Audit Module</p><h1>${h(currentStandard.label)} Checklist</h1><p class="muted">${h(currentStandard.description)} Save status, evidence references, files, and findings directly into MySQL.</p></div>
                    <div class="header-actions"><span class="role-badge">${h(roleName(currentRole(req)))}</span><a class="btn btn-secondary" href="/report?standard=${h(standardKey)}">Export Report PDF</a><a class="btn btn-secondary" href="${h(homeUrl(req))}">Back to Dashboard</a></div>
                </header>
                <section class="standard-tabs">${tabs}</section>
                ${alertHtml(req.query)}
                ${!canSave(req) ? `<section class="alert info-alert">Viewer mode: you can view records and export reports, but cannot save or delete.</section>` : (!canDelete(req) ? `<section class="alert info-alert">Auditor mode: you can save audit records, but only admin can delete.</section>` : "")}
                <section class="stats-grid audit-stats">
                    <article class="stat-card"><span>Total Controls</span><strong>${controls.length}</strong><p>Available audit items.</p></article>
                    <article class="stat-card"><span>Completed</span><strong>${completed}</strong><p>Marked compliant.</p></article>
                    <article class="stat-card"><span>Progress</span><strong>${progress}%</strong><p>${inProgress} controls need attention.</p></article>
                </section>
                <section class="toolbar panel"><input id="searchInput" type="search" placeholder="Search clause, control, or keyword"><select id="filterStatus"><option value="all">All Status</option>${allowedStatuses.map((status) => `<option value="${h(status)}">${h(status)}</option>`).join("")}</select></section>
                <section class="audit-list" id="auditList">${cards}</section>
            </main>
        </div>
        <script>
        const searchInput = document.getElementById("searchInput");
        const filterStatus = document.getElementById("filterStatus");
        const cards = Array.from(document.querySelectorAll(".audit-card"));
        function filterCards() {
            const query = searchInput.value.trim().toLowerCase();
            const status = filterStatus.value;
            cards.forEach((card) => {
                const matchesSearch = card.dataset.search.toLowerCase().includes(query);
                const matchesStatus = status === "all" || card.dataset.status === status;
                card.style.display = matchesSearch && matchesStatus ? "" : "none";
            });
        }
        searchInput.addEventListener("input", filterCards);
        filterStatus.addEventListener("change", filterCards);
        </script>`));
    } catch (error) {
        next(error);
    }
});

async function handleAuditSave(req, res, next) {
    try {
        const standardKey = selectedStandardKey(req.body.standard);
        const clause = String(req.body.clause || "").trim();
        const status = String(req.body.status || "Not Started").trim();
        const evidence = String(req.body.evidence || "").trim();
        const notes = String(req.body.notes || "").trim();
        const controls = standards[standardKey].controls;

        if (!canSave(req)) return res.redirect(`/audit?standard=${encodeURIComponent(standardKey)}&error=${encodeURIComponent("Viewer role can only view audit records")}`);
        if (!clause || !allowedStatuses.includes(status) || !standardControlExists(controls, clause)) {
            return res.redirect(`/audit?standard=${encodeURIComponent(standardKey)}&error=${encodeURIComponent("Invalid audit submission")}`);
        }

        const [existingRows] = await pool.execute("SELECT id, evidence_file FROM audits WHERE standard = ? AND clause = ? ORDER BY id DESC LIMIT 1", [standardKey, clause]);
        const existing = existingRows[0];
        const evidenceFile = req.file ? `uploads/evidence_files/${req.file.filename}` : (existing?.evidence_file || "");

        if (existing) {
            await pool.execute("UPDATE audits SET status = ?, evidence = ?, evidence_file = ?, notes = ?, updated_at = NOW() WHERE id = ?", [status, evidence, evidenceFile, notes, existing.id]);
        } else {
            await pool.execute("INSERT INTO audits (standard, clause, status, evidence, evidence_file, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())", [standardKey, clause, status, evidence, evidenceFile, notes]);
        }

        res.redirect(`/audit?standard=${encodeURIComponent(standardKey)}&saved=1#${encodeURIComponent(clauseDomId(clause))}`);
    } catch (error) {
        next(error);
    }
}

app.post("/audit/save", requireAuth, upload.single("evidence_file"), handleAuditSave);

async function handleAuditDelete(req, res, next) {
    try {
        let standardKey = selectedStandardKey(req.body.standard);
        let clause = String(req.body.clause || "").trim();
        const recordId = Number(req.body.record_id || 0);
        const returnTo = req.body.return_to === "dashboard" ? "dashboard" : "audit";

        if (!recordId && !clause) {
            return res.redirect(`/${returnTo === "dashboard" ? "dashboard" : `audit?standard=${encodeURIComponent(standardKey)}`}&error=${encodeURIComponent("Invalid audit delete request")}`);
        }

        const [rows] = recordId
            ? await pool.execute("SELECT * FROM audits WHERE id = ?", [recordId])
            : await pool.execute("SELECT * FROM audits WHERE standard = ? AND clause = ?", [standardKey, clause]);
        if (rows.length === 0) {
            return res.redirect(returnTo === "dashboard" ? `/dashboard?error=${encodeURIComponent("No saved audit record found")}` : `/audit?standard=${encodeURIComponent(standardKey)}&error=${encodeURIComponent("No saved audit record found")}`);
        }

        standardKey = rows[0].standard || standardKey;
        clause = rows[0].clause || clause;
        for (const row of rows) {
            await pool.execute(
                "INSERT INTO audit_delete_history (standard, clause, status, evidence, evidence_file, notes, record_created_at, record_updated_at, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())",
                [row.standard, row.clause, row.status, row.evidence, row.evidence_file, row.notes, row.created_at, row.updated_at, req.session.user]
            );
        }

        if (recordId) {
            await pool.execute("DELETE FROM audits WHERE id = ?", [recordId]);
        } else {
            await pool.execute("DELETE FROM audits WHERE standard = ? AND clause = ?", [standardKey, clause]);
        }

        for (const row of rows) {
            if (!row.evidence_file) continue;
            const target = path.resolve(rootDir, row.evidence_file);
            if (target.startsWith(uploadRoot) && fs.existsSync(target)) fs.unlinkSync(target);
        }

        res.redirect(returnTo === "dashboard" ? "/dashboard?deleted=1" : `/audit?standard=${encodeURIComponent(standardKey)}&deleted=1`);
    } catch (error) {
        next(error);
    }
}

app.post("/audit/delete", requireAdmin, handleAuditDelete);

async function handleUserRoleUpdate(req, res, next) {
    try {
        const userId = Number(req.body.user_id || 0);
        const role = ["admin", "auditor", "viewer"].includes(req.body.role) ? req.body.role : "viewer";
        const [rows] = await pool.execute("SELECT email FROM users WHERE id = ? LIMIT 1", [userId]);
        if (rows.length === 0) return res.redirect(`/dashboard?error=${encodeURIComponent("User not found")}`);
        if (rows[0].email === req.session.user && role !== "admin") {
            return res.redirect(`/dashboard?error=${encodeURIComponent("You cannot remove admin from your own account")}`);
        }
        await pool.execute("UPDATE users SET role = ? WHERE id = ?", [role, userId]);
        res.redirect("/dashboard?role_updated=1");
    } catch (error) {
        next(error);
    }
}

app.post("/users/update-role", requireAdmin, handleUserRoleUpdate);

app.get("/report", requireAuth, async (req, res, next) => {
    try {
        const standardKey = selectedStandardKey(req.query.standard);
        const currentStandard = standards[standardKey];
        const controls = currentStandard.controls;
        const [rows] = await pool.execute("SELECT clause, status, evidence, evidence_file, notes, created_at, updated_at FROM audits WHERE standard = ? ORDER BY id ASC", [standardKey]);
        const saved = Object.fromEntries(rows.map((row) => [row.clause, row]));
        const savedCount = controls.filter((control) => saved[control.id]).length;
        const compliantCount = controls.filter((control) => saved[control.id]?.status === "Compliant").length;
        const partialCount = controls.filter((control) => saved[control.id]?.status === "Partially Compliant").length;
        const nonCompliantCount = controls.filter((control) => saved[control.id]?.status === "Non-Compliant").length;
        const progress = controls.length ? Math.round((compliantCount / controls.length) * 100) : 0;

        const rowsHtml = controls.map((control) => {
            const record = saved[control.id] || {};
            const status = record.status || "Not Started";
            return `<tr>
                <td><strong>${h(control.id)}</strong></td>
                <td><strong>${h(control.title)}</strong><p class="report-question">${h(control.question)}</p></td>
                <td><span class="status-badge ${h(statusClass(status))}">${h(status)}</span></td>
                <td>${h(record.evidence)}</td>
                <td>${record.evidence_file ? h(evidenceFileName(record.evidence_file)) : `<span class="muted">No file</span>`}</td>
                <td>${h(record.notes)}</td>
                <td>${h(formatDate(savedAt(record)))}</td>
            </tr>`;
        }).join("");

        res.send(page(`${currentStandard.label} Audit Report`, `<main class="report-shell">
            <section class="report-actions no-print"><a class="btn btn-secondary" href="${h(homeUrl(req))}">Back to Dashboard</a><a class="btn btn-secondary" href="/audit?standard=${h(standardKey)}">Open Checklist</a><button class="btn btn-primary" type="button" onclick="window.print()">Print / Save PDF</button></section>
            <header class="report-header"><div><p class="eyebrow">Audit Report</p><h1>${h(currentStandard.label)}</h1><p class="muted">${h(currentStandard.module)} - generated on ${h(formatDate(new Date()))}</p></div><div class="report-meta"><strong>Prepared by</strong><span>${h(req.session.user)}</span><span>${h(roleName(currentRole(req)))}</span></div></header>
            <section class="report-summary">
                <article><span>Total Controls</span><strong>${controls.length}</strong></article>
                <article><span>Saved</span><strong>${savedCount}</strong></article>
                <article><span>Compliant</span><strong>${compliantCount}</strong></article>
                <article><span>Partial</span><strong>${partialCount}</strong></article>
                <article><span>Non-Compliant</span><strong>${nonCompliantCount}</strong></article>
                <article><span>Progress</span><strong>${progress}%</strong></article>
            </section>
            <section class="report-section"><h2>Audit Results</h2><div class="table-wrap"><table class="records-table report-table"><thead><tr><th>Clause</th><th>Control</th><th>Status</th><th>Evidence</th><th>Evidence File</th><th>Notes</th><th>Saved At</th></tr></thead><tbody>${rowsHtml}</tbody></table></div></section>
        </main>`, "report-page"));
    } catch (error) {
        next(error);
    }
});

app.get("/records-report", requireAuth, async (req, res, next) => {
    try {
        const records = await latestRecords();
        const compliantCount = records.filter((record) => record.status === "Compliant").length;
        const partialCount = records.filter((record) => record.status === "Partially Compliant").length;
        const nonCompliantCount = records.filter((record) => record.status === "Non-Compliant").length;
        const fileCount = records.filter((record) => record.evidence_file).length;
        const table = recordsTable(records);
        res.send(page("Saved Audit Records Report", `<main class="report-shell">
            <section class="report-actions no-print"><a class="btn btn-secondary" href="${h(homeUrl(req))}">Back</a><button class="btn btn-primary" type="button" onclick="window.print()">Print / Save PDF</button></section>
            <header class="report-header"><div><p class="eyebrow">Dashboard Export</p><h1>Saved Audit Records</h1><p class="muted">Latest saved records from all ISO audit modules. Generated on ${h(formatDate(new Date()))}</p></div><div class="report-meta"><strong>Generated by</strong><span>${h(req.session.user)}</span><span>${h(roleName(currentRole(req)))}</span></div></header>
            <section class="report-summary">
                <article><span>Saved Records</span><strong>${records.length}</strong></article>
                <article><span>Compliant</span><strong>${compliantCount}</strong></article>
                <article><span>Partial</span><strong>${partialCount}</strong></article>
                <article><span>Non-Compliant</span><strong>${nonCompliantCount}</strong></article>
                <article><span>Evidence Files</span><strong>${fileCount}</strong></article>
                <article><span>Standards</span><strong>${Object.keys(standards).length}</strong></article>
            </section>
            <section class="report-section"><h2>Saved Records Table</h2>${table}</section>
        </main>`, "report-page"));
    } catch (error) {
        next(error);
    }
});

app.get("/frontend/index.html", (_req, res) => res.redirect("/"));
app.get("/frontend/login.html", (_req, res) => res.redirect("/login"));
app.get("/frontend/register.php", (_req, res) => res.redirect("/register"));
app.get("/frontend/dashboard.php", (_req, res) => res.redirect("/dashboard"));
app.get("/frontend/user_home.php", (_req, res) => res.redirect("/home"));
app.get("/frontend/audit.php", (req, res) => res.redirect(`/audit?standard=${encodeURIComponent(req.query.standard || "iso42001")}`));
app.get("/frontend/report.php", (req, res) => res.redirect(`/report?standard=${encodeURIComponent(req.query.standard || "iso42001")}`));
app.get("/frontend/records_report.php", (_req, res) => res.redirect("/records-report"));
app.post("/backend/login.php", handleLogin);
app.post("/backend/register.php", handleRegister);
app.post("/backend/save_audit.php", requireAuth, upload.single("evidence_file"), handleAuditSave);
app.post("/backend/delete_audit.php", requireAdmin, handleAuditDelete);
app.post("/backend/update_role.php", requireAdmin, handleUserRoleUpdate);
app.get("/backend/login.php", (_req, res) => res.send("Invalid login details"));

app.use((error, req, res, _next) => {
    const message = error.message || "Something went wrong";
    if (req.path.startsWith("/audit/save")) {
        res.redirect(`/audit?standard=${encodeURIComponent(req.body?.standard || "iso42001")}&error=${encodeURIComponent(message)}`);
        return;
    }
    res.status(500).send(page("Server Error", `<main class="auth-page"><section class="auth-card"><h1>Server Error</h1><p class="muted">${h(message)}</p><a class="btn btn-secondary" href="/">Back home</a></section></main>`));
});

ensureSchema(pool)
    .then(() => {
        app.listen(port, () => {
            console.log(`ISO audit Node app running at http://localhost:${port}`);
        });
    })
    .catch((error) => {
        console.error("Could not initialize database schema:", error.message);
        process.exit(1);
    });
