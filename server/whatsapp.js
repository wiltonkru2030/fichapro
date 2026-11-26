// Envia somente o número da ficha pelo modelo aprovado da conta comercial.
export async function notify(number, env = process.env, request = fetch) {
  const { WA_TOKEN, WA_PHONE_ID, WA_TO, WA_API_VERSION, WA_TEMPLATE = 'ficha_concluida', WA_LANGUAGE = 'pt_BR' } = env;
  if (!WA_TOKEN || !/^\d+$/.test(WA_PHONE_ID || '') || !/^\d{8,15}$/.test(WA_TO || '') ||
      !/^v\d+\.\d+$/.test(WA_API_VERSION || '')) return 'sem_integracao';

  try {
    const response = await request(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(7000),
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: WA_TO, type: 'template',
        template: {
          name: WA_TEMPLATE, language: { code: WA_LANGUAGE },
          components: [{ type: 'body', parameters: [{ type: 'text', text: number }] }]
        }
      })
    });
    if (response.status >= 500) return 'incerto';
    if (!response.ok) return 'rejeitado';
    const result = await response.json();
    return result.messages?.[0]?.id ? 'aceito' : 'incerto';
  } catch {
    // Um timeout pode acontecer depois que a Meta aceitou a mensagem.
    return 'incerto';
  }
}
