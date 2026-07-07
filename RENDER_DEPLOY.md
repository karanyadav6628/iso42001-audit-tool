# Render Deployment Guide

Ye folder ab PHP nahi hai. Ye Node.js + Express + MySQL app hai.

## Render Par Deploy

1. `iso42001-audit-tool` folder ko GitHub repo me upload karo.
2. Render dashboard me `New` -> `Web Service` select karo.
3. GitHub repo connect karo.
4. Settings:

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /healthz
```

5. Environment variables add karo:

```text
NODE_ENV=production
STORAGE_MODE=json
SESSION_SECRET=apna-strong-secret
```

`STORAGE_MODE=json` se website Render par turant public open ho jayegi. Data Render ke free filesystem me rahega, jo restart/redeploy ke baad reset ho sakta hai.

MySQL use karna ho to `STORAGE_MODE=mysql` karo aur ye values bhi add karo:

```text
DB_HOST=your-mysql-host
DB_USER=your-mysql-user
DB_PASSWORD=your-mysql-password
DB_NAME=your-mysql-database
DB_PORT=3306
```

## Database Important

Render web service MySQL database automatically nahi deta. Is app ko external MySQL database chahiye.

Existing database values use kar sakte ho agar host external connection allow karta hai:

```text
DB_HOST=sql104.infinityfree.com
DB_USER=if0_42356191
DB_NAME=if0_42356191_iso42001audit
DB_PORT=3306
```

Agar Render deploy ke baad database connection fail ho, to `STORAGE_MODE=json` use karo ya external MySQL hosting use karo. MySQL mode me app first start par tables automatically create karega.

## Login

Default admin account:

```text
Email: admin@test.com
Password: 12345
```

## Evidence Upload Note

Render free web service ka uploaded file storage restart/redeploy ke baad permanent nahi hota. Demo ke liye upload chalega, but production ke liye persistent disk ya cloud storage use karo.
