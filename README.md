# ISO Audit Tool - Node.js Version

Ye PHP/XAMPP project ka Node.js + Express + MySQL version hai.

## Live Website

Public website: https://iso42001-audit-tool.onrender.com/

## Features

- ISO 42001, ISO 27001, and ISO/IEC 27002 checklist
- Admin, auditor, viewer login roles
- Auditor/admin audit record save kar sakte hain
- Viewer sirf records dekh aur report export kar sakta hai
- Admin delete kar sakta hai
- Delete history dashboard me dikhegi
- Evidence file upload: PDF, image, video, Word, Excel, CSV, TXT
- Report page se `Print / Save PDF`

## Local Run

1. Node.js install karo.
2. MySQL/XAMPP start karo.
3. Project folder open karo:

```powershell
cd iso42001-audit-tool-node
```

4. Dependencies install karo:

```powershell
npm install
```

5. App start karo:

```powershell
npm start
```

6. Browser me open karo:

```text
http://localhost:3000
```

## Default Login

```text
Email: admin@test.com
Password: 12345
```

New auditor/viewer account login page se create ho sakta hai.

## Database Settings

Default local XAMPP database:

```text
STORAGE_MODE=mysql
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=
DB_NAME=iso42001_audit
DB_PORT=3307
```

Custom database ke liye `.env.example` ko `.env` me copy karo aur values change karo.

Render par quick public demo ke liye:

```text
STORAGE_MODE=json
```

## Important Hosting Note

InfinityFree PHP hosting Node.js app run nahi karti. Node.js version ko Render, Railway, VPS, or kisi Node-supported hosting par deploy karna hoga.

Public hosting par ye env values set karni hoti hain:

```text
PORT=3000
SESSION_SECRET=strong-random-secret
DB_HOST=your-db-host
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-db-name
DB_PORT=3306
```
