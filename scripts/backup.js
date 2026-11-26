'use strict';
// Daily backup: consistent copy of the database + all uploaded source documents.
// Schedule with cron, e.g.  0 2 * * *  cd /app && node scripts/backup.js
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'l2c.db');
const OUT = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dir = path.join(OUT, stamp);
fs.mkdirSync(dir, { recursive: true });
new DatabaseSync(DB_PATH).exec(`VACUUM INTO '${path.join(dir, 'l2c.db').replace(/'/g, "''")}'`);
const up = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
if (fs.existsSync(up)) fs.cpSync(up, path.join(dir, 'uploads'), { recursive: true });
console.log('Backup written to', dir);
