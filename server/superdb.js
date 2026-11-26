import { createClient } from '@superdb/client';

// A chave de serviço só existe no processo Node. O navegador usa as rotas do FichaPro.
export function createSuperdb(env = process.env) {
  if (!['SUPERDB_URL','SUPERDB_SERVICE_ROLE_KEY','SUPERDB_PROJECT'].some(key => env[key])) return null;
  const { SUPERDB_URL: url, SUPERDB_SERVICE_ROLE_KEY: key, SUPERDB_PROJECT: project } = env;
  const parsed = new URL(url || 'https://auth.superdb.com.br');
  if (parsed.origin !== 'https://auth.superdb.com.br' || project !== 'p_be928f3912' || !key) {
    throw new Error('Configure a chave de serviço e o projeto SuperDB do FichaPro.');
  }
  const db = createClient(parsed.origin, key, { project });
  return async function remote(operation, args) {
    const { data, error } = await db.rpc('fichapro_server', { operation, args });
    if (error) {
      // Uma falha de transporte pode ocorrer após o banco confirmar a transação.
      if (error.code === 'FP409') throw Object.assign(new Error('Uma versão mais recente já foi emitida.'), { status: 409, definitive: true });
      if (error.code === 'FP404') throw Object.assign(new Error('Cliente não encontrada.'), { status: 404 });
      throw Object.assign(new Error('Serviço de dados indisponível.'), { status: 503 });
    }
    return data;
  };
}
