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

## Publicação com contêiner

O `Dockerfile` empacota o servidor e roda como usuário sem privilégios. Use uma única instância, com armazenamento persistente em `/app/data` e um proxy HTTPS. A plataforma pode verificar a inicialização em `GET /healthz`.

Configure `PUBLIC_URL` com a origem HTTPS externa e `ADMIN_PASSWORD` como segredo da hospedagem. Configure também os segredos do WhatsApp para habilitar o aviso. Ao usar o contêiner, informe as variáveis pela hospedagem ou com `--env-file`, mantendo o arquivo fora da imagem e do Git.

```sh
docker build -t fichapro .
docker volume create fichapro-data
docker run --restart unless-stopped --env-file .env \
  -p 127.0.0.1:3000:3000 -v fichapro-data:/app/data fichapro
```

Para esse exemplo, use `PORT=3000` e configure o proxy HTTPS da máquina para acessar a porta local 3000. Caso a hospedagem monte um diretório próprio no lugar do volume Docker, conceda escrita nesse diretório ao usuário do contêiner. Preserve o volume em atualizações e teste a recuperação dos backups antes de receber fichas reais.

## Hospedar em um computador próprio

Com um computador já disponível e um domínio que você controla, o Compose roda o FichaPro e o Caddy sem precisar contratar um plano de hospedagem. O computador precisa ficar ligado e conectado para que clientes abram os links. A conexão precisa aceitar acesso público às portas TCP 80 e 443. Se o provedor usa CGNAT e não oferece acesso público por IPv6, esta configuração direta precisa de outra forma de acesso.

1. Aponte um subdomínio para o endereço público do computador ou da rede e disponibilize as portas do Caddy. Se houver roteador, encaminhe as portas para o computador. Use um subdomínio dedicado para preservar a configuração do site principal.
2. Copie `.env.example` para `.env`. Preencha `FICHAPRO_DOMAIN` com o subdomínio, sem `https://`, e configure a senha do salão. Nesse modo, o Compose calcula `PUBLIC_URL` usando o subdomínio.
3. Execute `docker compose up -d --build`. Confira `docker compose ps` e abra `https://SEU-SUBDOMINIO/healthz` fora da rede local. O servidor Node e o SQLite ficam na rede interna do Compose.
4. Antes de compartilhar com clientes, faça um atendimento fictício pelo endereço externo e abra o QR no celular.

Para salvar uma cópia consistente do banco enquanto o app está rodando, execute na pasta do projeto:

```sh
umask 077
docker compose exec -T app node server/backup.js > fichapro-backup.sqlite
```

Use um nome novo a cada cópia e confira o código de saída antes de guardar. O arquivo inclui fichas, fotos e PDFs. Mantenha cópias protegidas fora do computador que hospeda o app. Use `docker compose down` para parar preservando os volumes. A opção `--volumes` remove os dados.
