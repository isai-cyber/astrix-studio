// Sesión, menú de cuenta y administración multitenant (usuarios del estudio y estudios).
import { icon, hydrateIcons } from './icons.js';

const H = { 'content-type': 'application/json', 'x-moho-web': '1' };
export async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  let j; try { j = await r.json(); } catch { j = {}; }
  if (r.status === 401 && j.login) { location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`); throw new Error('Sesión caducada'); }
  if (r.status === 403 && j.mustChangePassword) { location.replace('/login.html'); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ROLES = { owner: 'Propietario', admin: 'Administrador', editor: 'Editor', viewer: 'Solo lectura' };
const RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const when = (d) => (d ? new Date(d).toLocaleString() : 'nunca');

// Comprueba la sesión antes de mostrar la app.
export async function requireUser() {
  const r = await fetch('/api/auth/me', { headers: H });
  if (r.status === 503) return { offline: (await r.json()).error };
  if (r.status === 401) { location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`); return null; }
  const j = await r.json();
  if (j.user?.mustChangePassword) { location.replace('/login.html'); return null; }
  return j.user;
}

export function initAccount(user) {
  const isAdmin = user.isSuperadmin || RANK[user.role] >= RANK.admin;
  const initials = (user.name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
  const host = document.getElementById('accountSlot');
  host.innerHTML = `<div class="menu account">
    <button class="avatar" title="${esc(user.email)}">${esc(initials)}</button>
    <div class="dropdown glass right">
      <div class="who"><b>${esc(user.name || user.email)}</b><span>${esc(user.email)}</span><span class="tenant">${icon('folder', 13)} ${esc(user.tenant.name)} · ${ROLES[user.role]}${user.isSuperadmin ? ' · Superadmin' : ''}</span></div>
      <hr>
      ${isAdmin ? `<button data-a="users">${icon('layers', 16)} Usuarios del estudio</button>` : ''}
      ${user.isSuperadmin ? `<button data-a="tenants">${icon('folderPlus', 16)} Estudios (multitenant)</button>` : ''}
      <button data-a="password">${icon('sliders', 16)} Cambiar contraseña</button>
      <hr>
      <button data-a="logout">${icon('x', 16)} Cerrar sesión</button>
    </div></div>`;

  const panel = document.createElement('div');
  panel.id = 'accountPanel';
  panel.className = 'drawer wide';
  panel.innerHTML = `<div class="aiHead"><b id="acTitle">Cuenta</b><span class="stat-line">${esc(user.tenant.name)}</span><button id="acClose">${icon('x', 16)}</button></div><div class="aiBody" id="acBody"></div>`;
  document.body.appendChild(panel);
  const body = panel.querySelector('#acBody');
  panel.querySelector('#acClose').onclick = () => panel.classList.remove('open');
  const open = (title) => { panel.querySelector('#acTitle').textContent = title; panel.classList.add('open'); };

  function secretBox(label, email, password) {
    return `<div class="secret"><div>${icon('sparkles', 14)} <b>${esc(label)}</b></div>
      <div class="row"><span class="muted">Usuario</span><code>${esc(email)}</code></div>
      <div class="row"><span class="muted">Contraseña temporal</span><code class="pw">${esc(password)}</code><button class="small" data-copy="${esc(password)}">Copiar</button></div>
      <p class="muted small">Se muestra solo esta vez. Compártela por un canal seguro; al entrar se pedirá cambiarla.</p></div>`;
  }
  body.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { navigator.clipboard.writeText(c.dataset.copy); c.textContent = '✓ Copiado'; }
  });

  // ---------- Usuarios del estudio ----------
  async function showUsers(notice = '') {
    open('Usuarios del estudio');
    body.innerHTML = '<p class="muted">Cargando…</p>';
    let users;
    try { ({ users } = await api('/api/users')); } catch (e) { body.innerHTML = `<div class="rsError">${esc(e.message)}</div>`; return; }
    const assignable = Object.keys(ROLES).filter((r) => user.isSuperadmin || RANK[r] <= RANK[user.role]);
    body.innerHTML = `${notice}
      <form class="inlineForm" id="newUser">
        <input type="email" id="nuEmail" placeholder="correo@empresa.com" required>
        <input type="text" id="nuName" placeholder="Nombre">
        <select id="nuRole">${assignable.map((r) => `<option value="${r}" ${r === 'editor' ? 'selected' : ''}>${ROLES[r]}</option>`).join('')}</select>
        <button class="primary">${icon('plus', 14)} Crear usuario</button>
      </form>
      <table class="tbl"><thead><tr><th>Usuario</th><th>Rol</th><th>Último acceso</th><th>Activo</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr data-id="${u.id}">
        <td><b>${esc(u.name || '—')}</b><br><span class="muted small">${esc(u.email)}</span></td>
        <td><select data-f="role" ${u.id === user.id ? 'disabled' : ''}>${Object.keys(ROLES).map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''} ${assignable.includes(r) ? '' : 'disabled'}>${ROLES[r]}</option>`).join('')}</select></td>
        <td class="muted small">${when(u.last_login_at)}</td>
        <td><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''} ${u.id === user.id ? 'disabled' : ''}></td>
        <td>${u.id === user.id ? '<span class="muted small">tú</span>' : '<button class="small" data-reset>Nueva contraseña</button>'}</td>
      </tr>`).join('')}</tbody></table>
      <p class="muted small">Roles: <b>Propietario/Administrador</b> gestionan usuarios · <b>Editor</b> crea y genera · <b>Solo lectura</b> consulta sin gastar en IA.</p>`;
    body.querySelector('#newUser').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/users', { method: 'POST', body: { email: body.querySelector('#nuEmail').value, name: body.querySelector('#nuName').value, role: body.querySelector('#nuRole').value } });
        showUsers(secretBox('Usuario creado', r.user.email, r.password));
      } catch (err) { alert(err.message); }
    };
    body.querySelectorAll('tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = async () => {
        try { await api(`/api/users/${id}`, { method: 'PATCH', body: { [inp.dataset.f]: inp.type === 'checkbox' ? inp.checked : inp.value } }); }
        catch (err) { alert(err.message); showUsers(); }
      }));
      const rb = tr.querySelector('[data-reset]');
      if (rb) rb.onclick = async () => {
        if (!confirm('¿Generar una contraseña temporal nueva? Se cerrarán sus sesiones.')) return;
        try { const r = await api(`/api/users/${id}/reset-password`, { method: 'POST' }); showUsers(secretBox('Contraseña restablecida', tr.querySelector('.small').textContent, r.password)); }
        catch (err) { alert(err.message); }
      };
    });
  }

  // ---------- Estudios ----------
  async function showTenants(notice = '') {
    open('Estudios (multitenant)');
    body.innerHTML = '<p class="muted">Cargando…</p>';
    let tenants;
    try { ({ tenants } = await api('/api/tenants')); } catch (e) { body.innerHTML = `<div class="rsError">${esc(e.message)}</div>`; return; }
    body.innerHTML = `${notice}
      <p class="muted small">Cada estudio tiene sus propios usuarios y enlaces UTM, aislados del resto.</p>
      <form class="inlineForm" id="newTenant">
        <input type="text" id="ntName" placeholder="Nombre del estudio o cliente" required>
        <input type="email" id="ntEmail" placeholder="Correo del propietario" required>
        <input type="text" id="ntOwner" placeholder="Nombre del propietario">
        <button class="primary">${icon('plus', 14)} Crear estudio</button>
      </form>
      <table class="tbl"><thead><tr><th>Estudio</th><th>Usuarios</th><th>Enlaces UTM</th><th>Creado</th><th>Activo</th></tr></thead><tbody>
      ${tenants.map((t) => `<tr data-id="${t.id}"><td><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.slug)}</span></td><td>${t.users}</td><td>${t.links}</td><td class="muted small">${when(t.created_at)}</td>
        <td><input type="checkbox" data-active ${t.active ? 'checked' : ''} ${t.id === user.tenant.id ? 'disabled' : ''}></td></tr>`).join('')}
      </tbody></table>`;
    body.querySelector('#newTenant').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/tenants', { method: 'POST', body: { name: body.querySelector('#ntName').value, ownerEmail: body.querySelector('#ntEmail').value, ownerName: body.querySelector('#ntOwner').value } });
        showTenants(secretBox(`Estudio "${r.tenant.name}" creado`, r.owner.email, r.password));
      } catch (err) { alert(err.message); }
    };
    body.querySelectorAll('[data-active]').forEach((cb) => (cb.onchange = async () => {
      try { await api(`/api/tenants/${cb.closest('tr').dataset.id}`, { method: 'PATCH', body: { active: cb.checked } }); } catch (err) { alert(err.message); showTenants(); }
    }));
  }

  function showPassword() {
    open('Cambiar contraseña');
    body.innerHTML = `<form class="stackForm" id="pwForm">
      <label>Contraseña actual<input type="password" id="pwCur" autocomplete="current-password" required></label>
      <label>Nueva contraseña (mín. 10)<input type="password" id="pwNext" autocomplete="new-password" minlength="10" required></label>
      <label>Repite la nueva<input type="password" id="pwNext2" autocomplete="new-password" minlength="10" required></label>
      <button class="primary">Guardar</button><div id="pwMsg" class="muted small"></div></form>`;
    body.querySelector('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      const msg = body.querySelector('#pwMsg');
      if (body.querySelector('#pwNext').value !== body.querySelector('#pwNext2').value) { msg.textContent = 'No coinciden'; return; }
      try { await api('/api/auth/password', { method: 'POST', body: { current: body.querySelector('#pwCur').value, next: body.querySelector('#pwNext').value } }); msg.textContent = '✓ Contraseña actualizada. Se cerraron tus otras sesiones.'; }
      catch (err) { msg.textContent = err.message; }
    };
  }

  host.querySelector('.dropdown').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]'); if (!b) return;
    document.activeElement?.blur();
    if (b.dataset.a === 'users') showUsers();
    else if (b.dataset.a === 'tenants') showTenants();
    else if (b.dataset.a === 'password') showPassword();
    else if (b.dataset.a === 'logout') { await fetch('/api/auth/logout', { method: 'POST', headers: H }); location.replace('/login.html'); }
  });
  hydrateIcons(host);
  return { close: () => panel.classList.remove('open') };
}
