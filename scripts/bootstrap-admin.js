import { hashPassword } from '../server/auth/password.js';
import { db } from '../server/db.js';

const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) {
  console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD env vars');
  process.exit(1);
}
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  console.log('User already exists:', username);
  process.exit(0);
}
const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get('admin').c;
if (count > 0) {
  console.error('An admin already exists. Bootstrap aborted to avoid privilege escalation.');
  process.exit(1);
}
const hash = await hashPassword(password);
const info = db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)').run(username, hash, 'admin');
console.log('Created admin user:', username, 'id=', info.lastInsertRowid);
