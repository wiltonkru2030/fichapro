import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { notify } from './whatsapp.js';
import { renderPdf } from './pdf.js';
import { createDrive } from './drive.js';
import { createSuperdb } from './superdb.js';

const token = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const number = id => 'FP-' + String(id).padStart(6, '0');
const publicUrl = new URL(process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000');
const drive = createDrive({ origin: publicUrl });
const salon = process.env.SALON_NAME || 'FichaPro';
const password = process.env.ADMIN_PASSWORD || '';
const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
if (process.env.NODE_ENV === 'production' && (publicUrl.protocol !== 'https:' || password.length < 12)) {
  throw new Error('Em produção, configure PUBLIC_URL com HTTPS e ADMIN_PASSWORD com pelo menos 12 caracteres.');
}
const secure = publicUrl.protocol === 'https:' ? '; Secure' : '';
const path = process.env.DB_PATH || 'data/fichapro.sqlite';
const remote = createSuperdb();
if (process.env.RENDER_EXTERNAL_URL && !remote) {
  throw new Error('No Render, configure o SuperDB antes de iniciar para preservar os dados.');
}
if (!remote) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = remote ? null : new DatabaseSync(path);
db?.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS forms (
    id INTEGER PRIMARY KEY, link TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL,
    customer TEXT, submitted INTEGER, assessment TEXT, notification TEXT
  );
  CREATE TABLE IF NOT EXISTS documents (
    code TEXT PRIMARY KEY, form_id INTEGER NOT NULL REFERENCES forms(id),
    issued INTEGER NOT NULL, digest TEXT NOT NULL, pdf BLOB NOT NULL, replaced INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS active_document ON documents(form_id) WHERE replaced IS NULL;
  CREATE TABLE IF NOT EXISTS drive_connections (
    account TEXT PRIMARY KEY, root TEXT NOT NULL, refresh BLOB NOT NULL, active INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_drive ON drive_connections(active) WHERE active=1;
  CREATE TABLE IF NOT EXISTS drive_states (
    state TEXT PRIMARY KEY, session TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drive_documents (
    code TEXT PRIMARY KEY REFERENCES documents(code), account TEXT NOT NULL REFERENCES drive_connections(account),
    pdf_id TEXT NOT NULL, photo_ids TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clients (
    phone TEXT PRIMARY KEY, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invitations (
    form_id INTEGER PRIMARY KEY REFERENCES forms(id), phone TEXT REFERENCES clients(phone), procedure TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);
const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
// Cada operação remota tem SQL fixo. O callback mantém compatibilidade com o piloto local.
const call = (operation, args, local) => remote ? remote(operation, args) : local();
const transaction = work => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
const assets = new Map([
  ['/app.js', ['public/app.js', 'text/javascript']],
  ['/style.css', ['public/style.css', 'text/css']],
  ['/marca.svg', ['design/marca/logo-claro.svg', 'image/svg+xml']]
]);
// A lista de ícones é explícita para manter o servidor fora da árvore de arquivos privados.
for (const icon of ['adicionar','avancar','cliente','clientes','configuracoes','documentos','ficha','fotos','historico','inicio','pdf','pesquisa','qr-code','validacao','voltar']) {
  assets.set('/icones/' + icon + '.svg', ['design/icones/' + icon + '.svg', 'image/svg+xml']);
}
assets.set('/ui.js', ['public/ui.js', 'text/javascript']);
assets.set('/painel.js', ['public/painel.js', 'text/javascript']);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function body(req, limit = 32_000) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Formato de envio inválido.');
  if (Number(req.headers['content-length']) > limit) throw fail(413, 'Arquivo grande demais.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw fail(413, 'Arquivo grande demais.');
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw fail(400, 'Dados inválidos.');
  }
}

function field(value, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw fail(400, 'Confira os campos obrigatórios e o tamanho das respostas.');
  }
  return value.trim();
}

function image(value, type, limit) {
  const prefix = 'data:image/' + type + ';base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > limit) throw fail(400, 'Imagem inválida.');
  const bytes = Buffer.from(value.slice(prefix.length), 'base64');
  const valid = type === 'png' ? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw fail(400, 'Imagem inválida.');
  return value;
}

const attempts = new Map();
function loginLimit(ip) {
  const now = Date.now();
  for (const [address, entry] of attempts) if (entry.until < now) attempts.delete(address);
  const entry = attempts.get(ip) || { count: 0, until: now + 600_000 };
  if (++entry.count > 8) throw fail(429, 'Muitas tentativas. Aguarde dez minutos.');
  attempts.set(ip, entry);
}

// A versão emitida pode ter sido salva localmente antes de conectar o Drive.
async function documentBytes(doc) {
  const stored = doc.pdf_id ? doc : get('SELECT account,pdf_id FROM drive_documents WHERE code=?', doc.code);
  if (!stored) return Buffer.from(doc.pdf);
  const connection = await call('drive_account', { account: stored.account }, () => get('SELECT * FROM drive_connections WHERE account=?', stored.account));
  const pdf = await drive.download(connection, stored.pdf_id);
  if (hash(pdf) !== doc.digest) throw fail(409, 'O PDF salvo no Drive foi alterado e não corresponde à versão emitida.');
  return pdf;
}

async function route(req, res) {
  const { pathname: url } = new URL(req.url, publicUrl);
  const method = req.method;
  const session = req.headers.cookie?.match(/(?:^|; )fp=([\w-]+)/)?.[1];
  // Referrer-Policy pode fazer o navegador enviar Origin: null.
  // Fetch Metadata é controlado pelo navegador e confirma a origem neste caso.
  const origin = req.headers.origin;
  const sameOrigin = origin === publicUrl.origin ||
    ((!origin || origin === 'null') && req.headers['sec-fetch-site'] === 'same-origin');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  if (method === 'GET' && url === '/healthz') {
    await call('health', {}, () => get('SELECT 1'));
    return json({ status: 'ok' });
  }
  if (method === 'POST' && !sameOrigin) throw fail(403, 'Origem inválida.');
  if (method === 'GET' && assets.has(url)) {
    const [file, mime] = assets.get(url);
    res.writeHead(200, { 'Content-Type': mime });
    return res.end(readFileSync(file));
  }
  if (method === 'GET' && /^\/(?:|pre\/[\w-]+|validar\/[\w-]+)$/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(readFileSync('public/index.html'));
  }
  if (method === 'POST' && url === '/api/login') {
    loginLimit(req.socket.remoteAddress);
    const data = await body(req);
    if (password.length < 12) throw fail(503, 'O acesso do salão ainda precisa ser configurado.');
    const passwordMatches = timingSafeEqual(Buffer.from(hash(field(data.password, 256))), Buffer.from(hash(password)));
    const emailMatches = !adminEmail || field(data.email ?? '', 254).toLowerCase() === adminEmail;
    if (!passwordMatches || !emailMatches) {
      throw fail(401, 'E-mail ou senha incorretos.');
    }
    attempts.delete(req.socket.remoteAddress);
    const id = token();
    const expires = Date.now() + 43_200_000;
    await call('session_create', { id: hash(id), expires }, () => {
      run('DELETE FROM sessions WHERE expires < ?', Date.now());
      run('INSERT INTO sessions VALUES (?, ?)', hash(id), expires);
    });
    res.setHeader('Set-Cookie', `fp=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`);
    return json({ salon });
  }

  const pre = url.match(/^\/api\/pre\/([\w-]{32})$/);
  if (pre) {
    const link = hash(pre[1]);
    const form = await call('prefill', { link }, () => get(`SELECT forms.id, forms.expires, forms.submitted, forms.notification, invitations.procedure
      FROM forms LEFT JOIN invitations ON invitations.form_id=forms.id WHERE forms.link=?`, link));
    if (!form || form.expires < Date.now()) throw fail(404, 'Link inválido ou expirado. Peça outro ao salão.');
    if (method === 'GET') return json({ salon, submitted: Boolean(form.submitted), number: form.submitted ? number(form.id) : null, procedure: form.procedure ?? '' });
    if (method === 'POST') {
      if (form.submitted) return json({ number: number(form.id), notification: form.notification });
      const data = await body(req);
      const customer = {
        name: field(data.name, 120, true), phone: field(data.phone, 25, true).replace(/\D/g, ''),
        procedure: form.procedure || field(data.procedure, 150, true), chemical: field(data.chemical, 20, true),
        details: field(data.details, 1200), reaction: field(data.reaction, 1200), notes: field(data.notes, 1200)
      };
      if (!/^(55)?\d{10,11}$/.test(customer.phone) || !['Sim','Não','Não sei'].includes(customer.chemical)) {
        throw fail(400, 'Confira o telefone com DDD e a resposta sobre química.');
      }
      const submitted = Date.now();
      const saved = await call('submit', { id: form.id, customer, submitted }, () => run(
        'UPDATE forms SET customer=?, submitted=?, notification=? WHERE id=? AND submitted IS NULL',
        JSON.stringify(customer), submitted, 'em_envio', form.id).changes > 0);
      if (!saved) return json({ number: number(form.id), notification: 'em_envio' });
      const status = await notify(number(form.id));
      await call('notify', { id: form.id, status }, () => run('UPDATE forms SET notification=? WHERE id=?', status, form.id));
      return json({ number: number(form.id), notification: status }, 201);
    }
  }

  const verification = url.match(/^\/api\/validar\/([\w-]{32})$/);
  if (method === 'GET' && verification) {
    const doc = await call('verification', { digest: hash(verification[1]) }, () => get('SELECT form_id, issued, digest, replaced FROM documents WHERE code=?', verification[1]));
    if (!doc) throw fail(404, 'Documento não encontrado.');
    return json({ number: number(doc.form_id), issued: doc.issued, digest: doc.digest, replaced: Boolean(doc.replaced) });
  }

  if (!url.startsWith('/api/')) throw fail(404, 'Página não encontrada.');
  if (!session || !await call('session_active', { id: hash(session) }, () => get('SELECT 1 FROM sessions WHERE id=? AND expires>?', hash(session), Date.now()))) throw fail(401, 'Entre para acessar o painel.');
  if (method === 'GET' && url === '/api/drive') {
    const connection = await call('drive_active', {}, () => get('SELECT root FROM drive_connections WHERE active=1'));
    return json({ configured: drive.configured, connected: Boolean(connection),
      folder: connection ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(connection.root) : null });
  }
  if (method === 'POST' && url === '/api/drive/connect') {
    if (!drive.configured) throw fail(503, 'A integração com o Google Drive ainda não foi configurada.');
    const state = token();
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const expires = Date.now() + 600_000;
    await call('state_create', { state: hash(state), session: hash(session), verifier, expires }, () => {
      run('DELETE FROM drive_states WHERE expires<? OR session=?', Date.now(), hash(session));
      run('INSERT INTO drive_states VALUES (?,?,?,?)', hash(state), hash(session), verifier, expires);
    });
    return json({ url: drive.authorization(state, challenge) });
  }
  if (method === 'GET' && url === '/api/drive/callback') {
    const params = new URL(req.url, publicUrl).searchParams;
    const state = hash(params.get('state') || '');
    const pending = await call('state_take', { state, session: hash(session) }, () =>
      get('DELETE FROM drive_states WHERE state=? AND session=? AND expires>? RETURNING verifier',
        state, hash(session), Date.now()));
    if (!pending) throw fail(403, 'A solicitação expirou. Conecte novamente pelo painel.');
    const code = params.get('code');
    let outcome = 'cancelado';
    if (code && drive.configured) {
      try {
        const connection = await drive.connect(code, pending.verifier,
          account => call('drive_account', { account }, () => get('SELECT root FROM drive_connections WHERE account=?', account)));
        await call('drive_connect', { ...connection, refresh: connection.refresh.toString('hex'), salon }, () => transaction(() => {
          run('UPDATE drive_connections SET active=0 WHERE active=1');
          run(`INSERT INTO drive_connections VALUES (?,?,?,1)
            ON CONFLICT(account) DO UPDATE SET root=excluded.root, refresh=excluded.refresh, active=1`,
          connection.account, connection.root, connection.refresh);
        }));
        outcome = 'conectado';
      } catch {
        outcome = 'erro';
      }
    }
    res.writeHead(303, { Location: '/?drive=' + outcome });
    return res.end();
  }
  if (method === 'POST' && url === '/api/logout') {
    await call('session_delete', { id: hash(session) }, () => run('DELETE FROM sessions WHERE id=?', hash(session)));
    res.setHeader('Set-Cookie', `fp=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return json({});
  }
  if (method === 'POST' && url === '/api/clients') {
    const data = await body(req);
    const name = field(data.name, 120, true);
    const phone = field(data.phone, 25, true).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    if (!/^\d{10,11}$/.test(phone)) throw fail(400, 'Informe o WhatsApp com DDD.');
    if (!await call('client_create', { phone, name, salon }, () => run('INSERT OR IGNORE INTO clients VALUES (?,?)', phone, name).changes > 0)) {
      throw fail(409, 'Já existe uma cliente com esse telefone.');
    }
    return json({ name, phone }, 201);
  }
  if (method === 'POST' && url === '/api/links') {
    const data = await body(req);
    const link = token();
    const procedure = field(data.procedure ?? '', 150);
    const phone = field(data.phone ?? '', 25);
    const digest = hash(link);
    const expires = Date.now() + 7 * 86_400_000;
    const id = await call('invite_create', { digest, expires, phone, procedure, salon }, () => transaction(() => {
      if (phone && !get('SELECT 1 FROM clients WHERE phone=?', phone)) throw fail(404, 'Cliente não encontrada.');
      const result = run('INSERT INTO forms(link,expires) VALUES (?,?)', digest, expires);
      run('INSERT INTO invitations VALUES (?,?,?)', result.lastInsertRowid, phone || null, procedure);
      return result.lastInsertRowid;
    }));
    return json({ number: number(id), link: new URL('/pre/' + link, publicUrl).href }, 201);
  }
  if (method === 'GET' && url === '/api/forms') {
    const dashboard = await call('dashboard', {}, () => {
    const forms = all('SELECT id,customer,submitted,notification FROM forms WHERE submitted IS NOT NULL ORDER BY id DESC');
    return { clients: all('SELECT name,phone FROM clients ORDER BY name'),
      pending: all(`SELECT forms.id, clients.name, invitations.procedure, forms.expires
        FROM forms LEFT JOIN invitations ON invitations.form_id=forms.id
        LEFT JOIN clients ON clients.phone=invitations.phone
        WHERE forms.submitted IS NULL AND forms.expires>? ORDER BY forms.id DESC`, Date.now())
        .map(row => ({ ...row, number: number(row.id) })),
      forms: forms.map(row => ({ name: JSON.parse(row.customer).name, phone: JSON.parse(row.customer).phone, procedure: JSON.parse(row.customer).procedure, id: row.id, number: number(row.id),
        submitted: row.submitted, notification: row.notification })),
      documents: all(`SELECT documents.code, documents.form_id, documents.issued, documents.replaced, forms.customer
        FROM documents JOIN forms ON forms.id=documents.form_id ORDER BY documents.issued DESC`)
        .map(row => ({ code: row.code, id: row.form_id, number: number(row.form_id),
          issued: row.issued, replaced: Boolean(row.replaced), name: JSON.parse(row.customer).name })) };
    });
    for (const collection of [dashboard.forms, dashboard.pending, dashboard.documents]) {
      for (const row of collection) row.number = number(row.id);
    }
    return json({ salon, ...dashboard });
  }
  const download = url.match(/^\/api\/documents\/([\w-]{32})\/pdf$/);
  if (method === 'GET' && download) {
    const doc = await call('document', { code: download[1] }, () => get('SELECT code,form_id,pdf,digest FROM documents WHERE code=?', download[1]));
    if (!doc) throw fail(404, 'Documento não encontrado.');
    const bytes = await documentBytes(doc);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${number(doc.form_id)}.pdf"` });
    return res.end(bytes);
  }
  const formRoute = url.match(/^\/api\/forms\/(\d+)(?:\/(pdf|emitir))?$/);
  if (formRoute) {
    const id = Number(formRoute[1]);
    const action = formRoute[2];
    const row = await call('form', { id }, () => get('SELECT * FROM forms WHERE id=? AND submitted IS NOT NULL', id));
    if (!row) throw fail(404, 'Ficha não encontrada.');
    const doc = await call('active_document', { id }, () => get('SELECT * FROM documents WHERE form_id=? AND replaced IS NULL', id));
    const customer = remote ? row.customer : JSON.parse(row.customer);
    if (method === 'GET' && !action) return json({ number: number(id), customer, assessment: remote ? row.assessment || {} : JSON.parse(row.assessment || '{}'), issued: Boolean(doc), version: doc?.code ?? null });
    if (method === 'GET' && action === 'pdf') {
      if (!doc) throw fail(404, 'PDF ainda não emitido.');
      const bytes = await documentBytes(doc);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${number(id)}.pdf"` });
      return res.end(bytes);
    }
    if (method === 'POST' && (action === 'emitir' || !action)) {
      const data = await body(req, 8_000_000);
      const assessment = Object.fromEntries(['Couro cabeludo','Condição dos fios','Teste de mecha','Produtos e fórmula','Orientações'].map(label =>
        [label, field(data.assessment?.[label], 1400, label === 'Condição dos fios' && action === 'emitir')]));
      if (!action) {
        await call('assessment', { id, assessment }, () => run('UPDATE forms SET assessment=? WHERE id=?', JSON.stringify(assessment), id));
        return json({ saved: true });
      }
      if (data.version !== (doc?.code ?? null)) throw fail(409, 'A ficha foi emitida em outra tela. Reabra para continuar.');
      if (doc && data.replace !== true) throw fail(409, 'Confirme a emissão de uma nova versão.');
      const signature = image(data.signature, 'png', 250_000);
      const terms = field(data.terms, 3600, true);
      const photos = ['Antes','Depois'].flatMap(label => data.photos?.[label] ?
        [{ label, image: image(data.photos[label], 'jpeg', 3_500_000) }] : []);
      const code = token();
      const issued = Date.now();
      let pdf;
      try {
        pdf = await renderPdf({ number: number(id), salon, customer, assessment, signature, terms, photos,
          publicity: data.publicity === true, verification: new URL('/validar/' + code, publicUrl).href, issued });
      } catch {
        throw fail(422, 'Não foi possível ler a assinatura ou as fotos. Revise os arquivos.');
      }
      const connection = await call('drive_active', {}, () => get('SELECT * FROM drive_connections WHERE active=1'));
      if ((drive.configured || remote) && !connection) throw fail(409, 'Conecte o Drive do salão antes de emitir o PDF.');
      const stored = connection ? await drive.store(connection, number(id) + '-' + code.slice(0, 8), [
        { name: number(id) + '.pdf', type: 'application/pdf', bytes: pdf },
        ...photos.map(photo => ({ name: photo.label.toLowerCase() + '.jpg', type: 'image/jpeg',
          bytes: Buffer.from(photo.image.split(',')[1], 'base64') }))
      ]) : null;
      const pdfDigest = hash(pdf);
      const photoIds = stored ? Object.fromEntries(photos.map((photo, i) => [photo.label, stored.ids[i + 1]])) : {};
      try {
        await call('issue', { id, code, verification: hash(code), issued, digest: pdfDigest, version: data.version,
          assessment, connection: connection?.id, pdf: stored?.ids[0], photos: photoIds }, () => transaction(() => {
          if ((get('SELECT code FROM documents WHERE form_id=? AND replaced IS NULL', id)?.code ?? null) !== data.version) {
            throw fail(409, 'A ficha já tem uma versão mais recente.');
          }
          run('UPDATE documents SET replaced=? WHERE form_id=? AND replaced IS NULL', issued, id);
          run('INSERT INTO documents VALUES (?,?,?,?,?,NULL)', code, id, issued, pdfDigest, stored ? Buffer.alloc(0) : pdf);
          if (stored) run('INSERT INTO drive_documents VALUES (?,?,?,?)', code, connection.account, stored.ids[0], JSON.stringify(photoIds));
          run('UPDATE forms SET assessment=? WHERE id=?', JSON.stringify(assessment), id);
        }));
      } catch (error) {
        // Se a confirmação remota se perdeu, preservar os arquivos evita invalidar um PDF já emitido.
        if (stored && (!remote || error.definitive)) await stored.discard().catch(() => {});
        throw error;
      }
      return json({ number: number(id), verification: '/validar/' + code }, 201);
    }
  }
  throw fail(404, 'Página não encontrada.');
}

createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    await route(req, res);
  } catch (error) {
    if (!error.status) console.error(error.code || error.name);
    if (res.headersSent) return res.end();
    res.writeHead(error.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.status ? error.message : 'Erro ao processar. Tente novamente.' }));
  }
}).listen(Number(process.env.PORT || 3000), () => console.log('FichaPro pronto.'));
