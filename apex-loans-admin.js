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

  async function api(path, options) {
    if (!apiBase) throw new Error('No se encontró la URL de la API.');
    const currentToken = token();
    if (!currentToken) throw new Error('La sesión administrativa expiró. Vuelve a iniciar sesión.');
    const response = await fetch(apiBase + path, {
      cache: 'no-store',
      ...(options || {}),
      headers: {
        Accept: 'application/json',
        ...(options && options.headers ? options.headers : {}),
        Authorization: 'Bearer ' + currentToken
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'No se pudo completar la solicitud.');
    return body;
  }

  function notice(message, kind) {
    const node = document.getElementById('apexLoanNotice');
    if (!node) return;
    node.textContent = message || '';
    node.style.display = message ? 'block' : 'none';
    node.style.padding = message ? '10px 12px' : '0';
    node.style.marginTop = message ? '12px' : '0';
    node.style.borderRadius = '8px';
    node.style.background = kind === 'error' ? '#ffebee' : kind === 'success' ? '#e8f5e9' : '#e3f2fd';
    node.style.color = kind === 'error' ? '#b71c1c' : kind === 'success' ? '#1b5e20' : '#0d47a1';
  }

  function userLabel(user) {
    const name = [user.nombre, user.apellido].filter(Boolean).join(' ').trim() || 'Usuario';
    return `#${user.id} · ${name} · ${user.telefono || 'sin teléfono'}`;
  }

  async function searchUsers() {
    const select = document.getElementById('apexLoanUserSelect');
    const search = document.getElementById('apexLoanSearch');
    if (!select || !search) return;
    const previous = select.value;
    select.innerHTML = '<option value="">Cargando usuarios…</option>';
    try {
      const data = await api('/api/admin/loans/users?search=' + encodeURIComponent(search.value.trim()));
      select.innerHTML = '<option value="">Selecciona un usuario…</option>';
      (data.users || []).forEach((user) => {
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = userLabel(user);
        select.appendChild(option);
      });
      if (previous && Array.from(select.options).some((option) => option.value === previous)) {
        select.value = previous;
        await loadUserLoans(previous);
      } else {
        const workspace = document.getElementById('apexLoanWorkspace');
        if (workspace) workspace.innerHTML = '<p style="color:#777;text-align:center;padding:18px">Selecciona un usuario para consultar o registrar sus préstamos.</p>';
      }
      notice((data.users || []).length ? '' : 'No se encontraron usuarios con esa búsqueda.', 'info');
    } catch (error) {
      select.innerHTML = '<option value="">No se pudieron cargar usuarios</option>';
      notice(error.message, 'error');
    }
  }

  async function loadUserLoans(userId) {
    const workspace = document.getElementById('apexLoanWorkspace');
    if (!workspace || !userId) return;
    workspace.innerHTML = '<p style="color:#777;text-align:center;padding:18px">Cargando préstamos…</p>';
    try {
      const data = await api('/api/admin/user/' + encodeURIComponent(userId) + '/loans');
      renderUserLoans(data);
      notice('', 'info');
    } catch (error) {
      workspace.innerHTML = '';
      notice(error.message, 'error');
    }
  }

  function renderUserLoans(data) {
    const workspace = document.getElementById('apexLoanWorkspace');
    if (!workspace) return;
    const user = data.user || {};
    const summary = data.summary || {};
    const loans = Array.isArray(data.loans) ? data.loans : [];
    const loanCards = loans.length ? loans.map((loan) => {
      const paid = Math.max(0, Number(loan.principal || 0) - Number(loan.outstanding || 0));
      const isPaid = loan.status === 'pagado' || Number(loan.outstanding) <= 0;
      const payments = Array.isArray(loan.payments) ? loan.payments : [];
      return `<article style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;margin:12px 0;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center">
          <strong>Préstamo #${escapeHtml(loan.id)}</strong>
          <span style="font-size:11px;font-weight:700;border-radius:12px;padding:4px 9px;background:${isPaid ? '#e8f5e9' : '#fff8e1'};color:${isPaid ? '#2e7d32' : '#e65100'}">${isPaid ? 'PAGADO' : 'PENDIENTE'}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin:10px 0;font-size:13px">
          <span>Prestado: <b>$${money(loan.principal)}</b></span><span>Abonado: <b>$${money(paid)}</b></span><span>Debe: <b>$${money(loan.outstanding)}</b></span><span>Fecha: ${dateText(loan.issued_at)}</span>
        </div>
        ${payments.length ? `<details><summary style="cursor:pointer;font-size:12px;color:#555">Ver ${payments.length} abono(s)</summary><ul style="margin:8px 0 0 18px;font-size:12px">${payments.map((payment) => `<li>$${money(payment.amount)} · ${dateText(payment.paid_at)}</li>`).join('')}</ul></details>` : '<div style="font-size:12px;color:#777">Sin abonos registrados.</div>'}
        ${!isPaid ? `<form class="apex-loan-payment" data-loan-id="${escapeHtml(loan.id)}" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;align-items:end">
          <label style="font-size:11px;color:#555">Registrar abono (máx. $${money(loan.outstanding)})<input name="amount" type="number" min="0.000001" max="${Number(loan.outstanding)}" step="0.000001" required style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px;width:190px"></label>
          <button type="submit" class="btn btn-primary">Registrar abono</button>
        </form>` : ''}
      </article>`;
    }).join('') : '<p style="color:#777;text-align:center;padding:16px">Este usuario todavía no tiene préstamos registrados.</p>';

    workspace.innerHTML = `
      <section style="border-bottom:1px solid #eee;padding-bottom:14px;margin-bottom:14px">
        <strong style="font-size:16px">${escapeHtml([user.nombre, user.apellido].filter(Boolean).join(' ') || 'Usuario')}</strong>
        <div style="font-size:12px;color:#666;margin-top:4px">ID ${escapeHtml(user.id)} · ${escapeHtml(user.telefono || '')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:13px">
          <span>Total prestado: <b>$${money(summary.principal)}</b></span><span>Total abonado: <b>$${money(summary.abonado)}</b></span><span>Deuda pendiente: <b>$${money(summary.pendiente)}</b></span>
        </div>
      </section>
      <form id="apexLoanCreateForm" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:14px;background:#f8f9fa;border-radius:10px">
        <label style="font-size:11px;color:#555">Monto del préstamo (USDT)<input name="amount" type="number" min="0.000001" step="0.000001" required placeholder="0.00" style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px;width:190px"></label>
        <label style="font-size:11px;color:#555">Fecha<input name="issuedAt" type="date" style="display:block;padding:9px;border:1px solid #ddd;border-radius:8px"></label>
        <button type="submit" class="btn btn-primary">Registrar préstamo</button>
        <div style="flex-basis:100%;font-size:11px;color:#666">El préstamo se registra como deuda separada; no cambia el saldo disponible de la cuenta.</div>
      </form>
      <div style="margin-top:16px"><strong>Préstamos y abonos</strong>${loanCards}</div>`;
  }

  async function submitLoanForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const selectedUser = document.getElementById('apexLoanUserSelect')?.value;
    if (!selectedUser) throw new Error('Selecciona primero un usuario.');
    const formData = new FormData(form);
    const payload = { amount: String(formData.get('amount') || '').trim() };
    const issuedAt = String(formData.get('issuedAt') || '').trim();
    if (issuedAt) payload.issuedAt = issuedAt;
    if (submit) submit.disabled = true;
    try {
      await api('/api/admin/user/' + encodeURIComponent(selectedUser) + '/loans', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      await loadUserLoans(selectedUser);
      notice('Préstamo registrado correctamente.', 'success');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  async function submitPaymentForm(form) {
    const submit = form.querySelector('button[type="submit"]');
    const amount = String(new FormData(form).get('amount') || '').trim();
    if (submit) submit.disabled = true;
    try {
      await api('/api/admin/loans/' + encodeURIComponent(form.dataset.loanId) + '/payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount })
      });
      const selectedUser = document.getElementById('apexLoanUserSelect')?.value;
      if (selectedUser) await loadUserLoans(selectedUser);
      notice('Abono registrado; la deuda pendiente ya fue actualizada.', 'success');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function init() {
    const search = document.getElementById('apexLoanSearch');
    const searchButton = document.getElementById('apexLoanSearchButton');
    const userSelect = document.getElementById('apexLoanUserSelect');
    const workspace = document.getElementById('apexLoanWorkspace');
    if (!search || !searchButton || !userSelect || !workspace) return;
    searchButton.addEventListener('click', searchUsers);
    search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); searchUsers(); } });
    userSelect.addEventListener('change', () => loadUserLoans(userSelect.value));
    workspace.addEventListener('submit', async (event) => {
      const form = event.target.closest('form');
      if (!form) return;
      event.preventDefault();
      try {
        if (form.id === 'apexLoanCreateForm') await submitLoanForm(form);
        else if (form.classList.contains('apex-loan-payment')) await submitPaymentForm(form);
      } catch (error) {
        notice(error.message, 'error');
      }
    });
  }

  window.apexLoadLoansAdmin = searchUsers;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
