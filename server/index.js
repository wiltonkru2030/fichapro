import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { notify } from './whatsapp.js';
import { renderPdf } from './pdf.js';

const token = () => randomBytes(24).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const number = id => 'FP-' + String(id).padStart(6, '0');
const publicUrl = new URL(process.env.PUBLIC_URL || 'http://localhost:3000');
const salon = process.env.SALON_NAME || 'FichaPro';
const password = process.env.ADMIN_PASSWORD || '';
if (process.env.NODE_ENV === 'production' && (publicUrl.protocol !== 'https:' || password.length < 12)) {
  throw new Error('Em produção, configure PUBLIC_URL com HTTPS e ADMIN_PASSWORD com pelo menos 12 caracteres.');
}
const secure = publicUrl.protocol === 'https:' ? '; Secure' : '';
const path = process.env.DB_PATH || 'data/fichapro.sqlite';
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path);
db.exec(`
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
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);
const get = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const assets = new Map([
  ['/app.js', ['public/app.js', 'text/javascript']],
  ['/style.css', ['public/style.css', 'text/css']],
  ['/marca.svg', ['design/marca/logo-claro.svg', 'image/svg+xml']]
]);
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

async function route(req, res) {
  const { pathname: url } = new URL(req.url, publicUrl);
  const method = req.method;
  const session = req.headers.cookie?.match(/(?:^|; )fp=([\w-]+)/)?.[1];
  const sameOrigin = req.headers.origin === publicUrl.origin;
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  if (method === 'GET' && url === '/healthz') {
    get('SELECT 1');
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
    if (!timingSafeEqual(Buffer.from(hash(field(data.password, 256))), Buffer.from(hash(password)))) {
      throw fail(401, 'Senha incorreta.');
    }
    attempts.delete(req.socket.remoteAddress);
    const id = token();
    run('DELETE FROM sessions WHERE expires < ?', Date.now());
    run('INSERT INTO sessions VALUES (?, ?)', hash(id), Date.now() + 43_200_000);
    res.setHeader('Set-Cookie', `fp=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
    return json({ salon });
  }

  const pre = url.match(/^\/api\/pre\/([\w-]{32})$/);
  if (pre) {
    const form = get('SELECT id, expires, submitted, notification FROM forms WHERE link=?', hash(pre[1]));
    if (!form || form.expires < Date.now()) throw fail(404, 'Link inválido ou expirado. Peça outro ao salão.');
    if (method === 'GET') return json({ salon, submitted: Boolean(form.submitted), number: form.submitted ? number(form.id) : null });
    if (method === 'POST') {
      if (form.submitted) return json({ number: number(form.id), notification: form.notification });
      const data = await body(req);
      const customer = {
        name: field(data.name, 120, true), phone: field(data.phone, 25, true).replace(/\D/g, ''),
        procedure: field(data.procedure, 150, true), chemical: field(data.chemical, 20, true),
        details: field(data.details, 1200), reaction: field(data.reaction, 1200), notes: field(data.notes, 1200)
      };
      if (!/^(55)?\d{10,11}$/.test(customer.phone) || !['Sim','Não','Não sei'].includes(customer.chemical)) {
        throw fail(400, 'Confira o telefone com DDD e a resposta sobre química.');
      }
      const saved = run('UPDATE forms SET customer=?, submitted=?, notification=? WHERE id=? AND submitted IS NULL',
        JSON.stringify(customer), Date.now(), 'em_envio', form.id);
      if (!saved.changes) return json({ number: number(form.id), notification: 'em_envio' });
      const status = await notify(number(form.id));
      run('UPDATE forms SET notification=? WHERE id=?', status, form.id);
      return json({ number: number(form.id), notification: status }, 201);
    }
  }

  const verification = url.match(/^\/api\/validar\/([\w-]{32})$/);
  if (method === 'GET' && verification) {
    const doc = get('SELECT form_id, issued, digest, replaced FROM documents WHERE code=?', verification[1]);
    if (!doc) throw fail(404, 'Documento não encontrado.');
    return json({ number: number(doc.form_id), issued: doc.issued, digest: doc.digest, replaced: Boolean(doc.replaced) });
  }

  if (!url.startsWith('/api/')) throw fail(404, 'Página não encontrada.');
  if (!session || !get('SELECT 1 FROM sessions WHERE id=? AND expires>?', hash(session), Date.now())) throw fail(401, 'Entre para acessar o painel.');
  if (method === 'POST' && url === '/api/logout') {
    run('DELETE FROM sessions WHERE id=?', hash(session));
    res.setHeader('Set-Cookie', `fp=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    return json({});
  }
  if (method === 'POST' && url === '/api/links') {
    const link = token();
    const result = run('INSERT INTO forms(link,expires) VALUES (?,?)', hash(link), Date.now() + 7 * 86_400_000);
    return json({ number: number(result.lastInsertRowid), link: new URL('/pre/' + link, publicUrl).href }, 201);
  }
  if (method === 'GET' && url === '/api/forms') {
    const forms = all('SELECT id,customer,notification FROM forms WHERE submitted IS NOT NULL ORDER BY id DESC');
    return json({ salon, forms: forms.map(row => ({ id: row.id, number: number(row.id), name: JSON.parse(row.customer).name, notification: row.notification })) });
  }
  const formRoute = url.match(/^\/api\/forms\/(\d+)(?:\/(pdf|emitir))?$/);
  if (formRoute) {
    const id = Number(formRoute[1]);
    const action = formRoute[2];
    const row = get('SELECT * FROM forms WHERE id=? AND submitted IS NOT NULL', id);
    if (!row) throw fail(404, 'Ficha não encontrada.');
    const doc = get('SELECT * FROM documents WHERE form_id=? AND replaced IS NULL', id);
    const customer = JSON.parse(row.customer);
    if (method === 'GET' && !action) return json({ number: number(id), customer, assessment: JSON.parse(row.assessment || '{}'), issued: Boolean(doc), version: doc?.code ?? null });
    if (method === 'GET' && action === 'pdf') {
      if (!doc) throw fail(404, 'PDF ainda não emitido.');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${number(id)}.pdf"` });
      return res.end(Buffer.from(doc.pdf));
    }
    if (method === 'POST' && (action === 'emitir' || !action)) {
      const data = await body(req, 8_000_000);
      const assessment = Object.fromEntries(['Couro cabeludo','Condição dos fios','Teste de mecha','Produtos e fórmula','Orientações'].map(label =>
        [label, field(data.assessment?.[label], 1400, label === 'Condição dos fios' && action === 'emitir')]));
      if (!action) {
        run('UPDATE forms SET assessment=? WHERE id=?', JSON.stringify(assessment), id);
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
      db.exec('BEGIN IMMEDIATE');
      try {
        if ((get('SELECT code FROM documents WHERE form_id=? AND replaced IS NULL', id)?.code ?? null) !== data.version) {
          throw fail(409, 'A ficha já tem uma versão mais recente.');
        }
        run('UPDATE documents SET replaced=? WHERE form_id=? AND replaced IS NULL', issued, id);
        run('INSERT INTO documents VALUES (?,?,?,?,?,NULL)', code, id, issued, hash(pdf), pdf);
        run('UPDATE forms SET assessment=? WHERE id=?', JSON.stringify(assessment), id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
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
