// Capa de datos (MariaDB): esquema multitenant, contraseñas y sesiones.
// Política: la base de datos solo guarda metadatos (usuarios, estudios, sesiones, enlaces UTM y clics).
// Nunca se guardan archivos del usuario (videos, imágenes, audio, proyectos): esos viven solo en su equipo.
import mariadb from 'mariadb';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let pool = null;
export function db() {
  if (!pool) {
    pool = mariadb.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'moho_studio',
      connectionLimit: 8,
      bigIntAsNumber: true,
      insertIdAsNumber: true,
      dateStrings: false,
    });
  }
  return pool;
}
export const q = (sql, params) => db().query(sql, params);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(80) NOT NULL UNIQUE,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    email VARCHAR(190) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('owner','admin','editor','viewer') NOT NULL DEFAULT 'editor',
    is_superadmin TINYINT(1) NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    last_login_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    tenant_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS utm_links (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tenant_id INT NOT NULL,
    code VARCHAR(16) NOT NULL UNIQUE,
    title VARCHAR(190) NOT NULL,
    destination_url VARCHAR(2000) NOT NULL,
    utm_source VARCHAR(100) NOT NULL,
    utm_medium VARCHAR(100) NOT NULL,
    utm_campaign VARCHAR(150) NOT NULL,
    utm_content VARCHAR(150) NULL,
    utm_term VARCHAR(150) NULL,
    post_url VARCHAR(2000) NULL,
    views BIGINT NULL,
    likes BIGINT NULL,
    published_at DATE NULL,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    created_by INT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_utm_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    INDEX (tenant_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS utm_clicks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    link_id INT NOT NULL,
    tenant_id INT NOT NULL,
    clicked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    visitor_hash CHAR(64) NULL,
    referer_host VARCHAR(190) NULL,
    device ENUM('mobile','tablet','desktop','bot','other') NOT NULL DEFAULT 'other',
    user_agent VARCHAR(255) NULL,
    CONSTRAINT fk_clicks_link FOREIGN KEY (link_id) REFERENCES utm_links(id) ON DELETE CASCADE,
    INDEX (link_id, clicked_at),
    INDEX (tenant_id, clicked_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function migrate() {
  for (const sql of SCHEMA) await q(sql);
}

// ---------- Contraseñas (scrypt, sin dependencias externas) ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}
export function generatePassword() {
  // 16 caracteres legibles (sin 0/O/1/l) con al menos un dígito y un símbolo.
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let s = Array.from(bytes, (b) => alpha[b % alpha.length]).join('');
  return s.slice(0, 7) + '-' + crypto.randomInt(10, 99) + '-' + s.slice(7);
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'estudio';

// ---------- Sesiones ----------
const SESSION_DAYS = 14;
export async function createSession(user, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (id, user_id, tenant_id, expires_at, ip, user_agent) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)',
    [sha256(token), user.id, user.tenant_id, SESSION_DAYS, req.socket.remoteAddress || null, String(req.headers['user-agent'] || '').slice(0, 255)]);
  await q('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  return { token, maxAge: SESSION_DAYS * 86400 };
}
export async function sessionUser(token) {
  if (!token) return null;
  const rows = await q(`SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.is_superadmin, u.must_change_password, t.name AS tenant_name, t.slug AS tenant_slug
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
    WHERE s.id = ? AND s.expires_at > NOW() AND u.active = 1 AND t.active = 1`, [sha256(token)]);
  return rows[0] || null;
}
export const deleteSession = (token) => q('DELETE FROM sessions WHERE id = ?', [sha256(token)]);

// ---------- Arranque: primer administrador ----------
// Si no hay usuarios, crea el estudio inicial y un superadministrador con contraseña aleatoria.
// La contraseña se escribe en server/CREDENCIALES_ADMIN.txt (permisos 600), nunca en consola.
export async function bootstrapAdmin(dir) {
  const [{ n }] = await q('SELECT COUNT(*) AS n FROM users');
  if (n > 0) return null;
  const email = process.env.ADMIN_EMAIL || 'admin@astrix.local';
  const password = generatePassword();
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    const t = await conn.query('INSERT INTO tenants (name, slug) VALUES (?, ?)', ['Mi estudio', 'mi-estudio']);
    await conn.query('INSERT INTO users (tenant_id, email, name, password_hash, role, is_superadmin, must_change_password) VALUES (?, ?, ?, ?, ?, 1, 1)',
      [t.insertId, email, 'Administrador', hashPassword(password), 'owner']);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  const file = path.join(dir, 'CREDENCIALES_ADMIN.txt');
  fs.writeFileSync(file, `Astrix Studio — administrador inicial\n\nURL: http://127.0.0.1:${process.env.PORT || 8765}/login.html\nUsuario: ${email}\nContraseña: ${password}\n\nAl entrar se te pedirá cambiar la contraseña. Borra este archivo después.\n`, { mode: 0o600 });
  return file;
}
