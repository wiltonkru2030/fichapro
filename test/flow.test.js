import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import QRCode from 'qrcode';
import { notify } from '../server/whatsapp.js';

test('aviso comercial usa somente número e distingue falhas', async () => {
  const env = { WA_TOKEN: 'test', WA_PHONE_ID: '123', WA_TO: '5592999999999', WA_API_VERSION: 'v22.0' };
  assert.equal(await notify('FP-000001', {}), 'sem_integracao');
  assert.equal(await notify('FP-000001', env, async (endpoint, request) => {
    assert.match(endpoint, /\/123\/messages$/);
    const body = JSON.parse(request.body);
    assert.equal(body.to, env.WA_TO);
    assert.deepEqual(body.template.components[0].parameters, [{ type: 'text', text: 'FP-000001' }]);
    return Response.json({ messages: [{ id: 'test' }] });
  }), 'aceito');
  assert.equal(await notify('FP-000001', env, async () => new Response(null, { status: 400 })), 'rejeitado');
  assert.equal(await notify('FP-000001', env, async () => { throw Error(); }), 'incerto');
});

test('salva uma vez, protege dados, emite e substitui PDF verificável', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'fichapro-'));
  const net = createServer().listen(0);
  await once(net, 'listening');
  const port = net.address().port;
  await new Promise(resolve => net.close(resolve));
  const origin = 'http://localhost:' + port;
  const env = { ...process.env, PORT: String(port), PUBLIC_URL: origin, DB_PATH: join(folder, 'test.db'),
    ADMIN_PASSWORD: 'senha-apenas-de-teste', WA_TOKEN: '', NODE_ENV: 'test', GOOGLE_CLIENT_ID: '', SUPERDB_URL: '', SUPERDB_PROJECT: '', SUPERDB_SERVICE_ROLE_KEY: '' };
  const processUnderTest = spawn(process.execPath, ['server/index.js'], { env });
  t.after(async () => {
    if (processUnderTest.exitCode === null) {
      processUnderTest.kill();
      await once(processUnderTest, 'exit');
    }
    rmSync(folder, { recursive: true, force: true });
  });
  await Promise.race([once(processUnderTest.stdout, 'data'), once(processUnderTest, 'exit').then(() => { throw Error('Servidor não iniciou'); })]);
  const send = (path, data, cookie = '') => fetch(origin + '/api' + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(data)
  });
  const health = await fetch(origin + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const login = await send('/login', { password: env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin + '/api/drive')).status, 401);
  const storage = await fetch(origin + '/api/drive', { headers: { Cookie: cookie } });
  assert.deepEqual(await storage.json(), { configured: false, connected: false, folder: null });
  assert.equal((await send('/drive/connect', {}, cookie)).status, 503);
  assert.equal((await fetch(origin + '/api/drive/callback?state=invalid', { headers: { Cookie: cookie } })).status, 403);
  const client = await send('/clients', { name: 'Cliente Teste', phone: '(92) 99999-9999' }, cookie);
  assert.equal(client.status, 201);
  assert.equal((await send('/clients', { name: 'Outro nome', phone: '+55 (92) 99999-9999' }, cookie)).status, 409);
  const link = await (await send('/links', { phone: '92999999999', procedure: 'Coloração' }, cookie)).json();
  const pre = new URL(link.link).pathname;
  const beforeSubmission = await (await fetch(origin + '/api/forms', { headers: { Cookie: cookie } })).json();
  assert.equal(beforeSubmission.pending[0].name, 'Cliente Teste');
  assert.equal((await (await fetch(origin + '/api' + pre)).json()).procedure, 'Coloração');
  const customer = { name: 'Cliente Teste', phone: '92999999999', procedure: 'Coloração', chemical: 'Não', details: '', reaction: '', notes: '' };
  const responses = await Promise.all([send(pre, customer), send(pre, customer)]);
  const saved = await Promise.all(responses.map(response => response.json()));
  assert.ok(saved.every(result => result.number === link.number));
  assert.ok(saved.some(result => result.notification === 'sem_integracao'));
  assert.equal((await fetch(origin + '/api/forms/1')).status, 401);
  const dashboard = await (await fetch(origin + '/api/forms', { headers: { Cookie: cookie } })).json();
  assert.equal(dashboard.forms.length, 1);
  assert.equal(dashboard.pending.length, 0);
  assert.equal(dashboard.clients[0].phone, '92999999999');
  assert.equal(dashboard.forms[0].procedure, 'Coloração');
  const signature = await QRCode.toDataURL('assinatura de teste');
  const assessment = { 'Couro cabeludo': '', 'Condição dos fios': 'Avaliado', 'Teste de mecha': '', 'Produtos e fórmula': '', 'Orientações': '' };
  const document = { signature, assessment, terms: 'Termo fictício de teste.', version: null };
  const first = await send('/forms/1/emitir', document, cookie);
  assert.equal(first.status, 201, await first.clone().text());
  const { verification } = await first.json();
  const publicResponse = await (await fetch(origin + '/api' + verification)).json();
  assert.deepEqual(Object.keys(publicResponse).sort(), ['digest', 'issued', 'number', 'replaced']);
  const pdf = Buffer.from(await (await fetch(origin + '/api/forms/1/pdf', { headers: { Cookie: cookie } })).arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(createHash('sha256').update(pdf).digest('hex'), publicResponse.digest);
  assert.notEqual(createHash('sha256').update(pdf).update('alterado').digest('hex'), publicResponse.digest);
  assert.equal((await send('/forms/1/emitir', document, cookie)).status, 409);
  assert.equal((await send('/forms/1/emitir', { ...document, version: verification.split('/').pop(), replace: true }, cookie)).status, 201);
  assert.equal((await (await fetch(origin + '/api' + verification)).json()).replaced, true);
  const updated = await (await fetch(origin + '/api/forms', { headers: { Cookie: cookie } })).json();
  assert.equal(updated.documents.length, 2);
  const old = updated.documents.find(item => item.replaced);
  assert.equal(old.code, verification.split('/').pop());
  assert.equal((await fetch(origin + '/api/documents/' + old.code + '/pdf')).status, 401);
  const oldPdf = await fetch(origin + '/api/documents/' + old.code + '/pdf', { headers: { Cookie: cookie } });
  assert.deepEqual(Buffer.from(await oldPdf.arrayBuffer()), pdf);
});
