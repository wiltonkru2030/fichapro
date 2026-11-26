import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrive } from '../server/drive.js';

test('autoriza acesso limitado, criptografa credencial e envia arquivos privados', async () => {
  const calls = [];
  let uploaded = 0;
  const drive = createDrive({
    origin: 'https://ficha.example',
    env: { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', DRIVE_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') },
    async request(url, options) {
      calls.push({ url, options });
      if (url.endsWith('/token')) {
        return Response.json(options.body.get('grant_type') === 'authorization_code' ?
          { access_token: 'access', refresh_token: 'private-refresh' } : { access_token: 'renewed' });
      }
      if (url.includes('/about?')) return Response.json({ user: { permissionId: 'google-account' } });
      if (url.includes('alt=media')) return new Response('pdf-content');
      if (options.method === 'PATCH') return Response.json({ trashed: true });
      if (url.includes('uploadType')) return Response.json({ id: 'file-' + ++uploaded });
      return Response.json({ id: 'file-folder' });
    }
  });
  assert.equal(drive.configured, true);
  const oauth = new URL(drive.authorization('test-state', 'test-challenge'));
  assert.equal(oauth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(oauth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(oauth.searchParams.get('redirect_uri'), 'https://ficha.example/api/drive/callback');
  const connection = await drive.connect('test-code', 'test-verifier', () => ({ root: 'existing-folder' }));
  assert.equal(connection.account, 'google-account');
  assert.equal(connection.root, 'existing-folder');
  assert.ok(!connection.refresh.includes(Buffer.from('private-refresh')));
  const stored = await drive.store(connection, 'FP-000001-sample', [
    { name: 'FP-000001.pdf', type: 'application/pdf', bytes: Buffer.from('pdf-content') },
    { name: 'antes.jpg', type: 'image/jpeg', bytes: Buffer.from('jpeg-content') }
  ]);
  assert.deepEqual(stored.ids, ['file-1','file-2']);
  assert.equal(calls.find(item => item.options.body?.get?.('grant_type') === 'refresh_token').options.body.get('refresh_token'), 'private-refresh');
  assert.match(calls.find(item => item.url.includes('uploadType')).options.body.toString(), /"parents":\["file-folder"\]/);
  assert.equal((await drive.download(connection, 'file-1')).toString(), 'pdf-content');
  await stored.discard();
  assert.equal(calls.at(-1).options.method, 'PATCH');
  assert.ok(calls.every(call => !call.url.includes('/permissions')));
});
