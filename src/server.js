'use strict';
process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice
const path = require('path');
const crypto = require('crypto');
const { open } = require('./db');
const { seedRules } = require('./rules');
const { createUser } = require('./auth');
const { createApp } = require('./app');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'l2c.db');
const db = open(DB_PATH);
seedRules(db);
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url') + '1a';
  createUser(db, { username: 'admin', name: 'Administrator', role: 'admin', password: pw });
  console.log(`Created first user  admin / ${pw}  — change it after logging in.`);
}
const app = createApp(db, { uploadDir: process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads') });
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`L2C Books & Tax running at http://localhost:${port}`));
