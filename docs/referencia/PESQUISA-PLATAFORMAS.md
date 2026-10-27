# Pesquisa de plataformas de automação de WhatsApp (e SMS/omnichannel) para o reverse do MarcFlow

Data da pesquisa: 26/10/2026. Estrelas, último push, licença e releases foram lidos direto da API do GitHub (`gh api repos/...`) nesse dia. Nada foi clonado.

Ponto de partida, o MarcFlow (github.com/marcolamaia/MarcFlow, MIT, 97 estrelas, criado em 18/10/2026): Next.js 16 + React 19, Baileys `7.0.0-rc.9` como único provedor, Prisma 5 + MySQL, React Flow (`@xyflow/react`) no construtor, `node-cron` para agendamento, Socket.io para tempo real, sem Redis e sem fila de jobs (lido no `package.json` da cópia em `projetos/marcflow-original`). Tudo que aparece abaixo como "o que vale reversar" foi pensado contra essa base.

Legenda de licença:
- **Livre p/ fechado**: dá para usar o código num produto comercial de código fechado (MIT, Apache-2.0, BSD).
- **Copyleft**: dá para usar comercialmente, mas quem usa/derruba precisa abrir o código (GPL na distribuição; AGPL também para quem acessa pela rede; LGPL só na própria biblioteca; MPL só nos arquivos alterados).
- **Fonte disponível**: o código é público, mas a licença proíbe certos usos comerciais (fair-code, FSL, Apache "modificada").

---

## 1. Open source / fonte disponível

### 1.1 Motores de conexão com o WhatsApp (camada "provider")

| Projeto | Link | Licença (uso comercial fechado?) | Stack | Estrelas | Último push | O que faz de melhor | O que vale reversar |
|---|---|---|---|---|---|---|---|
| **Baileys** | github.com/WhiskeySockets/Baileys | MIT (sim) | JS/TS, WebSocket direto no protocolo do WA Web | 11.456 | 26/10/2026 | Sem navegador, leve, base de quase todo o ecossistema BR. Última release `v7.0.0-rc14` em 29/07/2026 (ainda com nome "rc") | Já é o motor do MarcFlow. Vale estudar o `makeCacheableSignalKeyStore` e o store de auth em banco/Redis em vez de arquivo, e subir do rc9 para o rc14 |
| **zapo** | github.com/vinikjkkj/zapo | MIT (sim) | TypeScript | 264 | 26/10/2026 | Biblioteca nova do protocolo WA Web feita para "multi-sessão em escala, pouca memória, zero-copy". Já é provider opcional do Whaticket Community | Candidato a 2º provider ou substituto do Baileys se o MarcFlow for rodar muitas sessões por servidor. Projeto jovem: testar antes de apostar |
| **whatsapp-web.js** | github.com/wwebjs/whatsapp-web.js | Apache-2.0 (sim) | JS + Puppeteer (Chrome) | 22.800 | 25/10/2026 | O mais popular; roda o WA Web real num Chrome, então quebra menos com mudança de protocolo | Só como provider de reserva. Gasta ~1 Chrome por sessão; não serve para escala |
| **wppconnect** / **wppconnect-server** | github.com/wppconnect-team/wppconnect · /wppconnect-server | Lib: LGPL-3.0 (sim, mas alteração na lib precisa ser aberta). Server: Apache-2.0 (sim) | TypeScript + navegador (WA-JS) | 3.509 / 1.060 | 26/10/2026 | Comunidade BR forte; server REST pronto com multi-sessão | Pouco a ganhar além do que Evolution/WAHA já mostram |
| **Venom** | github.com/vynect/venom (antigo orkestral/venom) | Apache-2.0 (sim) | TypeScript + navegador | 6.595 | 09/09/2026 | Histórico longo no BR | Nada específico; mesma família do wppconnect |
| **open-wa** | github.com/open-wa/wa-automate-nodejs | Hippocratic H-DNH 1.1 (não é OSI; cláusulas éticas abertas a interpretação) | TypeScript | 3.675 | 25/10/2026 | API muito completa | Evitar como base: licença com restrições subjetivas para marketing em massa |
| **whatsmeow** | github.com/tulir/whatsmeow | MPL-2.0 (sim; só arquivos alterados da lib precisam ser abertos) | Go | 7.668 | 26/10/2026 | O motor Go mais estável; base de GOWA, wuzapi, Evolution Go e do conector da fazer.ai | Se um dia o motor de sessão sair do Node, este é o caminho |
| **GOWA (go-whatsapp-web-multidevice)** | github.com/aldinokemal/go-whatsapp-web-multidevice | MIT (sim) | Go (whatsmeow) | 4.963 | 25/10/2026 | REST + UI + multi-conta + webhooks + servidor MCP + ponte Chatwoot. Release v9.7.0 em 25/10/2026 | Ideia do servidor MCP (deixar IA operar o WhatsApp por ferramentas) e o desenho enxuto de multi-conta |
| **wuzapi** | github.com/asternic/wuzapi | MIT (sim) | Go (whatsmeow) | 1.045 | 26/10/2026 | API REST minimalista, um token por usuário | Modelo de "usuário = sessão = token" para a API pública |
| **Evolution API** | github.com/evolution-foundation/evolution-api | Apache-2.0 **com condições**: (a) não remover logo/copyright se usar o front deles; (b) **todo projeto que usar, inclusive fechado, tem de mostrar aviso visível de que usa Evolution API** (tela de config/docs), senão pode exigir licença comercial | TypeScript, Prisma (Postgres/MySQL), Redis | 9.960 | 14/07/2026 | Camada de canais com Baileys **e** Cloud API oficial atrás da mesma API; eventos por instância via WebSocket, RabbitMQ, Kafka, SQS, NATS, Pusher; integra Typebot, Chatwoot, Dify, OpenAI, Flowise, n8n; mídia em S3/MinIO; transcrição de áudio. Última release `2.4.0-rc2` (17/05/2026), ritmo caiu | **A abstração de canal** (uma interface, dois providers: Baileys e Cloud API), **o barramento de eventos configurável por instância** e o **gatilho de chatbot por palavra-chave/sessão** das integrações |
| **Evolution Go** | github.com/evolution-foundation/evolution-go | Mesma licença da Evolution API (aviso obrigatório) | Go (whatsmeow) | 960 | 01/10/2026 | Reescrita em Go da Evolution, mais leve | Referência de como eles portaram a mesma API para Go |
| **WAHA** | github.com/devlikeapro/waha | Apache-2.0 (sim) | TypeScript (NestJS) | 7.692 | 22/10/2026 | 5 engines plugáveis (WEBJS, WPP, GOWS, NOWEB, VENOM) atrás de uma API só; desde a versão 2026.6.1 o antigo "Plus" (sessões ilimitadas, mídia, storages, segurança) entrou no Core gratuito ([fonte](https://waha.devlike.pro/docs/how-to/waha-plus/)). Release 2026.9.2 em 02/10/2026 | **Padrão de engine plugável** e **gestão de sessão** (start/stop/restart, status, QR/pairing code, storage de sessão). Licença limpa para copiar |

### 1.2 Construtores de fluxo, chatbot e workflow

| Projeto | Link | Licença (uso comercial fechado?) | Stack | Estrelas | Último push | O que faz de melhor | O que vale reversar |
|---|---|---|---|---|---|---|---|
| **Typebot** | github.com/baptisteArno/typebot.io | **FSL-1.1-Apache-2.0** (fonte disponível): proíbe "Competing Use", ou seja, oferecer comercialmente algo que substitua o Typebot ou tenha funcionalidade "igual ou substancialmente similar". **Cada versão vira Apache-2.0 dois anos depois de lançada** (cláusula "Grant of Future License") | TypeScript, Next.js, Prisma | 10.580 | 26/10/2026 | O melhor construtor de chatbot aberto: blocos tipados, variáveis, condições, integrações, A/B, runtime separado do editor ("viewer"), API de sessão de chat. v3.19.1 em 20/10/2026 | **Motor de execução de fluxo** (sessão, estado, retomada após resposta do usuário), **modelo de blocos/variáveis** e **separação editor × runtime**. Ideias livres; copiar código só de versões com mais de 2 anos |
| **Botpress** | github.com/botpress/botpress | MIT (sim) | TypeScript | 14.969 | 23/10/2026 | Hoje o repo é o SDK/integrações da Botpress Cloud (o Studio é fechado). O último self-host completo é a v12.30.9, de 22/06/2023 | Só o padrão de "integrations" (contrato de canal) do SDK. A v12 está velha demais para base |
| **n8n** | github.com/n8n-io/n8n | **Sustainable Use License** (fair-code): uso interno do negócio liberado; **proibido vender/hospedar como serviço para terceiros**; arquivos `.ee.` exigem licença Enterprise | TypeScript, Vue | 208.663 | 26/10/2026 | Maior ecossistema de nós/integrações | Apenas ideia: execução por item, histórico de execuções com dados de cada nó, credenciais criptografadas. Não copiar código para produto vendido |
| **Activepieces** | github.com/activepieces/activepieces | MIT (sim), exceto `packages/ee/` e `.../app/ee` (licença comercial) | TypeScript (Angular/React + Fastify) | 25.235 | 26/10/2026 | Alternativa MIT ao n8n: "pieces" em TS tipado, triggers por webhook/polling, versões de fluxo, execução em fila | **Arquitetura de motor de workflow MIT**: contrato de "piece" (ações/gatilhos), versionamento publicado × rascunho, worker separado do app. Ótimo para copiar sem medo, fora da pasta `ee` |
| **Flowise** | github.com/FlowiseAI/Flowise | Apache-2.0, exceto pasta `enterprise` (comercial) | TypeScript | 55.531 | 13/08/2026 (**arquivado**) | Construtor visual de agentes de IA. Desenvolvimento congelado em 29/07/2026, repo arquivado em agosto, fim de vida em 31/08/2026; em 10/09/2026 saíram 6 alertas de segurança High/Critical sem correção ([flowiseai.com/sunset](https://flowiseai.com/sunset), [devtoollab](https://devtoollab.com/blog/flowise-alternatives)) | Não usar como base. No máximo olhar a UI de nós de IA |
| **Dify** | github.com/langgenius/dify | Apache-2.0 **modificada**: **proibido operar multi-tenant** (um workspace por cliente) sem autorização escrita; não remover logo do front | Python + Next.js | 159.621 | 26/10/2026 | Plataforma de apps/agentes de IA com RAG e workflow | Ideia de nó de "agente de IA com base de conhecimento" dentro do fluxo. Não copiar código num SaaS multi-cliente |
| **Rasa** | github.com/RasaHQ/rasa | Apache-2.0 (sim) | Python | 21.358 | 24/07/2026 | NLU/diálogo clássico | Pouco útil hoje frente a LLM; status de manutenção do Open Source: não confirmado |
| **BotMan** | github.com/botman/botman | MIT (sim) | PHP | 6.150 | 03/04/2026 | Framework de bot multi-driver | Só o conceito de "driver" por canal; stack diferente |
| **BuilderBot** | github.com/codigoencasa/builderbot | MIT (sim) | TypeScript | 2.976 | 26/10/2026 | Popular na América Latina; fluxos em código (`addKeyword`, `addAnswer`) com providers Baileys/Meta/Twilio etc. v1.4.4 em 06/10/2026 | **Camada de provider multi-canal** (Baileys, Meta Cloud API, Twilio) com a mesma API de fluxo. Licença limpa |
| **Node-RED** | github.com/node-red/node-red | Apache-2.0 (sim) | JavaScript | 23.785 | 26/10/2026 | Fluxo por eventos | Referência de runtime orientado a mensagens; não é foco |

### 1.3 Inbox / multiatendimento / CRM

| Projeto | Link | Licença (uso comercial fechado?) | Stack | Estrelas | Último push | O que faz de melhor | O que vale reversar |
|---|---|---|---|---|---|---|---|
| **Chatwoot** | github.com/chatwoot/chatwoot | MIT (sim), exceto pasta `enterprise/` | Ruby on Rails + Vue | 38.359 | 26/10/2026 | O inbox omnichannel aberto mais completo: atribuição, times, etiquetas, macros, respostas prontas, automações por regra, SLA, CSAT, relatórios, API de "agent bot". v4.19.1 em 24/10/2026 | **Modelo de dados do inbox** (conversation/assignee/team/label/status), **regras de automação** ("quando X e Y, faça Z") e **API de agent bot** para o handoff robô → humano. Stack diferente: reversar desenho, não código |
| **Chatwoot fazer.ai** | github.com/fazer-ai/chatwoot | Mesma do Chatwoot; recursos Pro (Kanban de vendas) pagos | Ruby + Go (conector) | 164 | 23/10/2026 | Fork BR com conexão por QR (conector Go próprio), API oficial com coexistência, grupos, mensagens agendadas e recorrentes que se cancelam se o cliente responder | **Mensagem agendada que se suspende quando o cliente responde** e o Kanban de vendas como ideia |
| **Whaticket Community** | github.com/canove/whaticket-community | MIT (sim) | Node + Express + Sequelize + MySQL; React/Vite | 2.079 | 13/10/2026 | Original do qual saíram quase todos os "atendimento multiatendente" BR. Ciclo de ticket (pendente → aberto → resolvido), filas por setor, várias conexões, provider plugável (whatsapp-web.js ou zapo) | **Ciclo de vida de ticket + filas/setores** e a **camada de provider plugável**. Licença limpa e stack próxima (Node + MySQL) |
| **Press Ticket** | github.com/rtenorioh/Press-Ticket | MIT (sim) | JavaScript | 291 | 27/08/2026 | Fork BR do Whaticket com mais recursos | Mesmo papel do Whaticket, menos ativo |
| **Ticketz** | github.com/ticketz-oss/ticketz | **AGPL-3.0** (copyleft forte: se vender acesso, tem de abrir o código todo) | JavaScript | 319 | 23/10/2026 | Versão aberta e mantida do "Whaticket SaaS". O próprio README conta que o Whaticket SaaS foi vendido com código e **vazou**, sem licença clara | Ver funcionalidades do "Whaticket SaaS" (campanhas, multiempresa, chatbot por fila). **Não copiar código** num produto fechado |
| **Whaticket SaaS** (versões vendidas/vazadas) | sem repo oficial | **Sem licença / origem de vazamento** (ver README do Ticketz) | Node + React | n/a | n/a | Multiempresa, campanhas, kanban | **Não usar**: risco jurídico, autoria indefinida |
| **Izing** | github.com/ldurans/izing.open.io | README declara **AGPL-3.0** (não há arquivo LICENSE) e ainda diz "desde que não seja para fins de comercialização" | Node + Vue/Quasar | 626 | 29/06/2024 (parado) | Multiatendimento BR que antecedeu o Z-PRO | Só olhar telas. Parado há 2 anos e com licença confusa |
| **Z-PRO** | sem fonte pública encontrada | Fechado/vendido. **Não confirmado** se há fonte | n/a | n/a | n/a | n/a | Não há o que reversar sem fonte |
| **erxes** | github.com/erxes/erxes | Licença não identificada pelo GitHub (NOASSERTION); **não confirmado** | TypeScript | 4.100 | 26/10/2026 | "Experience OS": CRM + inbox + marketing | Fora do foco |

### 1.4 Disparo, marketing e infraestrutura de fila

| Projeto | Link | Licença (uso comercial fechado?) | Stack | Estrelas | Último push | O que faz de melhor | O que vale reversar |
|---|---|---|---|---|---|---|---|
| **Mautic** | github.com/mautic/mautic | GPL-3.0 (copyleft na distribuição; SaaS sem distribuir é permitido) | PHP (Symfony) | 10.852 | 26/10/2026 | Automação de marketing: segmentos dinâmicos, campanhas com árvore de decisão, pontuação de lead | **Segmentos dinâmicos** (filtros salvos que se recalculam) e **pontuação de lead** para alimentar transmissões |
| **listmonk** | github.com/knadh/listmonk | AGPL-3.0 (copyleft forte) | Go | 23.993 | 24/10/2026 | Disparo de newsletter de altíssimo volume com controle de taxa, pausa/retomada, listas e opt-out | **Desenho da fila de campanha** (taxa por segundo, lotes, pausar/retomar, reprocessar falhas). Só ideia, não código |
| **BullMQ** | github.com/taskforcesh/bullmq | MIT (sim) | TypeScript + Redis | 9.545 | 26/10/2026 | Fila de jobs com rate limit, prioridade, atraso, repetição e "flows" pai/filho | **Usar direto** como fila de disparo e de passos de fluxo no lugar do `node-cron` (rate limit por sessão, retry com backoff, jobs atrasados para os "esperar X minutos") |
| **Novu** | github.com/novuhq/novu | MIT (sim), exceto pacotes enterprise | TypeScript | 40.206 | 26/10/2026 | Infra de notificação multicanal (SMS, push, e-mail, chat) com workflows e preferências do assinante | **Central de preferências/opt-out por canal** e abstração de provider de SMS (Twilio, Zenvia etc.) para o lado omnichannel |
| **Trigger.dev** | github.com/triggerdotdev/trigger.dev | Apache-2.0 (sim) | TypeScript | 16.621 | 26/10/2026 | Jobs duráveis (esperas longas sem segurar processo) | Padrão de "espera durável" para fluxos com atraso de dias |
| **React Flow (xyflow)** | github.com/xyflow/xyflow | MIT (sim) | TypeScript | 38.789 | 26/10/2026 | Biblioteca de canvas de nós | Já usado pelo MarcFlow; manter |
| **ForgeGrowth-OSS** | github.com/Forgemind-git/ForgeGrowth-OSS | MIT (sim) | JavaScript | 19 | 26/10/2026 | Automação Instagram + WhatsApp com CRM ("comment-to-DM") | Ideia de gatilho por comentário no Instagram; projeto muito pequeno |

Licenças lidas no arquivo LICENSE de cada repo via `gh api repos/<repo>/license` em 26/10/2026. Onde o GitHub mostra "NOASSERTION" (Evolution, n8n, Typebot, Chatwoot, Activepieces, Dify, Flowise, Mautic, open-wa, wppconnect), o texto foi lido e resumido acima.

---

## 2. Plataformas comerciais fechadas: o que têm que o MarcFlow não tem

Referência de funcionalidade, não de código. Fontes em sua maioria de terceiros (reviews e agregadores); preços mudam e devem ser conferidos no site oficial antes de usar.

| Plataforma | O que tem que o MarcFlow não tem | Fonte |
|---|---|---|
| **ManyChat** | Ferramentas de captação (links e QR de entrada, comentário → DM no Instagram), teste A/B dentro do fluxo, "AI Step" e reconhecimento de intenção (add-on pago), mesmo construtor para Instagram, Messenger, WhatsApp, SMS, Telegram e e-mail. Desde 02/03/2026 cobra por contato (Free 25 contatos; Essential ~US$ 15; Pro US$ 29; Business US$ 69, segundo review) | [featurebase.app](https://www.featurebase.app/blog/manychat-pricing), [replyrush](https://www.replyrush.com/post/manychat-pricing-2026) |
| **BotConversa** | Dois modos de conexão no mesmo produto: QR (Starter, R$ 189/mês) e API oficial com coexistência (PRO, R$ 199/mês), preços de jul/2026 segundo terceiro; campanhas e envio em massa; ~5 atendentes por número | [dealism.ai](https://dealism.ai/es/blog/botconversa-price-setup-whatsapp-api-review) (terceiro, conferir no site) |
| **Kommo** | Funil de vendas Kanban (até 50 pipelines) com o robô (Salesbot) movendo o lead entre etapas; IA de resumo, sugestão de resposta, previsão de campo e pontuação de lead. A partir de US$ 15/usuário/mês | [G2](https://g2.com/products/kommo/pricing), [setsmart](https://setsmart.io/blog/kommo-review) |
| **Blip** | É BSP oficial da Meta; assistente de IA treinável 24h; marketplace de extensões (Blip Store); plano PME com Claro (Blip Go) a partir de R$ 179,90 com 50 disparos (ago/2026) | [tiinside](https://tiinside.com.br/10/08/2026/claro-empresas-e-blip-lancam-parceria-com-foco-em-pmes-pelo-whatsapp/), [ABC da Comunicação](https://www.abcdacomunicacao.com.br/blip-store-evolui-para-marketplace-publico-e-acelera-adocao-de-ia-conversacional-pelas-empresas/) |
| **Zenvia** | Omnichannel real (SMS + WhatsApp + voz, inclusive chamada de WhatsApp gravada e cobrada por minuto), "réguas de comunicação" automáticas, reengajamento de quem não abriu, até 40 msg/s, base de conhecimento com IA e insights de campanha | [zenvia.com/precos](https://zenvia.com/precos/), [zenvia promos](https://zenvia.com/promos/dispare-mensagens-em-massa-com-zcc/) |
| **Twilio Studio** | Cada execução vira um registro inspecionável passo a passo; subflows; import/export do fluxo em JSON; gatilho por webhook/REST; widget "Start Conversation" (changelog de 19/03/2026); SMS e voz no mesmo construtor | [twilio.com/docs/studio](https://www.twilio.com/docs/studio/user-guide), [changelog](https://www.twilio.com/en-us/changelog/start-conversation-widget-now-available-in-studio) |
| **Respond.io** | Workflows com etapas de ciclo de vida do cliente (lifecycle), handoff de anúncios Click-to-WhatsApp/TikTok para IA ou humano, agentes de IA, cobrança por contato ativo no mês (Starter US$ 79, Growth US$ 159, Advanced US$ 279) | [eesel.ai](https://www.eesel.ai/blog/respond-io-pricing), [Capterra](https://capterra.com/p/179311/Rocketbots/) |
| **Wati** | Construtor arrastar-e-soltar de **WhatsApp Flows** (formulários nativos dentro do chat) que grava respostas como atributos do contato; catálogo + link de pagamento automático | [support.wati.io](https://support.wati.io/en/articles/11463180), [wati.io/paytabs](https://www.wati.io/en/paytabs/) |
| **Gupshup** | Template carrossel com até 10 cards de produto; pagamentos dentro do WhatsApp (só Índia e Singapura); BSP de grande volume | [gupshup.io](https://gupshup.io/developer/whatsapp-api/india) |
| **Interakt** | WhatsApp Pay nativo (só números +91) e checkout automático a partir do catálogo; workflows por evento (agendamento, cadastro) | [interakt.shop](https://www.interakt.shop/resource-center/whatsapp-pay-with-interakt/) |
| **SendPulse** | Plano gratuito (3 bots, 500 inscritos); WhatsApp + Instagram + Telegram + e-mail + SMS na mesma conta; é BSP oficial com acesso à API sem taxa própria | [sendpulse.com/pricing/messengers](https://sendpulse.com/pricing/messengers) |
| **Umbler Talk** | Setores/departamentos, agendamento de mensagens, relatórios de desempenho por atendente, agentes de IA e CRM num número só | [b2bstack](https://www.b2bstack.com.br/product/umbler-talk), [Capterra](https://www.capterra.com/p/10012853/Umbler-Talk/) |
| **Digisac** | WABA oficial com vários usuários simultâneos + Telegram, WebChat, SMS e e-mail no mesmo inbox; parceira Premium da Gupshup | [canaltech](https://canaltech.com.br/mercado/como-ter-varios-agentes-atendendo-pelo-whatsapp-em-um-unico-lugar-e-numero-208080/), [digisac blog](https://digisac.com.br/blog/digisac-recebe-premio-internacional-da-gupshup) |

Resumo das lacunas do MarcFlow que aparecem em quase todas:
1. **API oficial (Cloud API) como segundo provider**, de preferência com coexistência. Hoje é só Baileys.
2. **Fila de verdade** com controle de taxa (MarcFlow usa `node-cron`, sem Redis).
3. **Funil/CRM** (etapas de lead, pontuação) e **ciclo de vida do contato**.
4. **IA no fluxo** (passo de IA, classificação de intenção, resumo da conversa).
5. **Omnichannel** (SMS, Instagram, Telegram, e-mail) com central de opt-out por canal.
6. **Execuções inspecionáveis** (log por passo de cada lead que passou no fluxo) e **A/B no fluxo**.
7. **Multiempresa (multi-tenant)**, times, setores e relatórios por atendente.
8. Recursos nativos da Meta: **WhatsApp Flows** (formulário), carrossel, catálogo/pagamento.

---

## 3. API oficial × não oficial

### 3.1 Custos da API oficial (Cloud API / BSP) em 2026

| Item | Valor | Fonte e data |
|---|---|---|
| Modelo de cobrança | Por mensagem entregue, por categoria (marketing, utilidade, autenticação, serviço) e país; desde 01/07/2025 | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) (lido em 26/10/2026) |
| Marketing, Brasil | **R$ 0,3217** por mensagem (vigente desde 01/10/2026) | [chatmaxima.com](https://chatmaxima.com/pt-br/whatsapp-api-pricing/brazil/), citando a tabela da Meta. Fonte secundária: a tabela oficial carrega por script e não abriu na leitura |
| Marketing, Brasil, em dólar | **US$ 0,0625** por mensagem | [EngageLab](https://www.engagelab.com/blog/whatsapp-business-api-pricing) e [Chatfuel](https://sdk.chatfuel.com/blog/whatsapp-business-api-pricing). Secundária; não achei no rate card da Meta |
| Utilidade e autenticação, Brasil | **R$ 0,0350** (lista), com faixas de volume até **R$ 0,0263** (-25%). Em dólar, a própria Meta cita "cerca de 0,68 centavo" (~US$ 0,0068) | [chatmaxima.com](https://chatmaxima.com/pt-br/whatsapp-api-pricing/brazil/); valor em centavos na [página da Meta](https://developers.facebook.com/docs/whatsapp/pricing) |
| Serviço (resposta dentro da janela de 24h) | 1.000 grátis por número por mês; **desde 01/10/2026 a Meta voltou a cobrar** mensagens de serviço e utilidade enviadas dentro da janela aberta (R$ 0,0350 no Brasil, segundo terceiro) | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing); valor BR em [chatmaxima](https://chatmaxima.com/pt-br/whatsapp-api-pricing/brazil/) |
| Janela grátis de anúncio | Quem chega por anúncio Click-to-WhatsApp abre janela de até **7 dias** em que marketing, utilidade, autenticação e serviço são grátis | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| Meta Business Agent (IA da própria Meta) | Categoria nova desde 01/07/2026, **US$ 2,00 por 1 milhão de tokens** (~4 a 5 centavos por mensagem) | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| Moeda no Brasil | Cobrança em **BRL** desde 01/07/2026; contas fora de BRL precisam migrar até **30/06/2027** ou deixam de entregar a partir de 01/07/2027 | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| Quando o preço muda | Só em 1º de janeiro, abril, julho ou outubro, com aviso mínimo de 1 mês (tabela) | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| Taxa do BSP | Por cima do valor da Meta (varia por fornecedor; ex.: SendPulse diz não cobrar acesso) | [sendpulse](https://sendpulse.com/pricing/messengers); demais: não confirmado |

Conta rápida: 10.000 mensagens de marketing no Brasil = ~R$ 3.217 só de Meta (R$ 0,3217 × 10.000), sem contar o BSP. A mesma quantidade em utilidade = ~R$ 350.

### 3.2 Regras da API oficial

| Regra | O que diz | Fonte |
|---|---|---|
| Opt-in | Só pode mandar mensagem para quem deu o número **e** confirmou que quer receber daquela empresa; o opt-in precisa nomear a empresa; pode ser coletado por site, SMS, URA, papel. Recomenda opt-in e opt-out por categoria | [Meta, Getting opt-in](https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in) (política de nov/2024) |
| Template | Fora da janela de 24h só sai template aprovado (marketing, utilidade ou autenticação) | [Meta, Pricing](https://developers.facebook.com/docs/whatsapp/pricing) |
| Limite de envio | Começa em **250** destinatários únicos por 24h fora da janela; sobe para **2.000** (verificando a empresa ou mandando 2.000 mensagens de qualidade em 30 dias), depois **10 mil, 100 mil e ilimitado** de forma automática. O limite é **por portfólio**, dividido entre todos os números | [Meta, Messaging limits](https://developers.facebook.com/docs/whatsapp/messaging-limits) |
| Limite por usuário de marketing | Dinâmico, sem número fixo: a Meta deixa de entregar marketing a quem anda lendo pouco. Erro genérico 131026; esperar 24h para reenviar. Templates de marketing **não são entregues para números dos EUA (+1)** | [Meta, Per-user limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/) (atualizada 17/06/2026) |
| IA genérica | Desde 15/01/2026 os termos proíbem chatbots de IA de uso geral (tipo ChatGPT) como produto principal; IA de atendimento de empresa continua liberada | [respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban), [TechRadar](https://techradar.com/ai-platforms-assistants/meta-will-ban-rival-ai-chatbots-from-whatsapp) (secundárias) |
| Coexistência | Desde mai/2025 o mesmo número pode ficar no app WhatsApp Business **e** na Cloud API, com espelhamento das mensagens; listas de transmissão do app ficam só leitura. Brasil listado como ativo por fornecedores | [Telnyx](https://telnyx.com/release-notes/whatsapp-coexistence), [whautomate](https://whautomate.com/whatsapp-coexistence). Confirmação da Meta para o Brasil: não confirmado |

### 3.3 Não oficial (Baileys, WA Web, QR code)

| Ponto | O que se sabe | Fonte |
|---|---|---|
| Termos | As diretrizes do WhatsApp citam "clientes não oficiais, mensagens em massa, mensagens automáticas, discagem automática ou automação" como comportamento adversário quando usados para prejudicar o WhatsApp ou usuários | [whatsapp.com/legal/messaging-guidelines](https://www.whatsapp.com/legal/messaging-guidelines?lang=en) |
| Escala de banimento | Em 2019 o WhatsApp dizia banir **mais de 2 milhões de contas por mês** por comportamento em massa/automatizado, 75% sem denúncia de usuário (dado antigo; número atual não confirmado) | [Business Insider](https://www.businessinsider.in/whatsapp-can-sue-you-for-sending-bulk-messages/articleshow/69771841.cms) |
| Risco prático | Risco cresce com mensagem **ativa** (para quem não falou antes); resposta a quem chamou é de menor risco. Sem apelação confiável | [achiya-automation](https://achiya-automation.com/en/blog/whatsapp-spam-detection-2026/), [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/12969/integrate-whatsapp-evolution-api-vs-cloud-api) (blogs de fornecedor) |
| Estatística "68% dos negócios com automação não oficial levaram ban em 12 meses" | Citada por blog, estudo original não encontrado | **não confirmado** |
| Prazo "banido em 2 a 8 semanas" | Estimativa de blog | **não confirmado** |
| Custo | Zero por mensagem; custo é chip/número, servidor e reposição de números banidos | n/a |
| Avisos dos próprios projetos | Whaticket Community: "números conectados assim podem ser bloqueados"; Evolution API: "pode ter limitações frente às APIs oficiais" | READMEs dos repos |

**Leitura para o MarcFlow:** o produto hoje é 100% não oficial. Para transmissões de marketing em volume, o risco de ban é real e não há como medir com número confiável. O caminho que o mercado inteiro seguiu (BotConversa, Whaticket, Evolution, fazer.ai) é ter **os dois providers atrás da mesma interface**: QR (Baileys) para atendimento e grupos, Cloud API para disparo com template, opt-in e custo previsível.

---

## 4. Recomendação: top 5 para dar reverse

Ordem pensando em "reescrever o MarcFlow mais otimizado, podendo virar produto fechado".

### 1º Evolution API: camada de canais e barramento de eventos
- **Por quê:** resolve a maior lacuna do MarcFlow (só Baileys). Tem a abstração pronta de canal com Baileys e Cloud API lado a lado, eventos por instância (WebSocket, RabbitMQ, Kafka, SQS, NATS), mídia em S3/MinIO e gatilho de chatbot externo. Mesma stack (TypeScript + Prisma + MySQL/Postgres).
- **O que pegar:** interface `ChannelService` com dois providers; configuração de eventos por instância; padrão de integração de chatbot por gatilho (palavra-chave, "todos", expiração de sessão).
- **Risco de licença:** **médio-baixo**. Apache-2.0 com duas condições: se copiar código, o produto (mesmo fechado) **tem de mostrar um aviso visível de que usa Evolution API** e não pode tirar logo do front deles. Reescrever a ideia sem copiar código não aciona nada. Ponto de atenção: ritmo caiu (último push 14/07/2026, release ainda rc).

### 2º Typebot: motor de fluxo e editor
- **Por quê:** é o melhor exemplo aberto de motor de chatbot: sessão de conversa com estado, retomada quando o usuário responde, blocos tipados, variáveis, condições, A/B, runtime separado do editor. O construtor do MarcFlow ganha muito copiando esse modelo.
- **O que pegar:** formato do grafo (grupos → blocos → arestas), máquina de estado da sessão (`continueChat`/`startChat`), separação "builder" × "viewer", tipos de bloco de entrada com validação.
- **Risco de licença:** **alto para copiar código, zero para copiar ideia**. FSL-1.1 proíbe "Competing Use", e um construtor de chatbot de WhatsApp vendido é exatamente isso. Exceção: **cada versão vira Apache-2.0 dois anos depois do lançamento**, então código de versões lançadas até ~out/2024 já pode ser usado sob Apache.

### 3º Chatwoot (com o fork fazer.ai): inbox e automações de atendimento
- **Por quê:** referência de inbox de produção: atribuição, times, etiquetas, status, macros, respostas prontas, regras de automação, SLA, CSAT, relatórios e API de "agent bot" para passar do robô para humano. O fork da fazer.ai mostra o que o mercado BR pede (QR, coexistência, grupos, mensagem agendada que se cancela se o cliente responder, Kanban).
- **O que pegar:** modelo de dados de conversa (conversation, assignee, team, label, status, priority), motor de regras "evento → condição → ação", handoff robô ↔ humano por API, relatórios por atendente.
- **Risco de licença:** **baixo**. MIT fora da pasta `enterprise/`. Stack Ruby/Vue, então o reverse é de desenho, não de copiar arquivos.

### 4º WAHA (e GOWA como par em Go): multi-sessão e engines plugáveis
- **Por quê:** o MarcFlow vai precisar de muitas sessões estáveis. WAHA tem o padrão mais limpo de "uma API, várias engines" (WEBJS, NOWEB/Baileys, GOWS/whatsmeow etc.) e gestão de sessão completa; desde jun/2026 tudo que era pago está no Core gratuito. GOWA (MIT, Go) mostra multi-conta enxuta e um servidor MCP para IA operar o WhatsApp.
- **O que pegar:** ciclo de vida da sessão (start, stop, restart, logout, status, QR e pairing code), persistência de sessão em banco/storage, health check e reconexão; a ideia de expor MCP.
- **Risco de licença:** **baixo**. WAHA Apache-2.0; GOWA MIT; whatsmeow (motor do GOWA) MPL-2.0, que só exige abrir alterações feitas nos próprios arquivos dele.

### 5º Activepieces: motor de workflow e integrações, com BullMQ por baixo
- **Por quê:** é o "n8n com licença MIT". Mostra como fazer execução em worker separado, versões publicadas × rascunho, gatilhos por webhook e "pieces" (integrações) tipadas em TypeScript. Junta bem com **BullMQ** (MIT) para trocar o `node-cron` do MarcFlow por fila com rate limit por número, retry e jobs atrasados, que é o coração de um disparador.
- **O que pegar:** contrato de piece/trigger, histórico de execução por passo (o que o Twilio Studio e o n8n vendem), versionamento de fluxo; do BullMQ, rate limiter por grupo (um grupo por sessão de WhatsApp) e flows pai/filho para campanhas.
- **Risco de licença:** **baixo**, desde que fique fora de `packages/ee/` e `packages/server/api/src/app/ee` (licença comercial). Comparação: **n8n não serve como base de código para produto vendido** (Sustainable Use License proíbe oferecer como serviço a terceiros e os arquivos `.ee.` exigem licença Enterprise).

### Menções e o que evitar

| Situação | Projetos | Motivo |
|---|---|---|
| Vale olhar | Whaticket Community (MIT), BuilderBot (MIT), Mautic (GPL-3.0, segmentos e pontuação), listmonk (AGPL, desenho da fila de campanha), Novu (MIT, opt-out por canal e provider de SMS), zapo (MIT, motor leve) | Peças pontuais: ciclo de ticket, provider multi-canal, segmentação, fila de campanha, SMS |
| **Copyleft forte, só ideia** | Ticketz (AGPL-3.0), Izing (AGPL-3.0 declarada + "sem comercializar"), listmonk (AGPL-3.0), Windmill (AGPL na maior parte) | AGPL obriga abrir o código do sistema inteiro para quem usa pela rede. Incompatível com produto fechado |
| **Fonte disponível, não copiar** | n8n (Sustainable Use), Typebot (FSL, salvo versões com 2+ anos), Dify (proíbe multi-tenant), Evolution (aviso obrigatório) | Restringem revenda/SaaS ou exigem atribuição visível |
| **Não usar** | Whaticket SaaS "vazado", Z-PRO (sem fonte), Flowise (arquivado com falhas de segurança sem correção), open-wa (licença Hippocrática), Botpress v12 (parado desde 2023) | Risco jurídico, abandono ou segurança |

---

## Fontes principais
- Dados de repositório: API do GitHub (`gh api repos/<dono>/<repo>`, `/license`, `/releases`), consultada em 26/10/2026.
- Meta, preços: https://developers.facebook.com/docs/whatsapp/pricing
- Meta, limites de envio: https://developers.facebook.com/docs/whatsapp/messaging-limits
- Meta, opt-in: https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in
- Meta, limite por usuário de marketing: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/
- Preço Brasil em BRL: https://chatmaxima.com/pt-br/whatsapp-api-pricing/brazil/
- Diretrizes do WhatsApp: https://www.whatsapp.com/legal/messaging-guidelines?lang=en
- WAHA Plus → Core: https://waha.devlike.pro/docs/how-to/waha-plus/
- Fim do Flowise: https://flowiseai.com/sunset
- Demais fontes citadas nas tabelas, linha a linha.
