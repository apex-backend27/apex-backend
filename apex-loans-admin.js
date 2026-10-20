(function () {
  'use strict';

  const apiBase = (typeof API_URL !== 'undefined' && API_URL) || window.API_URL || '';
  const token = () => localStorage.getItem('apex_token') || sessionStorage.getItem('apex_token') || '';
  const money = (value) => Number(value || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateText = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString('es-PE');
  };
  let activeMode = 'history';
  let currentUserId = '';
  let modal;

  async function api(path, options) {
    if (!apiBase) throw new Error('No se encontró la URL de la API.');
    const currentToken = token();
    if (!currentToken) throw new Error('La sesión administrativa expiró. Vuelve a iniciar sesión.');
    const response = await fetch(apiBase + path, {
      cache: 'no-store',
      ...(options || {}),
      headers: { Accept: 'application/json', ...(options && options.headers ? options.headers : {}), Authorization: 'Bearer ' + currentToken }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'No se pudo completar la solicitud.');
    return body;
  }

  function ensureModal() {
    if (modal && modal.isConnected) return modal;
    modal = document.createElement('div');
    modal.id = 'apexLoanModal';
    modal.className = 'modal-overlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'apexLoanModalTitle');
    modal.style.zIndex = '5000';
    modal.innerHTML = `<div class="modal" style="max-width:820px;width:min(820px,96vw);padding:0;overflow:hidden;max-height:92vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid #edf0f4;background:#fff;position:sticky;top:0;z-index:2">
        <div><div id="apexLoanModalTitle" style="font-size:18px;font-weight:800;color:#172033">Préstamos del usuario</div><div id="apexLoanModalUser" style="font-size:12px;color:#718096;margin-top:3px">Gestiona préstamo, abono e historial</div></div>
        <button type="button" id="apexLoanModalClose" aria-label="Cerrar" style="width:36px;height:36px;border:0;border-radius:50%;background:#f1f3f6;color:#555;font-size:23px;cursor:pointer">×</button>
      </div>
      <div style="padding:16px 20px;overflow:auto">
        <div id="apexLoanSearchArea" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
          <input id="apexLoanSearch" type="search" placeholder="Buscar usuario por nombre, teléfono o ID" style="flex:1;min-width:220px;padding:10px 12px;border:1px solid #dce2ea;border-radius:9px;font-size:13px">
          <button id="apexLoanSearchButton" type="button" class="btn btn-secondary" style="padding:10px 14px;border:1px solid #dce2ea;border-radius:9px">Buscar</button>
          <select id="apexLoanUserSelect" aria-label="Seleccionar usuario" style="flex:1;min-width:220px;padding:10px;border:1px solid #dce2ea;border-radius:9px"><option value="">Selecciona un usuario…</option></select>
        </div>
        <div id="apexLoanNotice" role="status" aria-live="polite" style="display:none"></div>
        <div id="apexLoanWorkspace"><p style="color:#777;text-align:center;padding:18px">Cargando datos del usuario…</p></div>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#apexLoanModalClose').addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
    modal.querySelector('#apexLoanSearchButton').addEventListener('click', searchUsers);
    modal.querySelector('#apexLoanSearch').addEventListener('input', (event) => {
      if (event.target.value.trim() !== String(currentUserId)) currentUserId = '';
    });
    modal.querySelector('#apexLoanSearch').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); searchUsers(); }
    });
    modal.querySelector('#apexLoanUserSelect').addEventListener('change', (event) => {
      currentUserId = event.target.value;
      activeMode = 'history';
      if (currentUserId) loadUserLoans(currentUserId);
    });
    const workspace = modal.querySelector('#apexLoanWorkspace');
    workspace.addEventListener('click', (event) => {
      const button = event.target.closest('.apex-loan-mode');
      if (button) { activeMode = button.dataset.mode; loadUserLoans(currentUserId); }
    });
    workspace.addEventListener('input', (event) => {
      if (event.target.name === 'amount') {
        const key = event.target.closest('form')?.querySelector('[name="idempotencyKey"]');
        if (key) key.value = '';
      }
    });
    workspace.addEventListener('change', (event) => {
      if (event.target.name === 'loanId') {
        const key = event.target.closest('form')?.querySelector('[name="idempotencyKey"]');
        if (key) key.value = '';
      }
    });
    workspace.addEventListener('submit', async (event) => {
      const form = event.target.closest('form');
      if (!form) return;
      event.preventDefault();
      try {
        if (form.id === 'apexLoanCreateForm') await submitLoanForm(form);
        if (form.id === 'apexLoanPaymentForm') await submitPaymentForm(form);
      } catch (error) { notice(error.message, 'error'); }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && modal.classList.contains('show')) closeModal(); });
    return modal;
  }

  function closeModal() {
    if (modal) modal.classList.remove('show');
  }

  function notice(message, kind) {
    const node = ensureModal().querySelector('#apexLoanNotice');
    node.textContent = message || '';
    node.style.display = message ? 'block' : 'none';
    node.style.padding = message ? '10px 12px' : '0';
    node.style.margin = message ? '0 0 12px' : '0';
    node.style.borderRadius = '8px';
    node.style.background = kind === 'error' ? '#ffebee' : kind === 'success' ? '#e8f5e9' : '#e3f2fd';
    node.style.color = kind === 'error' ? '#b71c1c' : kind === 'success' ? '#1b5e20' : '#0d47a1';
  }

  function userLabel(user) {
    const name = [user.nombre, user.apellido].filter(Boolean).join(' ').trim() || 'Usuario';
    return `#${user.id} · ${name} · ${user.telefono || 'sin teléfono'}`;
  }

  async function refreshAdminUsers() {
    try {
      const users = await api('/api/admin/users');
      const storageKey = (typeof STORAGE_KEY !== 'undefined' && STORAGE_KEY) || 'apex_users';
      localStorage.setItem(storageKey, JSON.stringify(users));
      if (typeof usuariosCache !== 'undefined') usuariosCache = users;
      if (typeof window.renderUsuarios === 'function') window.renderUsuarios();
    } catch (error) {
      console.warn('No se pudo actualizar la tabla de usuarios después del movimiento:', error.message);
    }
  }

  async function searchUsers() {
    const root = ensureModal();
    const select = root.querySelector('#apexLoanUserSelect');
    const search = root.querySelector('#apexLoanSearch');
    const requestedUserId = currentUserId;
    const searchText = search.value.trim();
    select.innerHTML = '<option value="">Cargando usuarios…</option>';
    try {
      const data = await api('/api/admin/loans/users?search=' + encodeURIComponent(searchText));
      select.innerHTML = '<option value="">Selecciona un usuario…</option>';
      (data.users || []).forEach((user) => {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = userLabel(user);
        select.appendChild(option);
      });
      const match = (data.users || []).find((user) => String(user.id) === String(requestedUserId));
      if (match) {
        select.value = String(match.id);
        currentUserId = String(match.id);
        await loadUserLoans(currentUserId);
      } else {
        currentUserId = '';
        root.querySelector('#apexLoanWorkspace').innerHTML = '<p style="color:#777;text-align:center;padding:18px">Selecciona un usuario para consultar o gestionar sus préstamos.</p>';
      }
      notice((data.users || []).length ? '' : 'No se encontraron usuarios con esa búsqueda.', 'info');
    } catch (error) {
      select.innerHTML = '<option value="">No se pudieron cargar usuarios</option>';
      notice(error.message, 'error');
    }
  }

  async function loadUserLoans(userId) {
    const root = ensureModal();
    const workspace = root.querySelector('#apexLoanWorkspace');
    if (!workspace || !userId) return;
    currentUserId = String(userId);
    workspace.innerHTML = '<p style="color:#777;text-align:center;padding:18px">Cargando préstamos…</p>';
    try {
      const data = await api('/api/admin/user/' + encodeURIComponent(userId) + '/loans');
      const user = data.user || {};
      root.querySelector('#apexLoanModalUser').textContent = `${[user.nombre, user.apellido].filter(Boolean).join(' ') || 'Usuario'} · ${user.telefono || 'ID ' + user.id}`;
      renderUserLoans(data);
      notice('', 'info');
    } catch (error) {
      workspace.innerHTML = '';
      notice(error.message, 'error');
    }
  }

  function actionButton(mode, label) {
    const selected = activeMode === mode;
    return `<button type="button" class="btn ${selected ? 'btn-primary' : 'btn-secondary'} apex-loan-mode" data-mode="${mode}" aria-pressed="${selected}" style="padding:9px 12px;${selected ? '' : 'background:#fff;border:1px solid #ddd;color:#333;'}">${label}</button>`;
  }

  function renderUserLoans(data) {
    const workspace = ensureModal().querySelector('#apexLoanWorkspace');
    const user = data.user || {};
    const summary = data.summary || {};
    const loans = Array.isArray(data.loans) ? data.loans : [];
    const activeLoans = loans.filter((loan) => loan.status !== 'pagado' && Number(loan.outstanding) > 0);
    const history = loans.length ? loans.map((loan) => {
      const paid = Math.max(0, Number(loan.principal || 0) - Number(loan.outstanding || 0));
      const isPaid = loan.status === 'pagado' || Number(loan.outstanding) <= 0;
      const payments = Array.isArray(loan.payments) ? loan.payments : [];
      return `<article style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:12px 0;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><strong>Préstamo #${escapeHtml(loan.id)}</strong><span style="font-size:11px;font-weight:700;border-radius:12px;padding:4px 9px;background:${isPaid ? '#e8f5e9' : '#fff8e1'};color:${isPaid ? '#2e7d32' : '#e65100'}">${isPaid ? 'PAGADO' : 'PENDIENTE'}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin:10px 0;font-size:13px"><span>Prestado: <b>$${money(loan.principal)}</b></span><span>Abonado: <b>$${money(paid)}</b></span><span>Debe: <b>$${money(loan.outstanding)}</b></span><span>Fecha: ${dateText(loan.issued_at)}</span></div>
        <div style="font-size:11px;color:#666">Otorgado por: ${escapeHtml(loan.recorded_by_name || (loan.created_by ? 'Admin #' + loan.created_by : '—'))}</div>
        ${payments.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#555">Ver ${payments.length} abono(s)</summary><ul style="margin:8px 0 0 18px;font-size:12px">${payments.map((payment) => `<li>$${money(payment.amount)} · ${dateText(payment.paid_at)} · Registró: ${escapeHtml(payment.recorded_by_name || (payment.created_by ? 'Admin #' + payment.created_by : '—'))}</li>`).join('')}</ul></details>` : '<div style="font-size:12px;color:#777;margin-top:7px">Sin abonos registrados.</div>'}
      </article>`;
    }).join('') : '<p style="color:#777;text-align:center;padding:16px">Este usuario todavía no tiene préstamos registrados.</p>';

    let actionContent = '';
    if (activeMode === 'create') {
      actionContent = `<form id="apexLoanCreateForm" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:14px;background:#f8f9fa;border-radius:10px">
        <label style="font-size:11px;color:#555">Monto del préstamo (USDT)<input name="amount" type="number" min="0.000001" step="0.000001" required placeholder="0.00" style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px;width:190px"></label>
        <label style="font-size:11px;color:#555">Fecha<input name="issuedAt" type="date" style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px"></label>
        <button type="submit" class="btn btn-primary">Confirmar préstamo y acreditar saldo</button>
        <div style="flex-basis:100%;font-size:11px;color:#666">El monto se sumará al balance disponible y se registrará como deuda, sin contabilizarse como ganancia.</div>
      </form>`;
    } else if (activeMode === 'payment') {
      actionContent = activeLoans.length ? `<form id="apexLoanPaymentForm" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:14px;background:#f8f9fa;border-radius:10px">
        <label style="font-size:11px;color:#555;min-width:230px">Préstamo al que se aplica el abono<select name="loanId" required style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px;width:100%;margin-top:4px">${activeLoans.map((loan) => `<option value="${escapeHtml(loan.id)}" data-outstanding="${Number(loan.outstanding)}">#${escapeHtml(loan.id)} · Debe $${money(loan.outstanding)}</option>`).join('')}</select></label>
        <label style="font-size:11px;color:#555">Monto del abono<input name="amount" type="number" min="0.000001" step="0.000001" required placeholder="0.00" style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px;width:190px"></label>
        <button type="submit" class="btn btn-primary">Confirmar abono</button>
        <div style="flex-basis:100%;font-size:11px;color:#666">Balance disponible: <b>$${money(user.balance)}</b>. El abono no puede superar el balance ni la deuda del préstamo elegido.</div>
      </form>` : '<div style="padding:14px;background:#f8f9fa;border-radius:10px;color:#666">No hay préstamos pendientes a los que aplicar abonos.</div>';
    } else {
      actionContent = `<div><strong>Historial de préstamo</strong>${history}</div>`;
    }

    workspace.innerHTML = `
      <section style="border-bottom:1px solid #eee;padding-bottom:14px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center"><div><strong style="font-size:16px">${escapeHtml([user.nombre, user.apellido].filter(Boolean).join(' ') || 'Usuario')}</strong><div style="font-size:12px;color:#666;margin-top:4px">ID ${escapeHtml(user.id)} · ${escapeHtml(user.telefono || '')}</div></div><div style="background:#f3f6fb;border-radius:10px;padding:10px 14px;font-size:13px">Balance disponible: <b>$${money(user.balance)}</b></div></div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:13px"><span>Total prestado: <b>$${money(summary.principal)}</b></span><span>Total abonado: <b>$${money(summary.abonado)}</b></span><span>Deuda pendiente: <b>$${money(summary.pendiente)}</b></span></div>
      </section>
      <nav aria-label="Acciones de préstamo" style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 14px">${actionButton('create', 'Otorgar préstamo')}${actionButton('payment', 'Abonar')}${actionButton('history', 'Historial de préstamo')}</nav>
      <div id="apexLoanActionContent">${actionContent}</div>`;
    const loanSelect = workspace.querySelector('#apexLoanPaymentForm select[name="loanId"]');
    const paymentAmount = workspace.querySelector('#apexLoanPaymentForm input[name="amount"]');
    if (loanSelect && paymentAmount) {
      const syncLimit = () => {
        const debt = Number(loanSelect.selectedOptions[0]?.dataset.outstanding || 0);
        paymentAmount.max = String(Math.max(0, Math.min(debt, Number(user.balance || 0))));
      };
      loanSelect.addEventListener('change', syncLimit);
      syncLimit();
    }
  }

  async function submitLoanForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    if (!currentUserId) throw new Error('Selecciona primero un usuario.');
    const formData = new FormData(form);
    const payload = { amount: String(formData.get('amount') || '').trim() };
    const issuedAt = String(formData.get('issuedAt') || '').trim();
    if (issuedAt) payload.issuedAt = issuedAt;
    if (submit) submit.disabled = true;
    try {
      await api('/api/admin/user/' + encodeURIComponent(currentUserId) + '/loans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      await refreshAdminUsers();
      await loadUserLoans(currentUserId);
      notice('Préstamo registrado y acreditado al balance disponible.', 'success');
    } finally { if (submit) submit.disabled = false; }
  }

  function makeIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      return (char === 'x' ? random : (random & 3 | 8)).toString(16);
    });
  }

  async function submitPaymentForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const loanId = String(formData.get('loanId') || '').trim();
    const amount = String(formData.get('amount') || '').trim();
    let keyField = form.querySelector('[name="idempotencyKey"]');
    if (!keyField) { keyField = document.createElement('input'); keyField.type = 'hidden'; keyField.name = 'idempotencyKey'; form.appendChild(keyField); }
    if (!keyField.value) keyField.value = makeIdempotencyKey();
    if (submit) submit.disabled = true;
    try {
      await api('/api/admin/loans/' + encodeURIComponent(loanId) + '/payments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, idempotencyKey: keyField.value }) });
      await refreshAdminUsers();
      activeMode = 'history';
      await loadUserLoans(currentUserId);
      notice('Abono registrado; se descontó del balance y de la deuda.', 'success');
    } catch (error) {
      if (/balance|deuda|supera|mayor/i.test(error.message)) keyField.value = '';
      throw error;
    } finally { if (submit) submit.disabled = false; }
  }

  function openForUser(userId) {
    const id = String(userId || '').trim();
    if (!/^\d+$/.test(id)) return;
    currentUserId = id;
    activeMode = 'history';
    const root = ensureModal();
    root.classList.add('show');
    root.querySelector('#apexLoanSearch').value = id;
    root.querySelector('#apexLoanUserSelect').innerHTML = '<option value="">Cargando usuario…</option>';
    root.querySelector('#apexLoanWorkspace').innerHTML = '<p style="color:#777;text-align:center;padding:18px">Cargando datos del usuario…</p>';
    searchUsers();
  }

  function enhanceUsersTable() {
    const body = document.getElementById('usersTableBody');
    if (!body) return;
    const table = body.closest('table');
    const headers = table && table.querySelectorAll('thead th');
    if (headers && headers[5] && headers[5].textContent.trim() !== 'Debe') headers[5].textContent = 'Debe';
    let users = [];
    try { users = typeof getUsers === 'function' ? getUsers() : []; } catch (_) {}
    body.querySelectorAll('tr').forEach((row) => {
      if (!row.cells || row.cells.length < 11) return;
      const phone = String(row.cells[2].textContent || '').trim();
      const user = users.find((item) => String(item.telefono || '') === phone);
      const dueText = '$' + money(user?.deuda_pendiente || 0);
      const debtCell = row.cells[5];
      if (debtCell.textContent.trim() !== dueText) {
        debtCell.innerHTML = `<strong style="white-space:nowrap;color:${Number(user?.deuda_pendiente || 0) > 0 ? '#b45309' : '#444'}">${dueText}</strong>`;
      }
      const actionBox = row.cells[row.cells.length - 1].querySelector('.action-buttons');
      if (!actionBox || actionBox.dataset.apexLoansEnhanced === '1') return;
      actionBox.dataset.apexLoansEnhanced = '1';
      const historyButton = document.createElement('button');
      historyButton.type = 'button'; historyButton.className = 'btn btn-info btn-sm'; historyButton.textContent = '📜 Historial'; historyButton.title = 'Ver historial';
      historyButton.addEventListener('click', () => { if (typeof window.verIngresosUsuario === 'function') window.verIngresosUsuario(phone); });
      const loansButton = document.createElement('button');
      loansButton.type = 'button'; loansButton.className = 'btn btn-primary btn-sm'; loansButton.textContent = '💳 Préstamos'; loansButton.title = 'Otorgar préstamo, abonar o consultar el historial de préstamo';
      loansButton.addEventListener('click', () => openForUser(user?.id || row.cells[0].textContent.trim()));
      actionBox.append(historyButton, loansButton);
    });
  }

  function init() {
    ensureModal();
    enhanceUsersTable();
    const usersBody = document.getElementById('usersTableBody');
    // Observe only direct row insertions. Subtree observation re-triggered forever when
    // this module formatted the debt cell, freezing the original admin interface.
    if (usersBody && window.MutationObserver) new MutationObserver(enhanceUsersTable).observe(usersBody, { childList: true });
  }

  window.apexOpenLoansForUser = openForUser;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
