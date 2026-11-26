// Componentes compartilhados entre o painel, a pré-ficha e a validação pública.
export const app = document.querySelector('#app');
export const message = document.querySelector('#message');
export const byId = id => document.getElementById(id);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const icon = name => `<img class="icon" src="/icones/${name}.svg" width="24" height="24" alt="">`;
export const formData = form => Object.fromEntries(new FormData(form));
export const date = value => new Date(value).toLocaleString('pt-BR', {
  timeZone: 'America/Manaus', dateStyle: 'short', timeStyle: 'short'
});
export const phoneKey = value => String(value ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
export const fold = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export async function api(path, payload) {
  const response = await fetch('/api' + path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

// Deixa os dados do formulário disponíveis após erros e bloqueia cliques repetidos.
export function action(element, event, callback) {
  element.addEventListener(event, async e => {
    e.preventDefault();
    const button = e.submitter || (element instanceof HTMLButtonElement ? element : null);
    if (button) button.disabled = true;
    message.textContent = '';
    try { await callback(e); }
    catch (error) { message.textContent = error.message || 'Tente novamente.'; }
    finally { if (button) button.disabled = false; }
  });
}
