import { app, message, byId, escape, api, action, formData, icon } from './ui.js';
import { createDashboard } from './painel.js';

const assessmentFields = ['Couro cabeludo', 'Condição dos fios', 'Teste de mecha', 'Produtos e fórmula', 'Orientações'];
const labels = { name: 'Nome', phone: 'WhatsApp', procedure: 'Procedimento', chemical: 'Química recente', details: 'Histórico de química', reaction: 'Reações relatadas', notes: 'Observações' };
const input = (name, label, value = '') => `<label>${escape(label)}<input name="${name}" value="${escape(value)}" maxlength="150" required></label>`;
const area = (name, label, value = '', limit = 1400) =>
  `<label>${escape(label)}<textarea name="${escape(name)}" maxlength="${limit}">${escape(value)}</textarea></label>`;
const summary = fields => '<dl>' + Object.entries(fields).map(([key, value]) =>
  `<dt>${escape(key)}</dt><dd>${escape(value || 'Não informado')}</dd>`).join('') + '</dl>';

async function prefill(path) {
  const data = await api(path);
  const showComplete = number => {
    app.innerHTML = `<h1>Pré-ficha enviada</h1><p>O salão já pode consultar suas respostas.</p>
      <p class="badge">Ficha ${escape(number)}</p>`;
  };
  if (data.submitted) return showComplete(data.number);
  app.innerHTML = `<h1>Pré-cadastro</h1><p>${escape(data.salon)}</p>
    <form id="pre">
      ${input('name', 'Seu nome')}
      <label>WhatsApp com DDD<input name="phone" type="tel" autocomplete="tel" maxlength="25" required></label>
      ${data.procedure ? `<p class="badge">${escape(data.procedure)}</p>` : input('procedure', 'Qual procedimento você deseja?')}
      <label>Fez química nos últimos meses?<select name="chemical" required>
        <option value="">Selecione</option><option>Sim</option><option>Não</option><option>Não sei</option>
      </select></label>
      ${area('details', 'Qual procedimento fez e quando?', '', 1200)}
      ${area('reaction', 'Já teve reação ou desconforto com algum produto?', '', 1200)}
      ${area('notes', 'Observações para o atendimento', '', 1200)}
      <button class="primary">Enviar pré-ficha</button>
    </form>`;
  const form = byId('pre');
  const update = () => { form.elements.details.closest('label').hidden = form.elements.chemical.value !== 'Sim'; };
  form.elements.chemical.addEventListener('change', update);
  update();
  action(form, 'submit', async () => {
    const payload = formData(form);
    if (payload.chemical !== 'Sim') payload.details = '';
    const result = await api(path, { ...payload, procedure: data.procedure || payload.procedure });
    showComplete(result.number);
  });
}

async function validate(path) {
  const data = await api(path);
  app.innerHTML = `<h1>Validar documento</h1><p class="badge">Registro encontrado</p>
    <section class="card">${summary({ Código: data.number, Status: data.replaced ? 'Substituído' : 'Emitido',
      Data: new Date(data.issued).toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' }) })}</section>
    <label>Conferir arquivo PDF<input id="document" type="file" accept=".pdf,application/pdf"></label>
    <p>Selecione o PDF para comparar com o arquivo emitido.</p>`;
  byId('document').addEventListener('change', async ({ target }) => {
    const file = target.files[0];
    if (!file) return;
    if (file.size > 20_000_000) return message.textContent = 'Selecione um PDF de até 20 MB.';
    try {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (target.files[0] !== file) return;
      message.textContent = digest === data.digest ? 'O arquivo corresponde ao PDF emitido.' : 'O arquivo é diferente do PDF emitido.';
    } catch { message.textContent = 'Não foi possível conferir o arquivo. Use uma conexão HTTPS.'; }
  });
}

function sign(canvas) {
  const context = canvas.getContext('2d');
  context.lineWidth = 3;
  context.lineCap = 'round';
  context.strokeStyle = '#10243b';
  let pointer = null;
  let drawn = false;
  const point = e => {
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height];
  };
  canvas.addEventListener('pointerdown', e => {
    if (pointer !== null) return;
    pointer = e.pointerId;
    canvas.setPointerCapture(pointer);
    context.beginPath();
    context.moveTo(...point(e));
  });
  canvas.addEventListener('pointermove', e => {
    if (pointer !== e.pointerId) return;
    context.lineTo(...point(e));
    context.stroke();
    drawn = true;
  });
  canvas.addEventListener('lostpointercapture', () => { pointer = null; });
  byId('clear').onclick = () => { context.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };
  return () => drawn ? canvas.toDataURL() : '';
}

async function compress(file) {
  if (!file || file.size > 20_000_000) throw new Error('Selecione uma imagem de até 20 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .82);
  } finally { bitmap.close(); }
}

async function openForm(id, { repaint = dashboard, target = app } = {}) {
  const endpoint = '/forms/' + id;
  const data = await api(endpoint);
  const customer = Object.fromEntries(Object.entries(data.customer).map(([key, value]) => [labels[key], value]));
  target.innerHTML = `<button id="back" class="back">${icon('voltar')} Voltar</button><h1>Ficha da cliente</h1>
    <p class="badge">${escape(data.number)} · ${data.issued ? 'PDF emitido' : 'Pré-ficha recebida'}</p>
    <details class="card" open><summary>Respostas da cliente</summary>${summary(customer)}</details>
    ${data.issued ? `<section><a class="button primary" href="/api${endpoint}/pdf">Baixar PDF</a></section>` : ''}
    <form id="assessment" class="card work-form">
      <h2>Avaliação profissional</h2>
      ${assessmentFields.map(label => area(label, label, data.assessment[label])).join('')}
      <button id="draft" type="button">Salvar avaliação</button>
      <h2>Fotos para o PDF</h2>
      <label>Antes<input id="before" type="file" accept="image/*"><img id="before-preview" class="photo" alt="Antes" hidden></label>
      <label>Depois<input id="after" type="file" accept="image/*"><img id="after-preview" class="photo" alt="Depois" hidden></label>
      <h2>Revisar termos e assinatura</h2>
      ${area('terms', 'Termo apresentado à cliente', '', 3600)}
      <label class="check"><input name="publicity" type="checkbox"> A cliente autoriza a divulgação das fotos.</label>
      <label for="signature">Assinatura da cliente</label>
      <canvas id="signature" width="640" height="150" aria-label="Área para desenhar a assinatura"></canvas>
      <button id="clear" type="button">Refazer assinatura</button>
      ${data.issued ? '<label class="check"><input name="replace" type="checkbox" required> Confirmo a substituição do documento anterior.</label>' : ''}
      <button class="primary">${data.issued ? 'Assinar e emitir nova versão' : 'Assinar e emitir PDF'}</button>
    </form>`;
  action(byId('back'), 'click', repaint);
  const form = byId('assessment');
  const signature = sign(byId('signature'));
  const assessment = () => Object.fromEntries(assessmentFields.map(name => [name, form.elements[name].value]));
  action(byId('draft'), 'click', async () => {
    await api(endpoint, { assessment: assessment() });
    message.textContent = 'Avaliação salva.';
  });
  const photos = {};
  for (const [inputId, label] of [['before','Antes'],['after','Depois']]) {
    byId(inputId).addEventListener('change', async ({ target }) => {
      const preview = byId(inputId + '-preview');
      const file = target.files[0];
      preview.hidden = true;
      delete photos[label];
      if (!file) return;
      try {
        const dataUrl = await compress(file);
        if (target.files[0] !== file) return;
        photos[label] = dataUrl;
        preview.src = dataUrl;
        preview.hidden = false;
      } catch { message.textContent = 'Não foi possível ler a foto. Escolha outra imagem.'; }
    });
  }
  action(form, 'submit', async () => {
    if (!signature()) throw new Error('A cliente precisa assinar antes de emitir.');
    if (['before','after'].some((key, i) => byId(key).files[0] && !photos[i ? 'Depois' : 'Antes'])) throw new Error('Confira o carregamento das fotos.');
    const values = formData(form);
    await api(endpoint + '/emitir', { assessment: assessment(), photos, signature: signature(), terms: values.terms,
      publicity: Boolean(values.publicity), replace: Boolean(values.replace), version: data.version });
    await openForm(id, { repaint, target });
    message.textContent = 'PDF emitido. A cópia está disponível para baixar.';
    window.scrollTo(0, 0);
  });
}

const dashboard = createDashboard(openForm);

const path = location.pathname;
try {
  if (path.startsWith('/pre/')) await prefill(path);
  else if (path.startsWith('/validar/')) await validate(path);
  else await dashboard();
} catch (error) {
  app.textContent = error.message || 'Não foi possível abrir esta página.';
}
