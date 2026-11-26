'use strict';
const crypto = require('crypto');
const SESSION_MINUTES = 30; // idle timeout

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
function strongEnough(pw) {
  return typeof pw === 'string' && pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}
function createUser(db, { username, name, role, password }) {
  const { salt, hash } = hashPassword(password);
  return Number(db.prepare('INSERT INTO users (username, name, role, pass_hash, salt) VALUES (?,?,?,?,?)').run(username, name, role, hash, salt).lastInsertRowid);
}
function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, Date.now() + SESSION_MINUTES * 60000);
  return token;
}
function getSessionUser(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() + SESSION_MINUTES * 60000, token);
  return db.prepare('SELECT id, username, name, role FROM users WHERE id = ? AND active = 1').get(s.user_id) || null;
}
function canSeeClient(db, user, clientId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return !!db.prepare('SELECT 1 FROM client_staff WHERE client_id = ? AND user_id = ?').get(clientId, user.id);
}
function visibleClients(db, user) {
  if (user.role === 'admin') return db.prepare('SELECT * FROM clients ORDER BY reg_name').all();
  return db.prepare('SELECT c.* FROM clients c JOIN client_staff s ON s.client_id = c.id WHERE s.user_id = ? ORDER BY c.reg_name').all(user.id);
}
const can = {
  approve: (u) => u.role === 'admin' || u.role === 'accountant',
  admin: (u) => u.role === 'admin',
};
module.exports = { hashPassword, verifyPassword, strongEnough, createUser, createSession, getSessionUser, canSeeClient, visibleClients, can, SESSION_MINUTES };
