# FichaPro

Kit de identidade visual do FichaPro, baseado na proposta aprovada.

![FichaPro](design/marca/logo-claro.svg)

- [Marca e ícones de aplicativo](design/marca)
- [Ícones da interface](design/icones)
- [Guia visual](design/README.md)

## Executar a versão web

O piloto usa Node.js 24 e SQLite, com um estabelecimento por instalação. Configure uma senha de pelo menos 12 caracteres no arquivo de ambiente. O diretório `data/` contém os dados privados e deve ficar em um volume persistente com cópias de segurança protegidas.

```sh
npm ci
cp .env.example .env
npm test
npm start
```

Abra `http://localhost:3000`. Em uma implantação, configure `PUBLIC_URL` com o endereço HTTPS real antes de gerar links ou emitir PDFs. Atualize o endereço também se mudar a porta local. Preserve a pasta `data/` entre reinícios. Restrinja o acesso ao banco, aos backups e ao arquivo `.env`.

## Aviso automático no WhatsApp

Configure no servidor `WA_TOKEN`, `WA_PHONE_ID`, `WA_TO` (número do salão no formato internacional, só dígitos) e `WA_API_VERSION` (versão habilitada na conta Meta). Configure um modelo aprovado com um campo no corpo, por exemplo `Ficha concluída. Número da ficha: {{1}}.`, e defina seu nome e idioma em `WA_TEMPLATE` e `WA_LANGUAGE`.

O formulário fica salvo mesmo se o WhatsApp estiver indisponível. O painel mostra se a API aceitou, recusou ou ficou sem confirmação. A aceitação pela API é diferente da confirmação de entrega no aparelho. Nenhum nome, foto ou resposta da cliente entra na mensagem.

## Escopo do piloto

Pré-cadastro por link individual de sete dias, painel com busca, avaliação técnica, assinatura desenhada, fotos anexadas ao PDF, emissão e substituição de documentos, e validação pública de integridade. As fotos ficam nas cópias emitidas no banco. O piloto usa acesso único do salão. Contas individuais, modelos editáveis, galeria independente do PDF, instaladores nativos e publicação ficam para uma etapa posterior.
