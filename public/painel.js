import { app, message, byId, escape, icon, api, action, formData, date, phoneKey, fold } from './ui.js';

const sections = [
  ['inicio', 'Início'], ['clientes', 'Clientes'], ['documentos', 'Documentos'], ['configuracoes', 'Configurações']
];
const models = ['Avaliação capilar', 'Coloração', 'Alisamento'];
const notices = {
  aceito: 'Aviso aceito pelo WhatsApp', sem_integracao: 'WhatsApp sem integração',
  incerto: 'Envio sem confirmação', rejeitado: 'Aviso recusado pelo WhatsApp', em_envio: 'Aviso em processamento'
};
const settings = [
  ['perfil', 'Perfil do salão', 'cliente'], ['equipe', 'Equipe', 'clientes'],
  ['modelos', 'Modelos de ficha', 'ficha'], ['drive', 'Armazenamento', 'documentos']
];

const sectionLink = (id, label, selected) => `<button data-section="${id}" ${selected === id ? 'aria-current="page"' : ''}>${icon(id)}<span>${label}</span></button>`;
const row = ({ title, subtitle, glyph = 'ficha', extra = '', type = '', value = '' }) => `<button class="record" data-${type}="${escape(value)}">
  <span class="record-icon">${icon(glyph)}</span><span class="record-text"><strong>${escape(title)}</strong><small>${escape(subtitle)}</small></span>
  ${extra}${icon('avancar')}</button>`;

function wireSearch(placeholder, source, searchValues, render, bind) {
  byId('directory').innerHTML = `<label class="search">${icon('pesquisa')}<input id="search" type="search"
    aria-label="${placeholder}" placeholder="${placeholder}"></label><div class="records" id="records"></div>`;
  const update = () => {
    const query = fold(byId('search').value.trim());
    const result = source.filter(item => fold(searchValues(item)).includes(query));
    const items = byId('records');
    items.innerHTML = result.map(render).join('') || '<p class="empty">Nenhum registro encontrado.</p>';
    bind(items);
  };
  byId('search').addEventListener('input', update);
  update();
}

function renderLogin(reopen) {
  document.body.dataset.view = 'access';
  const draw = (view = 'login') => {
    const signup = view === 'signup';
    const recovery = view === 'recovery';
    const title = signup ? 'Criar conta' : recovery ? 'Recuperar acesso' : 'Entrar no FichaPro';
    app.innerHTML = `<div class="access-panel"><h1>${title}</h1>
      ${view !== 'login' ? '<p>Esta tela será habilitada quando o cadastro e a recuperação estiverem conectados ao SuperDB.</p>' : ''}
      <form id="login">${signup ? '<label>Seu nome<input autocomplete="name" disabled></label><label>Nome do salão<input autocomplete="organization" disabled></label>' : ''}
        <label>E-mail<input name="email" type="email" autocomplete="username" ${view !== 'login' ? 'disabled' : ''}></label>
        ${recovery ? '' : `<label>Senha<span class="password"><input id="password" name="password" type="password"
          autocomplete="${signup ? 'new-password' : 'current-password'}" required ${signup ? 'disabled' : ''}>
          ${signup ? '' : '<button id="show-password" class="quiet" type="button" aria-pressed="false">Mostrar</button>'}</span></label>`}
        <button class="primary" ${view !== 'login' ? 'disabled' : ''}>${recovery ? 'Enviar link' : signup ? 'Criar conta' : 'Entrar'}</button>
      </form>
      ${view === 'login' ? '<button id="recover" class="quiet">Esqueci minha senha</button><button id="register" class="quiet">Criar conta</button>'
        : '<button id="return" class="quiet">Voltar para entrar</button>'}</div>`;
    if (view !== 'login') {
      byId('return').onclick = () => draw();
      return;
    }
    byId('recover').onclick = () => draw('recovery');
    byId('register').onclick = () => draw('signup');
    byId('show-password').onclick = ({ currentTarget: button }) => {
      const password = byId('password');
      const visible = password.type === 'password';
      password.type = visible ? 'text' : 'password';
      button.textContent = visible ? 'Ocultar' : 'Mostrar';
      button.setAttribute('aria-pressed', visible);
    };
    const form = byId('login');
    action(form, 'submit', async () => { await api('/login', formData(form)); await reopen(); });
  };
  draw();
}

function renderInvite(clients, initialPhone) {
  const panel = byId('workspace');
  panel.innerHTML = `<section class="card task-panel"><h2>Enviar pré-ficha</h2><form id="invite">
    <label>Cliente<select name="phone"><option value="">Cliente preencherá os dados</option>
    ${clients.map(client => `<option value="${escape(client.phone)}" ${initialPhone === client.phone ? 'selected' : ''}>${escape(client.name)}</option>`).join('')}</select></label>
    <label>Procedimento<select name="procedure" required><option value="">Selecionar procedimento</option>
    ${models.map(model => `<option>${model}</option>`).join('')}</select></label>
    <button class="primary">${icon('adicionar')} Gerar link</button></form><div id="invite-result" class="stack"></div></section>`;
  byId('invite').elements.procedure.focus();
  const form = byId('invite');
  action(form, 'submit', async () => {
    const fields = formData(form);
    const result = await api('/links', fields);
    const target = byId('invite-result');
    target.innerHTML = `<label>Link individual da ficha ${escape(result.number)}<input id="share-link" readonly value="${escape(result.link)}"></label>
      <a class="button accent" target="_blank" rel="noopener noreferrer" href="https://wa.me/${fields.phone ? '55' + phoneKey(fields.phone) : ''}?text=${encodeURIComponent('Olá! Preencha sua pré-ficha: ' + result.link)}">Compartilhar via WhatsApp</a>`;
    byId('share-link').onclick = ({ target: input }) => input.select();
  });
}

export function createDashboard(openForm) {
  let selected = 'inicio';
  let status = 'received';
  const shell = (title, top = '') => {
    document.body.dataset.view = 'dashboard';
    app.innerHTML = `<nav class="navigation" aria-label="Menu principal">
      ${sections.map(([id,label]) => sectionLink(id, label, selected)).join('')}</nav>
      <article class="page"><div class="page-heading"><h1>${escape(title)}</h1>${top}</div><div id="content"></div></article>`;
    app.querySelectorAll('[data-section]').forEach(button => action(button, 'click', async () => {
      selected = button.dataset.section;
      await dashboard();
    }));
  };
  const open = async id => {
    const article = app.querySelector('.page');
    try {
      // Mantém a navegação e mostra o atendimento junto à lista em telas largas.
      article?.classList.add('show-detail');
      await openForm(id, { repaint: dashboard, target: byId('workspace') });
    } catch (error) {
      article?.classList.remove('show-detail');
      throw error;
    }
  };
  const bindForms = root => root.querySelectorAll('[data-form]').forEach(button =>
    action(button, 'click', () => open(Number(button.dataset.form))));

  async function dashboard() {
    let data;
    try { data = await api('/forms'); }
    catch (error) {
      if (error.status !== 401) throw error;
      return renderLogin(dashboard);
    }
    const clients = new Map([...data.forms].reverse().map(form => [phoneKey(form.phone), { name: form.name, phone: phoneKey(form.phone) }]));
    for (const client of data.clients) clients.set(client.phone, client);
    const directory = [...clients.values()].sort((a,b) => a.name.localeCompare(b.name, 'pt-BR'));

    if (selected === 'inicio') {
      shell('Atendimentos', `<button id="new" class="primary">${icon('adicionar')} Enviar pré-ficha</button>`);
      byId('content').innerHTML = `<div class="status-grid">
        <button class="card" id="pending" aria-pressed="${status === 'pending'}">Aguardando resposta <strong>${data.pending.length}</strong></button>
        <button class="card" id="received" aria-pressed="${status === 'received'}">Pré-ficha recebida <strong>${data.forms.length}</strong></button></div>
        <div class="workspace-grid"><div id="directory"></div><aside id="workspace" aria-label="Detalhes do atendimento"></aside></div>`;
      byId('new').onclick = () => renderInvite(data.clients);
      for (const key of ['pending','received']) byId(key).onclick = async () => {
        status = key;
        try { await dashboard(); } catch (error) { message.textContent = error.message; }
      };
      wireSearch('Buscar por cliente, procedimento ou ficha', status === 'pending' ? data.pending : data.forms,
        item => [item.name,item.procedure,item.number].join(' '),
        item => row({ title: item.name || item.number, subtitle: item.procedure || item.number,
          extra: `<span class="badge">${status === 'pending' ? 'Aguardando' : 'Pré-ficha'}</span>`,
          type: status === 'pending' ? 'pending-item' : 'preview', value: item.id }),
        root => {
          root.querySelectorAll('[data-preview]').forEach(button => action(button, 'click', () => {
            const form = data.forms.find(item => item.id === Number(button.dataset.preview));
            byId('workspace').innerHTML = `<section class="card task-panel"><h2>Pré-ficha recebida</h2>
              <strong>${escape(form.name)}</strong><span>${escape(form.procedure)}</span>
              <small>${escape(date(form.submitted))} · ${escape(notices[form.notification] || '')}</small>
              <button class="primary" data-form="${form.id}">Abrir ficha</button></section>`;
            bindForms(byId('workspace'));
          }));
          root.querySelectorAll('[data-pending-item]').forEach(button => action(button, 'click', () => {
            const item = data.pending.find(entry => entry.id === Number(button.dataset.pendingItem));
            byId('workspace').innerHTML = `<section class="card task-panel"><h2>Aguardando resposta</h2><strong>${escape(item.number)}</strong><p>Link válido até ${escape(date(item.expires))}.</p></section>`;
          }));
        });
      return;
    }

    if (selected === 'clientes') {
      shell('Clientes', `<button id="new" class="primary">${icon('adicionar')} Nova cliente</button>`);
      byId('content').innerHTML = '<div class="workspace-grid"><div id="directory"></div><aside id="workspace" aria-label="Histórico da cliente"></aside></div>';
      const showHistory = client => {
        const history = data.forms.filter(form => phoneKey(form.phone) === client.phone);
        const panel = byId('workspace');
        panel.innerHTML = `<section class="task-panel card"><h2>${escape(client.name)}</h2><p>${escape(client.phone)}</p>
          <h3>Histórico</h3><div class="records timeline">${history.map(form => row({ title: form.procedure,
        subtitle: date(form.submitted), glyph: 'historico', type: 'form', value: form.id })).join('') || '<p>Nenhum atendimento registrado.</p>'}</div>
          <button class="primary" id="next">Novo atendimento</button></section>`;
        bindForms(panel);
        byId('next').onclick = () => renderInvite(data.clients, data.clients.some(item => item.phone === client.phone) ? client.phone : '');
      };
      wireSearch('Buscar por nome ou WhatsApp', directory, client => client.name + ' ' + client.phone,
        client => row({ title: client.name, subtitle: client.phone, glyph: 'cliente', type: 'client', value: client.phone }),
        root => root.querySelectorAll('[data-client]').forEach(button => action(button, 'click', () => showHistory(clients.get(button.dataset.client)))));
      byId('new').onclick = () => {
        byId('workspace').innerHTML = `<section class="task-panel card"><h2>Nova cliente</h2><form id="customer">
          <label>Nome<input name="name" maxlength="120" required></label><label>WhatsApp com DDD<input name="phone" type="tel" maxlength="25" required></label>
          <button class="primary">Salvar cliente</button></form></section>`;
        const form = byId('customer');
        form.elements.name.focus();
        action(form, 'submit', async () => { await api('/clients', formData(form)); await dashboard(); message.textContent = 'Cliente cadastrada.'; });
      };
      return;
    }

    if (selected === 'documentos') {
      shell('Documentos');
      byId('content').innerHTML = '<div class="workspace-grid"><div id="directory"></div><aside id="workspace" aria-label="Detalhes do PDF"></aside></div>';
      wireSearch('Buscar por cliente ou código', data.documents, item => item.name + ' ' + item.number,
        item => row({ title: item.number, subtitle: item.name + ' · ' + date(item.issued), glyph: 'pdf',
          extra: `<span class="badge ${item.replaced ? 'warning' : ''}">${item.replaced ? 'Substituído' : 'Emitido'}</span>`,
          type: 'document', value: item.code }),
        root => root.querySelectorAll('[data-document]').forEach(button => action(button, 'click', () => {
          const doc = data.documents.find(item => item.code === button.dataset.document);
          byId('workspace').innerHTML = `<section class="task-panel card"><h2>${escape(doc.number)}</h2><p>${escape(doc.name)}</p>
            <a class="button primary" href="/api/documents/${doc.code}/pdf">Baixar PDF</a>
            <button data-form="${doc.id}">Abrir atendimento</button></section>`;
          bindForms(byId('workspace'));
        })));
      return;
    }

    shell('Configurações');
    const content = byId('content');
    const drawSettings = () => {
      content.innerHTML = `<div class="workspace-grid"><div class="records">${settings.map(([id,label,glyph]) =>
        row({ title: label, glyph, type: 'setting', value: id })).join('')}<button id="logout">Sair</button></div>
        <aside id="workspace" aria-label="Detalhes das configurações"></aside></div>`;
      action(byId('logout'), 'click', async () => { await api('/logout', {}); selected = 'inicio'; await dashboard(); });
      content.querySelectorAll('[data-setting]').forEach(button => action(button, 'click', () => {
        const [id, label] = settings.find(([key]) => key === button.dataset.setting);
        const details = {
          perfil: `<p>${escape(data.salon)}</p>`,
          equipe: '<p>O acesso individual da equipe será habilitado com a integração do SuperDB.</p>',
          modelos: `<ul>${models.map(name => `<li>${name}</li>`).join('')}</ul>`,
          drive: '<span class="badge warning">Desconectado</span><p>Guarde as fotos e os PDFs na conta do salão.</p><button class="primary" disabled>Conectar Google Drive</button>'
        };
        byId('workspace').innerHTML = `<section class="task-panel card"><h2>${label}</h2>${details[id]}</section>`;
      }));
    };
    drawSettings();
  }
  return dashboard;
}
