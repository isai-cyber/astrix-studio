// Rutas de cuentas (multitenant), enlaces UTM y ElevenLabs.
// Ningún archivo del usuario se guarda aquí: el audio de ElevenLabs se reenvía en memoria al navegador,
// y la base de datos solo contiene metadatos.
import crypto from 'node:crypto';
import { q, db, hashPassword, verifyPassword, generatePassword, createSession, deleteSession, sha256, slugify } from './db.mjs';

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export const can = (user, role) => user && (user.is_superadmin || ROLE_RANK[user.role] >= ROLE_RANK[role]);

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function body(req, max = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new Error('Petición demasiado grande'), { status: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function getCookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
const COOKIE = 'ms_sess';
const secureFlag = () => (/^https:/.test(process.env.PUBLIC_BASE_URL || '') ? '; Secure' : '');
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || ''));
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isSuperadmin: !!u.is_superadmin, mustChangePassword: !!u.must_change_password, tenant: { id: u.tenant_id, name: u.tenant_name, slug: u.tenant_slug } });

// Límite de intentos de login por IP (memoria): 10 intentos / 15 min.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a);
  return a.length >= 10;
}

// ---------- Autenticación ----------
export async function authRoutes(req, res, url, user) {
  const p = url.pathname, m = req.method;
  if (p === '/api/auth/login' && m === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    if (rateLimited(ip)) return send(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' }), true;
    const { email, password } = await body(req);
    const rows = await q(`SELECT u.*, t.name AS tenant_name, t.slug AS tenant_slug, t.active AS tenant_active
      FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = ?`, [String(email || '').trim().toLowerCase()]);
    const u = rows[0];
    // Se verifica siempre una contraseña para no revelar por tiempo si el correo existe.
    const ok = verifyPassword(String(password || ''), u?.password_hash || hashPassword('x')) && u && u.active && u.tenant_active;
    if (!ok) { attempts.get(ip).push(Date.now()); return send(res, 401, { error: 'Correo o contraseña incorrectos' }), true; }
    const s = await createSession(u, req);
    res.setHeader('set-cookie', `${COOKIE}=${s.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${s.maxAge}${secureFlag()}`);
    return send(res, 200, { user: publicUser(u) }), true;
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    const t = getCookie(req, COOKIE);
    if (t) await deleteSession(t);
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag()}`);
    return send(res, 200, { ok: true }), true;
  }
  if (p === '/api/auth/me' && m === 'GET') {
    if (!user) return send(res, 401, { error: 'Sin sesión' }), true;
    return send(res, 200, { user: publicUser(user) }), true;
  }
  if (p === '/api/auth/password' && m === 'POST') {
    if (!user) return send(res, 401, { error: 'Sin sesión' }), true;
    const { current, next } = await body(req);
    if (String(next || '').length < 10) return send(res, 400, { error: 'La nueva contraseña debe tener al menos 10 caracteres' }), true;
    const [row] = await q('SELECT password_hash FROM users WHERE id = ?', [user.id]);
    if (!verifyPassword(String(current || ''), row.password_hash)) return send(res, 400, { error: 'La contraseña actual no es correcta' }), true;
    await q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [hashPassword(next), user.id]);
    await q('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [user.id, sha256(getCookie(req, COOKIE) || '')]);
    return send(res, 200, { ok: true }), true;
  }
  return false;
}

// ---------- Usuarios del estudio ----------
export async function userRoutes(req, res, url, user) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/users')) return false;
  if (!can(user, 'admin')) return send(res, 403, { error: 'Solo administradores' }), true;
  if (p === '/api/users' && m === 'GET') {
    const rows = await q('SELECT id, email, name, role, active, is_superadmin, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY created_at', [user.tenant_id]);
    return send(res, 200, { users: rows }), true;
  }
  if (p === '/api/users' && m === 'POST') {
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!isEmail(email)) return send(res, 400, { error: 'Correo no válido' }), true;
    const role = ROLE_RANK[b.role] !== undefined ? b.role : 'editor';
    if (!user.is_superadmin && ROLE_RANK[role] > ROLE_RANK[user.role]) return send(res, 403, { error: 'No puedes asignar un rol superior al tuyo' }), true;
    const password = generatePassword();
    try {
      const r = await q('INSERT INTO users (tenant_id, email, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [user.tenant_id, email, String(b.name || '').slice(0, 120), hashPassword(password), role]);
      return send(res, 200, { user: { id: r.insertId, email, role }, password }), true;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return send(res, 409, { error: 'Ese correo ya tiene cuenta' }), true;
      throw e;
    }
  }
  const mm = /^\/api\/users\/(\d+)(\/reset-password)?$/.exec(p);
  if (mm) {
    const id = +mm[1];
    const [target] = await q('SELECT id, role, is_superadmin FROM users WHERE id = ? AND tenant_id = ?', [id, user.tenant_id]);
    if (!target) return send(res, 404, { error: 'Usuario no encontrado' }), true;
    if (!user.is_superadmin && ROLE_RANK[target.role] > ROLE_RANK[user.role]) return send(res, 403, { error: 'No puedes modificar a un usuario con rol superior' }), true;
    if (mm[2] && m === 'POST') {
      const password = generatePassword();
      await q('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [hashPassword(password), id]);
      await q('DELETE FROM sessions WHERE user_id = ?', [id]);
      return send(res, 200, { password }), true;
    }
    if (m === 'PATCH') {
      const b = await body(req);
      if (id === user.id && (b.active === false || (b.role && b.role !== user.role))) return send(res, 400, { error: 'No puedes desactivarte ni cambiar tu propio rol' }), true;
      if (b.role !== undefined) {
        if (ROLE_RANK[b.role] === undefined) return send(res, 400, { error: 'Rol no válido' }), true;
        if (!user.is_superadmin && ROLE_RANK[b.role] > ROLE_RANK[user.role]) return send(res, 403, { error: 'No puedes asignar un rol superior al tuyo' }), true;
        await q('UPDATE users SET role = ? WHERE id = ?', [b.role, id]);
      }
      if (b.active !== undefined) {
        await q('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, id]);
        if (!b.active) await q('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
      if (b.name !== undefined) await q('UPDATE users SET name = ? WHERE id = ?', [String(b.name).slice(0, 120), id]);
      return send(res, 200, { ok: true }), true;
    }
  }
  return send(res, 404, { error: 'Ruta desconocida' }), true;
}

// ---------- Estudios (solo superadministrador) ----------
export async function tenantRoutes(req, res, url, user) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/tenants')) return false;
  if (!user?.is_superadmin) return send(res, 403, { error: 'Solo el superadministrador' }), true;
  if (p === '/api/tenants' && m === 'GET') {
    const rows = await q(`SELECT t.id, t.name, t.slug, t.active, t.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS users,
      (SELECT COUNT(*) FROM utm_links l WHERE l.tenant_id = t.id) AS links
      FROM tenants t ORDER BY t.created_at`);
    return send(res, 200, { tenants: rows }), true;
  }
  if (p === '/api/tenants' && m === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').trim().slice(0, 120);
    const email = String(b.ownerEmail || '').trim().toLowerCase();
    if (!name) return send(res, 400, { error: 'Falta el nombre del estudio' }), true;
    if (!isEmail(email)) return send(res, 400, { error: 'Correo del propietario no válido' }), true;
    const password = generatePassword();
    const conn = await db().getConnection();
    try {
      await conn.beginTransaction();
      let slug = slugify(name), n = 1;
      while ((await conn.query('SELECT 1 FROM tenants WHERE slug = ?', [slug])).length) slug = `${slugify(name)}-${++n}`;
      const t = await conn.query('INSERT INTO tenants (name, slug) VALUES (?, ?)', [name, slug]);
      await conn.query('INSERT INTO users (tenant_id, email, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [t.insertId, email, String(b.ownerName || '').slice(0, 120), hashPassword(password), 'owner']);
      await conn.commit();
      return send(res, 200, { tenant: { id: t.insertId, name, slug }, owner: { email }, password }), true;
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return send(res, 409, { error: 'Ese correo ya tiene cuenta' }), true;
      throw e;
    } finally { conn.release(); }
  }
  const mm = /^\/api\/tenants\/(\d+)$/.exec(p);
  if (mm && m === 'PATCH') {
    const b = await body(req);
    if (+mm[1] === user.tenant_id && b.active === false) return send(res, 400, { error: 'No puedes desactivar tu propio estudio' }), true;
    if (b.active !== undefined) await q('UPDATE tenants SET active = ? WHERE id = ?', [b.active ? 1 : 0, +mm[1]]);
    if (b.name) await q('UPDATE tenants SET name = ? WHERE id = ?', [String(b.name).slice(0, 120), +mm[1]]);
    return send(res, 200, { ok: true }), true;
  }
  return send(res, 404, { error: 'Ruta desconocida' }), true;
}

// ---------- Enlaces UTM ----------
const B62 = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(7), (b) => B62[b % B62.length]).join('');
const cleanTag = (s, max = 100) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^\w\-.]/g, '').slice(0, max);
export const publicBase = () => (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8765}`).replace(/\/$/, '');

export function utmUrl(link) {
  const u = new URL(link.destination_url);
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    if (link[k]) u.searchParams.set(k, link[k]); else u.searchParams.delete(k);
  }
  return u.toString();
}

function validDest(s) {
  try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) ? u.toString() : null; } catch { return null; }
}

export async function utmRoutes(req, res, url, user) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/utm')) return false;
  const days = Math.max(1, Math.min(365, +url.searchParams.get('days') || 30));
  if (p === '/api/utm' && m === 'GET') {
    const rows = await q(`SELECT l.*,
        (SELECT COUNT(*) FROM utm_clicks c WHERE c.link_id = l.id AND c.device <> 'bot') AS clicks,
        (SELECT COUNT(DISTINCT c.visitor_hash) FROM utm_clicks c WHERE c.link_id = l.id AND c.device <> 'bot') AS unique_clicks,
        (SELECT COUNT(*) FROM utm_clicks c WHERE c.link_id = l.id AND c.device <> 'bot' AND c.clicked_at > NOW() - INTERVAL ? DAY) AS clicks_period,
        (SELECT MAX(c.clicked_at) FROM utm_clicks c WHERE c.link_id = l.id) AS last_click
      FROM utm_links l WHERE l.tenant_id = ? AND l.archived = 0 ORDER BY l.created_at DESC`, [days, user.tenant_id]);
    const base = publicBase();
    return send(res, 200, { links: rows.map((l) => ({ ...l, short_url: `${base}/r/${l.code}`, full_url: utmUrl(l), ctr: l.views ? l.clicks / l.views : null })) }), true;
  }
  if (p === '/api/utm/stats' && m === 'GET') {
    const t = user.tenant_id;
    const [byDay, bySource, byDevice, byReferer] = await Promise.all([
      q(`SELECT DATE(c.clicked_at) AS day, COUNT(*) AS clicks FROM utm_clicks c WHERE c.tenant_id = ? AND c.device <> 'bot' AND c.clicked_at > NOW() - INTERVAL ? DAY GROUP BY day ORDER BY day`, [t, days]),
      q(`SELECT l.utm_source AS source, COUNT(c.id) AS clicks, SUM(DISTINCT l.views) AS views FROM utm_links l LEFT JOIN utm_clicks c ON c.link_id = l.id AND c.device <> 'bot' AND c.clicked_at > NOW() - INTERVAL ? DAY WHERE l.tenant_id = ? AND l.archived = 0 GROUP BY l.utm_source ORDER BY clicks DESC`, [days, t]),
      q(`SELECT c.device, COUNT(*) AS clicks FROM utm_clicks c WHERE c.tenant_id = ? AND c.clicked_at > NOW() - INTERVAL ? DAY GROUP BY c.device`, [t, days]),
      q(`SELECT COALESCE(c.referer_host, '(directo)') AS referer, COUNT(*) AS clicks FROM utm_clicks c WHERE c.tenant_id = ? AND c.device <> 'bot' AND c.clicked_at > NOW() - INTERVAL ? DAY GROUP BY referer ORDER BY clicks DESC LIMIT 10`, [t, days]),
    ]);
    return send(res, 200, { days, byDay, bySource, byDevice, byReferer }), true;
  }
  if (p === '/api/utm' && m === 'POST') {
    if (!can(user, 'editor')) return send(res, 403, { error: 'Tu rol es de solo lectura' }), true;
    const b = await body(req);
    const dest = validDest(b.destination_url);
    if (!dest) return send(res, 400, { error: 'La URL de destino debe empezar con http:// o https://' }), true;
    const link = {
      title: String(b.title || '').trim().slice(0, 190) || 'Video sin título',
      destination_url: dest,
      utm_source: cleanTag(b.utm_source) || 'tiktok',
      utm_medium: cleanTag(b.utm_medium) || 'organic_video',
      utm_campaign: cleanTag(b.utm_campaign, 150) || 'sin_campana',
      utm_content: cleanTag(b.utm_content, 150) || null,
      utm_term: cleanTag(b.utm_term, 150) || null,
      post_url: validDest(b.post_url),
      views: Number.isFinite(+b.views) && b.views !== '' && b.views !== null ? Math.max(0, Math.round(+b.views)) : null,
      published_at: /^\d{4}-\d{2}-\d{2}$/.test(b.published_at || '') ? b.published_at : null,
    };
    for (let i = 0; i < 5; i++) {
      try {
        const code = newCode();
        const r = await q(`INSERT INTO utm_links (tenant_id, code, title, destination_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, post_url, views, published_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [user.tenant_id, code, link.title, link.destination_url, link.utm_source, link.utm_medium, link.utm_campaign, link.utm_content, link.utm_term, link.post_url, link.views, link.published_at, user.id]);
        return send(res, 200, { id: r.insertId, code, short_url: `${publicBase()}/r/${code}`, full_url: utmUrl(link) }), true;
      } catch (e) { if (e.code !== 'ER_DUP_ENTRY') throw e; }
    }
    throw new Error('No se pudo generar un código único');
  }
  const mm = /^\/api\/utm\/(\d+)$/.exec(p);
  if (mm) {
    const [link] = await q('SELECT id FROM utm_links WHERE id = ? AND tenant_id = ?', [+mm[1], user.tenant_id]);
    if (!link) return send(res, 404, { error: 'Enlace no encontrado' }), true;
    if (m === 'PATCH') {
      if (!can(user, 'editor')) return send(res, 403, { error: 'Tu rol es de solo lectura' }), true;
      const b = await body(req);
      const sets = [], vals = [];
      if (b.views !== undefined) { sets.push('views = ?'); vals.push(b.views === null || b.views === '' ? null : Math.max(0, Math.round(+b.views))); }
      if (b.likes !== undefined) { sets.push('likes = ?'); vals.push(b.likes === null || b.likes === '' ? null : Math.max(0, Math.round(+b.likes))); }
      if (b.post_url !== undefined) { sets.push('post_url = ?'); vals.push(validDest(b.post_url)); }
      if (b.title !== undefined) { sets.push('title = ?'); vals.push(String(b.title).slice(0, 190)); }
      if (b.archived !== undefined) { sets.push('archived = ?'); vals.push(b.archived ? 1 : 0); }
      if (sets.length) await q(`UPDATE utm_links SET ${sets.join(', ')} WHERE id = ?`, [...vals, +mm[1]]);
      return send(res, 200, { ok: true }), true;
    }
    if (m === 'DELETE') {
      if (!can(user, 'admin')) return send(res, 403, { error: 'Solo administradores pueden borrar enlaces' }), true;
      await q('DELETE FROM utm_links WHERE id = ?', [+mm[1]]);
      return send(res, 200, { ok: true }), true;
    }
  }
  return send(res, 404, { error: 'Ruta desconocida' }), true;
}

// Redirección pública /r/CODIGO: registra el clic (sin guardar la IP) y redirige al destino con UTM.
const BOT_RE = /bot|crawler|spider|preview|facebookexternalhit|slackbot|whatsapp|telegrambot|discordbot|embedly|curl|wget|python-requests/i;
let daySalt = { day: '', salt: '' };
function visitorHash(req) {
  const day = new Date().toISOString().slice(0, 10);
  if (daySalt.day !== day) daySalt = { day, salt: crypto.randomBytes(16).toString('hex') }; // sal diaria: no se puede rastrear a nadie entre días
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return sha256(`${daySalt.salt}|${ip}|${req.headers['user-agent'] || ''}`);
}
export async function utmRedirect(req, res, url) {
  const code = url.pathname.slice(3).replace(/[^\w]/g, '');
  const [link] = code ? await q('SELECT * FROM utm_links WHERE code = ? AND archived = 0', [code]) : [];
  if (!link) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Enlace no encontrado'); return; }
  const ua = String(req.headers['user-agent'] || '');
  const device = BOT_RE.test(ua) ? 'bot' : /ipad|tablet/i.test(ua) ? 'tablet' : /mobi|android|iphone/i.test(ua) ? 'mobile' : ua ? 'desktop' : 'other';
  let refHost = null;
  try { refHost = req.headers.referer ? new URL(req.headers.referer).hostname.slice(0, 190) : null; } catch { /* sin referer */ }
  q('INSERT INTO utm_clicks (link_id, tenant_id, visitor_hash, referer_host, device, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    [link.id, link.tenant_id, visitorHash(req), refHost, device, ua.slice(0, 255)]).catch((e) => console.error('utm click', e.message));
  res.writeHead(302, { location: utmUrl(link), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer-when-downgrade' });
  res.end();
}

// ---------- ElevenLabs ----------
const elKey = () => process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
export const elevenAvailable = () => !!elKey();
let voicesCache = { at: 0, data: null };
async function el(pathname, init = {}) {
  const r = await fetch(`https://api.elevenlabs.io${pathname}`, { ...init, headers: { 'xi-api-key': elKey(), 'content-type': 'application/json', ...(init.headers || {}) } });
  if (!r.ok) {
    let msg = `ElevenLabs ${r.status}`;
    try { const j = await r.json(); msg = j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : msg); } catch { /* sin cuerpo */ }
    throw Object.assign(new Error(msg), { status: r.status === 401 ? 400 : 502 });
  }
  return r;
}
async function sendAudio(res, r) {
  res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'no-store' });
  res.end(Buffer.from(await r.arrayBuffer())); // solo en memoria, no se escribe a disco
}

export async function elevenRoutes(req, res, url, user) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/eleven/')) return false;
  if (!elKey()) return send(res, 400, { error: 'Falta ELEVENLABS_API_KEY (server/.env)' }), true;
  if (p === '/api/eleven/voices' && m === 'GET') {
    if (!voicesCache.data || Date.now() - voicesCache.at > 10 * 60e3) {
      const j = await (await el('/v2/voices?page_size=100')).json();
      voicesCache = { at: Date.now(), data: (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels || {}, preview: v.preview_url })) };
    }
    return send(res, 200, { voices: voicesCache.data }), true;
  }
  if (p === '/api/eleven/models' && m === 'GET') {
    try {
      const j = await (await el('/v1/models')).json();
      return send(res, 200, { models: (Array.isArray(j) ? j : []).filter((x) => x.can_do_text_to_speech).map((x) => ({ id: x.model_id, name: x.name })) }), true;
    } catch { return send(res, 200, { models: [{ id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2' }] }), true; }
  }
  if (!can(user, 'editor')) return send(res, 403, { error: 'Tu rol es de solo lectura' }), true;
  if (p === '/api/eleven/tts' && m === 'POST') {
    const b = await body(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'Escribe el texto a narrar' }), true;
    if (text.length > 5000) return send(res, 400, { error: 'Máximo 5000 caracteres por narración' }), true;
    if (!/^[\w-]{6,64}$/.test(b.voiceId || '')) return send(res, 400, { error: 'Elige una voz' }), true;
    const voice_settings = {};
    for (const [k, src] of [['stability', 'stability'], ['similarity_boost', 'similarity'], ['style', 'style'], ['speed', 'speed']]) if (Number.isFinite(+b[src])) voice_settings[k] = +b[src];
    const r = await el(`/v1/text-to-speech/${b.voiceId}?output_format=mp3_44100_128`, {
      method: 'POST', body: JSON.stringify({ text, model_id: b.modelId || 'eleven_multilingual_v2', ...(Object.keys(voice_settings).length ? { voice_settings } : {}) }),
    });
    await sendAudio(res, r); return true;
  }
  if (p === '/api/eleven/sfx' && m === 'POST') {
    const b = await body(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: 'Describe el efecto de sonido' }), true;
    const payload = { text, loop: !!b.loop };
    if (Number.isFinite(+b.duration) && +b.duration > 0) payload.duration_seconds = Math.max(0.5, Math.min(30, +b.duration));
    if (Number.isFinite(+b.promptInfluence)) payload.prompt_influence = Math.max(0, Math.min(1, +b.promptInfluence));
    const r = await el('/v1/sound-generation?output_format=mp3_44100_128', { method: 'POST', body: JSON.stringify(payload) });
    await sendAudio(res, r); return true;
  }
  return send(res, 404, { error: 'Ruta desconocida' }), true;
}
