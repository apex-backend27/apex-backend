(function () {
  'use strict';

  const apiBase = (typeof API_URL !== 'undefined' && API_URL) || window.API_URL || '';
  const token = () => localStorage.getItem('apex_token') || sessionStorage.getItem('apex_token') || '';
  const money = (value) => Number(value || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let loanDataKnown = false;
  let confirmedHasLoans = false;
  let loading = false;

  const dateText = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString('es-PE');
  };

  function updateActivityVisibility() {
    const tile = document.querySelector('[data-apex-loans-activity]');
    if (tile) tile.style.display = loanDataKnown && confirmedHasLoans ? '' : 'none';
    if (loanDataKnown && !confirmedHasLoans) {
      const card = document.getElementById('apexUserLoansCard');
      const grid = document.getElementById('actividadesGrid');
      if (card) card.style.display = 'none';
      if (grid) grid.style.display = '';
    }
  }

  function showMessage(message, isError) {
    const list = document.getElementById('apexUserLoansList');
    if (!list) return;
    list.innerHTML = `<div style="text-align:center;padding:14px;color:${isError ? '#b71c1c' : '#777'}">${escapeHtml(message)}</div>`;
  }

  function render(data) {
    const principal = document.getElementById('apexUserLoansPrincipal');
    const paid = document.getElementById('apexUserLoansPaid');
    const due = document.getElementById('apexUserLoansDue');
    const list = document.getElementById('apexUserLoansList');
    if (!principal || !paid || !due || !list) return;

    const currentBalance = Number(data.balance);
    if (Number.isFinite(currentBalance)) {
      const balanceNode = document.getElementById('balanceAmount');
      if (balanceNode) balanceNode.textContent = '$' + currentBalance.toFixed(2);
      if (window.user && typeof window.user === 'object') window.user.balance = currentBalance;
      ['localStorage', 'sessionStorage'].forEach((storageName) => {
        try {
          const storage = window[storageName];
          const stored = JSON.parse(storage.getItem('apex_user') || 'null');
          if (stored) {
            stored.balance = currentBalance;
            storage.setItem('apex_user', JSON.stringify(stored));
          }
        } catch (_) {}
      });
    }

    const summary = data.summary || {};
    const loans = Array.isArray(data.loans) ? data.loans : [];
    loanDataKnown = true;
    confirmedHasLoans = loans.length > 0;
    updateActivityVisibility();
    principal.textContent = '$' + money(summary.principal);
    paid.textContent = '$' + money(summary.abonado);
    due.textContent = '$' + money(summary.pendiente);

    if (!loans.length) {
      list.innerHTML = '<div style="text-align:center;padding:14px;color:#777">No tienes préstamos registrados.</div>';
      return;
    }
    list.innerHTML = loans.map((loan) => {
      const isPaid = loan.status === 'pagado' || Number(loan.outstanding) <= 0;
      const payments = Array.isArray(loan.payments) ? loan.payments : [];
      return `<article style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-top:10px;background:#fff">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
          <strong>Préstamo #${escapeHtml(loan.id)}</strong>
          <span style="font-size:10px;font-weight:700;border-radius:12px;padding:4px 8px;background:${isPaid ? '#e8f5e9' : '#fff8e1'};color:${isPaid ? '#2e7d32' : '#e65100'}">${isPaid ? 'PAGADO' : 'PENDIENTE'}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:12px;color:#444">
          <span>Monto: <b>$${money(loan.principal)}</b></span>
          <span>Abonado: <b>$${money(Number(loan.principal) - Number(loan.outstanding))}</b></span>
          <span>Saldo pendiente: <b>$${money(loan.outstanding)}</b></span>
        </div>
        <div style="font-size:11px;color:#777;margin-top:6px">Fecha: ${dateText(loan.issued_at)} · Registrado por: ${escapeHtml(loan.recorded_by_name || (loan.created_by ? 'Admin #' + loan.created_by : '—'))}</div>
        ${payments.length ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:11px;color:#555">Historial de ${payments.length} abono(s)</summary><ul style="margin:7px 0 0 18px;font-size:11px;color:#555">${payments.map((payment) => `<li>$${money(payment.amount)} · ${dateText(payment.paid_at)} · Registró: ${escapeHtml(payment.recorded_by_name || (payment.created_by ? 'Admin #' + payment.created_by : '—'))}</li>`).join('')}</ul></details>` : '<div style="font-size:11px;color:#777;margin-top:7px">Todavía no hay abonos registrados.</div>'}
      </article>`;
    }).join('');
  }

  async function loadUserLoans() {
    const list = document.getElementById('apexUserLoansList');
    if (!list || loading) return;
    const currentToken = token();
    if (!currentToken) {
      showMessage('Inicia sesión para consultar tus préstamos.', false);
      return;
    }
    if (!apiBase) {
      loanDataKnown = true;
      confirmedHasLoans = true;
      updateActivityVisibility();
      showMessage('No se encontró la URL del servicio.', true);
      return;
    }

    loading = true;
    try {
      const response = await fetch(apiBase + '/api/me/loans?t=' + Date.now(), {
        method: 'GET',
        cache: 'no-store',
        headers: { Authorization: 'Bearer ' + currentToken, Accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = data.error
          ? `${data.error}${data.code ? ` (${data.code})` : ''}`
          : `Error HTTP ${response.status}`;
        throw new Error(response.status >= 500
          ? `${detail}. Verifica que el server.js actualizado esté desplegado en Render y revisa los logs de esa ruta si persiste.`
          : detail);
      }
      render(data);
    } catch (error) {
      loanDataKnown = true;
      confirmedHasLoans = true;
      updateActivityVisibility();
      showMessage(error.message || 'No se pudieron cargar tus préstamos.', true);
    } finally {
      loading = false;
    }
  }

  function openLoansActivity() {
    const grid = document.getElementById('actividadesGrid');
    const card = document.getElementById('apexUserLoansCard');
    if (grid) grid.style.display = 'none';
    if (card) {
      card.style.display = 'block';
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    loadUserLoans();
  }

  function closeLoansActivity() {
    const grid = document.getElementById('actividadesGrid');
    const card = document.getElementById('apexUserLoansCard');
    if (card) card.style.display = 'none';
    if (grid) grid.style.display = '';
    loadUserLoans();
  }

  function installLoansActivity() {
    const baseRender = window.renderActividades;
    if (typeof baseRender === 'function' && !baseRender.__apexLoansActivity) {
      const wrappedRender = function () {
        const result = baseRender.apply(this, arguments);
        const grid = document.getElementById('actividadesGrid');
        if (grid && !grid.querySelector('[data-apex-loans-activity]')) {
          grid.insertAdjacentHTML('beforeend', '<div class="actividad-card" data-apex-loans-activity style="display:none" onclick="apexOpenUserLoansActivity()"><span class="badge-prox">Consultar</span><span class="icono">💳</span><div class="nombre">Mis préstamos</div><div class="desc">Consulta tus abonos y deuda pendiente</div><div class="estado">Ver estado</div></div>');
        }
        updateActivityVisibility();
        return result;
      };
      wrappedRender.__apexLoansActivity = true;
      window.renderActividades = wrappedRender;
    }

    const baseSwitchTab = window.switchTab;
    if (typeof baseSwitchTab === 'function' && !baseSwitchTab.__apexLoansActivity) {
      const wrappedSwitchTab = function () {
        const result = baseSwitchTab.apply(this, arguments);
        if (arguments[0] === 'actividades') closeLoansActivity();
        return result;
      };
      wrappedSwitchTab.__apexLoansActivity = true;
      window.switchTab = wrappedSwitchTab;
    }

    window.apexOpenUserLoansActivity = openLoansActivity;
    window.apexCloseUserLoansActivity = closeLoansActivity;
  }

  installLoansActivity();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadUserLoans, { once: true });
  else loadUserLoans();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadUserLoans(); });
  window.addEventListener('focus', loadUserLoans);
  window.setInterval(() => { if (!document.hidden) loadUserLoans(); }, 10000);
})();
