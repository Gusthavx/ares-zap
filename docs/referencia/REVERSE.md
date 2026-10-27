# MarcFlow — engenharia reversa

Fonte: clone de `marcolamaia/MarcFlow` (3 commits, último em 18/10/2026: "Aba Exportar conversas…").
Método: só leitura do código. Nada foi instalado nem executado. `package-lock.json` ignorado; `swagger.json` lido por amostra.

Convenções deste documento:
- `arquivo:linha` aponta para o código original (caminhos relativos à raiz do repo).
- **Hipótese** = não confirmei no código, é inferência.
- "Session.id" = cuid interno do banco; "Session.sessionId" = string curta usada pelo Baileys, pelas salas do Socket.IO e pelas URLs. A mistura das duas é uma das maiores fontes de bug (ver 6.4).

---

## 0. Resumo em 15 linhas

1. Um único processo Node (`tsx src/server/index.ts`) sobe o Next 16, o Socket.IO e todas as sessões do WhatsApp (Baileys 7 rc.9). Não há worker, fila nem segundo processo.
2. Toda a lógica de tempo roda em `setInterval` no mesmo processo: fluxos (15 s), transmissões agendadas (15 s), mensagens agendadas (duas vezes: node-cron a cada 1 min **e** setInterval a cada 30 s), além de laços `for(;;)` para transmissão e exportação.
3. O estado de autenticação do Baileys fica no MySQL (`AuthState`, uma linha por chave Signal), sem transação.
4. O motor de fluxos é bom: grafo JSON com 8 tipos de bloco, snapshot do grafo por execução, fila por contato, espera persistida no banco (`FlowRun.wait` + `resumeAt`), menu como enquete com voto descriptografado, simulador que não toca no WhatsApp.
5. Cada mensagem recebida dispara de 20 a 30 consultas ao banco em 5 ouvintes diferentes (estimativa a partir do código, ver 6.1).
6. O Socket.IO não tem autenticação nenhuma: qualquer cliente entra na sala de qualquer sessão e recebe mensagens, QR e presença (`src/server/socket.ts:13-21`).
7. Não existe limitação de taxa (rate limit) em lugar nenhum, embora o `.env.example` anuncie `ENABLE_RATE_LIMITING`.
8. Transmissão usa intervalo fixo, sem variação aleatória (jitter), mínimo de 2 s (`src/modules/broadcast/runner.ts:9-11,117`), enquanto a documentação promete "10-20 s aleatório" (`src/lib/swagger.ts:33`).
9. O anti-spam vem desligado por padrão (`prisma/schema.prisma:277`) e só atrasa depois de estourar o limite.
10. `syncFullHistory: true` + download de toda mídia do histórico no primeiro pareamento (`src/modules/whatsapp/instance.ts:71`, `store/index.ts:493-495`).
11. Reconexão: 3 tentativas fixas de 3 s, depois a sessão fica parada até alguém clicar em Iniciar (`instance.ts:21,164-200`).
12. Muitos restos do projeto original (indonésio, hipótese): fuso `Asia/Jakarta` fixo, DDI `62` padrão, comentário em indonésio.
13. Há código duplicado ou morto: dois agendadores na mesma tabela, `ppguard`, modelo `Story`, `Message.contactId`, evento de webhook `connection.update` que nunca dispara.
14. ~15 tabelas não têm chave estrangeira para `Session`: apagar uma sessão deixa órfãos e arquivos no disco.
15. Tamanho: 278 arquivos e 39,6 mil linhas em `src/`; 122 rotas de API; 4.425 linhas só de Swagger escrito à mão.

---

## 1. Mapa da arquitetura

### 1.1 Processos e inicialização

| Peça | Onde | O que faz |
|---|---|---|
| Entrada | `package.json` scripts `dev`/`start` → `npx tsx src/server/index.ts` | TypeScript compilado em tempo de execução, inclusive em produção. O Dockerfile reinstala `tsx` e `typescript` na imagem final para isso (`Dockerfile:17,38`). |
| Variáveis | `src/server/index.ts:1-3` | `loadEnvConfig` do `@next/env` antes de qualquer import. |
| Trava de segredo | `src/server/index.ts:18-21` | Sai com erro se `AUTH_SECRET` não existir. |
| Next | `src/server/index.ts:23-37` | `next({dev, hostname, port})`; servidor HTTP próprio que repassa tudo ao `handle`. Porta padrão 3030, host padrão `localhost` (`:15-16`). |
| Socket.IO | `src/server/index.ts:39-50` | Mesmo servidor HTTP, `path: "/api/socket/io"`, `cors.origin: "*"`. Instância guardada em `global.io` para as rotas do Next emitirem eventos. |
| WhatsApp | `src/server/index.ts:53-54` | `waManager.setup(io)` + `waManager.loadSessions()`. |
| Agendadores | `src/modules/whatsapp/manager.ts:14-19` (construtor do singleton) | `initScheduler()` (node-cron, mensagens agendadas), `startFlowScheduler()` (15 s), `pauseOrphanedBroadcasts()`, `startBroadcastScheduler()` (15 s). |
| Mais agendadores | `src/server/index.ts:57,60` | `pauseOrphanedArchives()` e `startScheduler()` (o segundo agendador de mensagens, 30 s). |
| Keep-alive | `src/server/index.ts:64-65` | 120 s, para evitar erro 520 da Cloudflare. |
| PM2 | `ecosystem.config.js:10-11` | `exec_mode: "fork"`, 1 instância, reinicia acima de 1 GB. |

Consequência: o Next (rotas de API, server actions, páginas) e o Baileys dividem o mesmo event loop. Uma regex lenta numa resposta automática, um `sharp` grande ou uma consulta pesada travam o WhatsApp de todas as sessões ao mesmo tempo.

Compartilhamento de estado entre o código carregado pelo `tsx` e o código empacotado pelo Next: o projeto usa `global` para os singletons que precisam ser únicos (`waManager` em `manager.ts:173-177`, filas do motor de fluxos em `flows/engine.ts:58-59`, `__broadcastRunning` em `broadcast/runner.ts:13-14`, `__archiveRunning` em `archive/import.ts:24-26`, filas de respostas rápidas em `quick-replies/run.ts:12-13`).
**Hipótese:** o Prisma só é guardado no `global` fora de produção (`src/lib/prisma.ts:11`). Em produção, o módulo carregado pelo `tsx` e o empacotado pelo Next criariam dois `PrismaClient` (dois pools de conexão). O mesmo vale para o singleton `antispam` (`antispam.ts:22-37`), que não usa `global`.

### 1.2 Proteção de rotas

- `src/proxy.ts` (convenção do Next 16): rotas públicas `/auth/login`, `/auth/register`, `/api/auth`, `/api/test`, `/terms`, `/privacy` (`:9`). Em `/api/*`, qualquer cabeçalho `x-api-key` (com qualquer valor) passa direto, e a rota valida depois (`:36-40`); sem a chave, exige sessão do NextAuth. `/dashboard` redireciona para o login.
- `middleware.ts` na raiz também existe, com outro `matcher` que exclui `api`. **Hipótese:** como o app está em `src/app`, o Next só carrega o `src/proxy.ts`; o da raiz é resto.
- Na prática a proteção real está em cada rota: `getAuthenticatedUser(request)` (chave de API primeiro, depois sessão; `src/lib/api-auth.ts:41-65`) + `canAccessSession` (`:88-128`). A auditoria das 122 rotas mostrou que todas, exceto as públicas por desenho, chamam as duas funções (ver 4.7).

### 1.3 Ciclo de vida da sessão do WhatsApp

Classes: `WhatsAppManager` (`src/modules/whatsapp/manager.ts`) guarda um `Map<sessionId, WhatsAppInstance>` em memória (`:11`). `WhatsAppInstance` (`src/modules/whatsapp/instance.ts`) embrulha um `WASocket`.

**Criação** (`manager.ts:66-97`): grava `Session` com `status: "STOPPED"` e um `BotConfig` padrão. O id é o que o usuário mandou ou `Math.random().toString(36).substring(7)` (`:76`), ou seja, 4 a 6 caracteres (ver 6.3). Não conecta: o usuário clica em Iniciar.

**Ao subir o servidor** (`manager.ts:32-64`): lê todas as sessões com `status != LOGGED_OUT`; para cada uma conta linhas em `AuthState`; se zero, marca `STOPPED`; senão cria a instância e chama `init()` **em sequência** (`await` dentro do `for`).

**`init()`** (`instance.ts:46-94`):
1. Lê `Session` + `BotConfig`.
2. `usePrismaAuthState(sessionId)` (ver 1.4).
3. `fetchLatestBaileysVersion()` — chamada de rede a cada init, inclusive a cada reconexão (`:59`).
4. `makeWASocket` com `browser: ["Ubuntu","Chrome","20.0.04"]`, `markOnlineOnConnect: botConfig.alwaysOnline ?? true`, `syncFullHistory: true` (`:61-72`).
5. Troca `socket.sendMessage` por um invólucro que primeiro passa pelo anti-spam (`:75-80`).
6. Liga os ouvintes: `bindSessionStore`, `bindContactSync`, `bindChatState` (`:83-87`), `creds.update → saveCreds` (`:89`), `connection.update → handleConnectionUpdate` (`:91`).

**Máquina de estados** (`handleConnectionUpdate`, `instance.ts:96-238`; status gravado em `Session.status`, string livre):

| Evento | Ação | Status |
|---|---|---|
| `qr` recebido | zera tentativas, guarda QR em memória e em `Session.qr`, emite `connection.update {status, qr}` na sala `sessionId` (`:100-113`) | `SCAN_QR` |
| pareamento por código | `requestPairingCode(número)` (`:240-264`), emite `pairingCode` | `SCAN_QR` |
| `close` com `loggedOut` | apaga todo o `AuthState` da sessão em transação, tira da memória (`:119-143`) | `LOGGED_OUT` |
| `close` após `shutdown()` | preserva credenciais, tira da memória (`:145-162`) | `STOPPED` |
| `close` inesperado | até 3 tentativas, `setTimeout(init, 3000)` fixo, sem backoff (`:164-181`) | `DISCONNECTED` |
| 4ª queda seguida | desiste, `isStopped = true`, tira da memória (`:182-200`) | `STOPPED` |
| `open` | zera tentativas, `syncGroups` (`:214`), `bindAutoReply` e `bindPpGuard` (`:219-220`), grava status | `CONNECTED` |

`stopSession`/`restartSession`/`deleteSession` em `manager.ts:112-164`. Rota de ação: `POST /api/sessions/[sessionId]/[action]` com `start|stop|restart|logout|pair` (`src/app/api/sessions/[sessionId]/[action]/route.ts:27-65`).

QR também pode ser lido por `GET /api/sessions/[sessionId]/qr`, que devolve o texto e uma imagem base64 gerada com `qrcode` (`.../qr/route.ts:30-54`).

### 1.4 Estado de autenticação (onde e como é salvo)

`src/modules/whatsapp/auth/usePrismaAuthState.ts`, tabela `AuthState(sessionId string, key, value Json)` com `@@unique([sessionId, key])` (`prisma/schema.prisma:197-204`).

- Chave = `"${tipo}-${id}"` com maiúsculas escapadas (`^a` para `A`), porque a colação padrão do MySQL ignora maiúsculas e ids base64 colidiam (`:11`, comentário em `:5-10`).
- Leitura: um `findUnique` por chave; `keys.get` faz `Promise.all` de N leituras (`:66-80`). `app-state-sync-key` é reconvertido com `proto.Message.AppStateSyncKeyData.fromObject` (`:70-75`).
- Escrita: `keys.set` dispara um `upsert` (ou `deleteMany`) por chave em paralelo, **sem transação** (`:82-98`). Uma queda no meio deixa o conjunto de chaves inconsistente (**hipótese** de efeito: erros "bad mac"/"bad decrypt" depois).
- `creds` vai na chave `creds-me` (`:60,101`).
- O Baileys recebe `makeCacheableSignalKeyStore` por cima (cache em memória) (`instance.ts:67`).
- `AuthState.sessionId` é a string curta e **não tem chave estrangeira**: `deleteSession` (`manager.ts:112-119`) não apaga essas linhas.

### 1.5 Multi-sessão e multi-usuário

- Papéis: `SUPERADMIN`, `OWNER`, `STAFF` (`schema.prisma:13-17`). Cadastro público cria `OWNER` (`src/app/api/auth/register/route.ts:43-49`) enquanto `SystemConfig.enableRegistration` for `true` (padrão: `schema.prisma:300`).
- Uma `Session` pertence a um `User`; outros usuários ganham acesso por `SessionAccess` (`schema.prisma:350-362`). `canAccessSession` aceita o id cuid **ou** a string (`api-auth.ts:94-114`).
- `SUPERADMIN` vê tudo (`api-auth.ts:89-91`) e seus webhooks globais recebem eventos de **todas** as sessões (`src/lib/webhook.ts:58-74`).
- `STAFF` não tem restrição própria: na prática quem tem acesso compartilhado pode iniciar, parar, deslogar, mudar `config` e até **apagar** a sessão (`sessions/[sessionId]/settings/route.ts:95-109` usa `canAccessSession`, não `isSessionOwner`).
- Todas as sessões rodam no mesmo processo; não há limite de sessões por usuário.

### 1.6 Tempo real (Socket.IO)

Servidor: só três eventos de entrada (`src/server/socket.ts`): `join-session` (entra na sala com o nome do `sessionId`, `:13-16`), `join-user-room` (sala `user:<id>`, `:19-22`), `disconnect`. Nenhuma verificação de quem pede.

Eventos emitidos:

| Evento | Sala | Origem | Consumidor no front |
|---|---|---|---|
| `connection.update` | sessionId | `instance.ts`, `manager.ts:126` | página da sessão |
| `message.upsert` (WAMessage bruto) | sessionId | `store/index.ts:46` | **ninguém** (tráfego morto) |
| `message.update` (linhas do banco) | sessionId | `store/index.ts:98,375` | `chat-window.tsx:304`, `chat-list.tsx:360` |
| `chat.read`, `presence.update` | sessionId | `store/chat-state.ts:49,55` | lista e janela de chat |
| `broadcast.progress` | sessionId (string) | `broadcast/runner.ts:24` | `dashboard/broadcast/page.tsx:69` |
| `quickreply.progress` | sessionId | `quick-replies/run.ts:19` | `components/chat/quick-replies.tsx:50` |
| `notification:new` | `user:<id>` | rotas de notificação e update | navbar |

Além disso o front faz polling: métricas da sessão a cada 3 s (`dashboard/sessions/[sessionId]/page.tsx:126`), monitor do sistema a cada 3 s (`dashboard/system-monitor/page.tsx:45`), exportação a cada 2,5 s (`dashboard/archive/page.tsx:59`), faixa de "robô pausado" a cada 30 s (`components/chat/bot-paused-banner.tsx:17`), logs de webhook (`components/dashboard/webhook-log-dialog.tsx:168`).

### 1.7 Fluxo de uma mensagem recebida (visão geral)

O socket do Baileys tem **cinco** ouvintes de `messages.upsert`/história, cada um com suas próprias consultas:

```
messages.upsert ─┬─ store/index.ts:37      salvar mensagem, contato, boas-vindas, webhook, bot de comandos, fluxos, não lidas
                 └─ store/autoreply.ts:59  respostas automáticas (ligado só no "open")
messaging-history.set ─┬─ store/index.ts:103   salva mensagens do histórico (com download de mídia)
                       ├─ store/contacts.ts:65 cria contatos a partir das conversas
                       └─ store/chat-state.ts:28 contadores de não lidas
                         (+ archive/import.ts:219 durante uma exportação)
```

Detalhe em 3.4 e o custo em 6.1.

---

## 2. Modelo de dados (`prisma/schema.prisma`, MySQL, 704 linhas)

### 2.1 Tabelas

Coluna "FK Session": se a tabela tem relação Prisma com `Session` (e por isso cascata ao apagar). "Chave de sessão": qual id ela guarda.

| Modelo | Linhas | Para que serve | FK Session | Chave de sessão |
|---|---|---|---|---|
| `User` | 38-52 | login (e-mail + bcrypt), `role`, `apiKey` em texto puro (`@unique`) | — | — |
| `Session` | 54-77 | conta de WhatsApp: `name`, `sessionId` (único), `status` (string livre), `qr`, `config` Json (ex.: `antiDelete`) | — | — |
| `Contact` | 79-97 | contato por sessão: `jid`, `lid`, `name`, `notify` (pushname), `verifiedName`, `remoteJidAlt`, `profilePic`, `data` Json bruto. Único `(sessionId, jid)` | sim | Session.id |
| `Message` | 99-122 | mensagens: `remoteJid`, `senderJid`, `fromMe`, `keyId`, `type` (enum de 8), `content`, `mediaUrl`, `status` (enum), `timestamp`, `quoteId`, `contactId` (nunca preenchido). Único `(sessionId,keyId)`; índices `(sessionId,remoteJid)` e `(sessionId,remoteJid,timestamp)` | sim | Session.id |
| `Group` | 124-150 | metadados de grupo; `participants` e `metadata` em Json; comunidade | sim | Session.id |
| `AutoReply` | 152-165 | regra de resposta automática: `keyword`, `matchType` EXACT/CONTAINS/REGEX, `response`, mídia por URL, `triggerType` ALL/GROUP/PRIVATE | sim | Session.id |
| `Story` | 167-178 | status/story — **não usado** em nenhum lugar do código | sim | Session.id |
| `ScheduledMessage` | 180-194 | mensagem agendada: `jid`, conteúdo, mídia por URL, `sendAt`, `cronExpression`, `recurrenceRule` (estado da UI), `status` | sim | Session.id |
| `AuthState` | 197-204 | chaves do Baileys (ver 1.4) | **não** | Session.sessionId |
| `Webhook` | 207-222 | destino HTTP: `url`, `secret` (HMAC), `events` Json, `sessionId` opcional (nulo = global do usuário) | sim (opcional) | Session.id |
| `WebhookLog` | 225-243 | cada tentativa de entrega, com corpo e resposta | via Webhook | — |
| `BotConfig` | 252-292 | 1:1 com Session: bot de comandos (prefixo, modo de acesso, figurinha, remove.bg), modo da resposta automática, anti-spam, boas-vindas, `autoRead`, `alwaysOnline` | sim | Session.id |
| `SystemConfig` | 294-303 | linha única `"default"`: nome, logo, favicon, `timezone` (padrão `Asia/Jakarta`), `enableRegistration` | — | — |
| `Label` | 306-319 | etiqueta **local** (não sincroniza com etiquetas do WhatsApp Business) | **não** | **Session.sessionId** |
| `ChatLabel` | 322-333 | etiqueta ↔ conversa (`chatJid`); sem coluna de sessão | via Label | — |
| `Notification` | 335-347 | avisos do sistema por usuário | — | — |
| `SessionAccess` | 350-362 | compartilhamento de sessão com outro usuário | sim | Session.id |
| `BroadcastLog` | 365-386 | campanha: mensagem, totais, `status` (scheduled/running/paused/completed/cancelled), `delay`, anexo (`mediaAssetId`), `pauseOnFailure`, `skipOptedOut`, `scheduledAt` | **não** | **Session.sessionId** |
| `BroadcastRecipient` | 388-399 | destinatário da campanha e seu status | via Log | — |
| `Flow` | 421-438 | fluxo: `draftGraph`, `draftRevision` (concorrência otimista), `publishedGraph`, `status` DRAFT/ACTIVE/PAUSED | sim | Session.id |
| `FlowTrigger` | 440-451 | gatilho: KEYWORD/FIRST_MESSAGE/ANY_MESSAGE, `keyword`, `matchType`, `priority` | via Flow | — |
| `FlowRun` | 453-476 | execução por contato: `graph` (cópia congelada), `status`, `currentNodeId`, `wait` Json, `resumeAt`, `stepCount`, `lastKeyId`, `isTest` | via Flow | Session.id (sem FK) |
| `FlowRunLog` | 478-489 | trilha de eventos da execução (ENTER/SEND/WAIT/INPUT/INVALID/BRANCH/ACTION/ERROR/END/START) | via Run | — |
| `FlowNodeStat` | 491-498 | contadores por bloco (`sent`, `option:<id>`, `seq`) | **não** | — |
| `FieldDefinition` | 500-511 | campos personalizados: escopo CONTACT ou BOT, tipo TEXT/NUMBER/DATE/DATETIME | **não** | Session.id |
| `BotVariable` | 513-520 | valor de campo de escopo BOT (variável global da conta) | **não** | Session.id |
| `FlowAsset` | 522-532 | arquivo enviado (usado por fluxos, transmissões e respostas rápidas); `path` absoluto no disco | **não** | Session.id |
| `ContactFlowData` | 535-544 | dados do contato para fluxos: `fields` Json, `pausedUntil` (automação pausada), `autoReplyOffUntil` | **não** | Session.id |
| `ChatState` | 547-554 | contador de não lidas por conversa | **não** | Session.id |
| `QuickReply` / `QuickReplyCategory` | 557-582 | resposta rápida ("raio"): título + lista de ações Json | **não** | Session.id |
| `GroupCategory` / `GroupCategoryLink` | 585-611 | organização interna de grupos (não muda nada no WhatsApp) | **não** | Session.id |
| `BroadcastDraft` | 614-629 | rascunho de campanha | **não** | **Session.sessionId** |
| `BroadcastOptOut` | 632-638 | quem pediu para sair das transmissões | **não** | **Session.sessionId** |
| `ArchiveJob` | 642-658 | exportação de conversas: fase scan/backfill/media/done, `cursor`, `chatJids` | **não** | Session.id |
| `ArchiveChat` | 660-678 | conversa dentro da exportação, pasta no disco, `backfillDone` | sim | Session.id |
| `ArchiveMessage` | 680-704 | mensagem arquivada, `raw` (WAMessage em JSON, só para mídia), `mediaState` | via Chat | Session.id |

Enums: `Role`, `MessageType` (TEXT, IMAGE, VIDEO, AUDIO, DOCUMENT, STICKER, LOCATION, CONTACT — sem POLL/REACTION; voto de enquete é salvo como TEXT vazio, comentário em `store/index.ts:80`), `MessageStatus`, `AccessMode` (ALL/OWNER/SPECIFIC/BLACKLIST), `FlowStatus`, `FlowRunStatus` (RUNNING, WAITING_INPUT, WAITING_DELAY, COMPLETED, FAILED, CANCELLED, EXPIRED).

### 2.2 Relações (resumo)

```
User 1─N Session 1─N Contact 1─N Message (contactId nunca é gravado)
                 1─N Message, Group, AutoReply, Story, ScheduledMessage, Webhook, Flow, ArchiveChat, SessionAccess
                 1─1 BotConfig
User 1─N Webhook 1─N WebhookLog
Flow 1─N FlowTrigger, FlowRun 1─N FlowRunLog
Label 1─N ChatLabel ; QuickReplyCategory 1─N QuickReply ; GroupCategory 1─N GroupCategoryLink
BroadcastLog 1─N BroadcastRecipient ; ArchiveChat 1─N ArchiveMessage
```

Mais de 15 modelos guardam o id da sessão como texto solto, sem relação. O banco não garante integridade nesses casos e nada limpa essas linhas ao apagar a sessão.

### 2.3 Índices que faltam (pelas consultas reais)

| Consulta | Onde | Índice sugerido |
|---|---|---|
| `Contact` por `lid` ou `remoteJidAlt` (`OR`) a cada mensagem LID | `src/lib/jid-utils.ts:53-62`, `chat.service.ts:139-145` | `(sessionId, lid)`, `(sessionId, remoteJidAlt)` |
| `ScheduledMessage` `status=PENDING AND sendAt<=agora`, 2 vezes por minuto e mais 1 por minuto | `lib/cron.ts:13-23`, `whatsapp/scheduler.ts:10-15` | `(status, sendAt)` |
| `BroadcastLog` `status=scheduled AND scheduledAt<=agora` a cada 15 s | `broadcast/runner.ts:161` | `(status, scheduledAt)` |
| `BroadcastRecipient` `status=pending` por campanha, várias vezes por destinatário | `broadcast/runner.ts:22,80,116` | `(broadcastLogId, status, id)` |
| `FlowRun` `status=RUNNING AND updatedAt<…` a cada 15 s | `flows/engine.ts:619` | `(status, updatedAt)` |
| `Message` busca por texto (`contains`) | `api/messages/[sessionId]/search/route.ts:61` | FULLTEXT em `content` (ou mecanismo de busca à parte) |
| `ChatLabel` filtrado por `label.sessionId` + `chatJid` | `flows/engine.ts:361` | coluna `sessionId` em `ChatLabel` + índice `(sessionId, chatJid)` |
| `Webhook` `isActive` + (`sessionId` ou `userId IN`) a cada evento | `lib/webhook.ts:69-77` | `(sessionId, isActive)`, `(userId, isActive)` (ou cache em memória) |
| Lista de conversas: "última mensagem por `remoteJid`" | `chat.service.ts:39-60` | não resolve só com índice; precisa de tabela `Chat` desnormalizada com `lastMessageAt` |

Observação: o MySQL/InnoDB cria índice automático para colunas com chave estrangeira; por isso não listei `sessionId` das tabelas que têm relação.

---

## 3. Motor de fluxos

Arquivos: `src/modules/flows/types.ts` (283 linhas, compartilhado com o editor), `logic.ts` (183, funções puras), `engine.ts` (685, E/S). Editor: `src/components/flows/*` com `@xyflow/react`.

Nota: `src/modules/whatsapp/bot/command-handler.ts` **não** é o bot de fluxos. É um bot de comandos com prefixo (`#ping`, `#id`, `#uptime`, `#sticker`/`#s`/`#stiker`, `#menu`/`#help`). Está descrito em 3.10.

### 3.1 Formato JSON do grafo

```ts
FlowGraph = { nodes: FlowNode[]; edges: FlowEdge[] }                       // types.ts:106
FlowNode  = { id, type: NodeType, position: {x,y}, data: NodeDataMap[type] & { name?: string } }  // :98-103
FlowEdge  = { id, source, sourceHandle, target }                           // :105 (sem targetHandle)
```

Grafo vazio = um nó `start` com id `"start"` (`types.ts:143-145`). Ids novos: `Math.random().toString(36).slice(2,10)` (`:141`). O rascunho é salvo inteiro (até 2 MB) a cada alteração, com debounce de 800 ms no editor (`components/flows/flow-editor.tsx:143`) e concorrência otimista por `draftRevision` (`api/flows/[sessionId]/[flowId]/draft/route.ts:21-29`, devolve 409 se outra aba salvou antes).

### 3.2 Tipos de bloco, campos e saídas

| Tipo | Campos (`data`) | Saídas (`sourceHandle`) — `outputsOf`, `types.ts:162-189` |
|---|---|---|
| `start` | `{}` | `next` |
| `content` | `items: ContentItem[]` | para cada item `input`: `input:<itemId>:valid`, `input:<itemId>:timeout`; depois `next` |
| `menu` | `mode: "number"\|"poll"`, `question`, `invalidText`, `maxErrors` (0 = sem saída de erro), `options: {id,text}[]`, `expireValue`, `expireUnit` | `option:<id>` por opção, `error` (se `maxErrors>0`), `timeout` |
| `action` | `actions: FlowAction[]` | `next` |
| `condition` | `logic: "and"\|"or"`, `conditions: FlowCondition[]` | `true`, `false` |
| `randomizer` | `mode: "random"\|"sequential"`, `options: {id, weight}[]` | `option:<id>` |
| `smartDelay` | `mode: "duration"\|"datetime"`, `value`, `unit: minutes\|hours\|days`, `datetime?` (`YYYY-MM-DDTHH:mm`) | `next` |
| `flowLink` | `flowId?` | nenhuma (encerra e inicia outro fluxo) |

`ContentItem` (`types.ts:23-34`):
- `text {text}` — aceita `{campo}`.
- `image|video|audio|file {assetId? | url?, caption?, fileName?}`.
- `delay {seconds, typing}` — pausa **dentro** da execução, máximo 60 s (`engine.ts:20,203`), opcionalmente com "digitando…".
- `autoOff {seconds}` — silencia só a resposta automática do contato por N segundos (`engine.ts:210-212`).
- `vcard {name, phone, org?}`.
- `input {question, answerType, fieldKey, fieldScope, expireValue, expireUnit, errorMessage, maxAttempts}` — pergunta e espera resposta. `answerType`: text, number, date, datetime, firstName, lastName, fullName, email, cpf, image, video, audio, file (`types.ts:17-19`). Validação em `logic.ts:71-91` (data no formato brasileiro `dd/mm/aaaa`, CPF com dígitos verificadores, e-mail por regex, mídia pelo tipo da mensagem).

`FlowAction` (`types.ts:52-59`, execução em `engine.ts:231-276`):
- `addTag`/`removeTag {labelId}` — `ChatLabel` local.
- `setField {fieldKey, fieldScope, value}` (aceita `{campo}`), `clearField`.
- `notify {phones, message}` — manda mensagem para números da equipe (pode vir de campo BOT).
- `pauseAutomation {forever, value, unit}` — grava `ContactFlowData.pausedUntil` (para sempre = 9999-12-31).
- `resumeAutomation`.
- `optOut` — grava em `BroadcastOptOut` (lista usada pela transmissão).

`FlowCondition` (`types.ts:68-76`, avaliação em `logic.ts:106-152`): `source` = `tag` (is/isNot), `weekday` (0-6), `time` (`before` ou "a partir de" HH:MM no fuso do sistema), `field` (texto: is, isNot, contains, notContains, startsWith, containsAny com lista separada por vírgula e prefixo `*`; número: gt, gte, lt, lte, eq, neq; data: after, before, on; qualquer: hasValue). Valores aceitam `{campo}` (`engine.ts:363`).

Validação para publicar/testar/simular: `validateGraph` (`types.ts:194-283`). Erros bloqueiam; avisos (bloco solto) não. Inclui limites da enquete: 12 opções, 255 caracteres, opções sem repetição (`:222-227`), soma 100% no randomizador (`:252`), atraso máximo de 30 dias (`:260`).

Variáveis disponíveis nos textos (`engine.ts:126-146`): campos BOT (`BotVariable`), campos do contato (`ContactFlowData.fields`), e de sistema: `nome-completo`, `primeiro-nome`, `sobrenome`, `telefone`, `ddd` (só se começar com 55), `ultima-mensagem`, `agora` (`types.ts:129-137`). Sintaxe `{chave}` (`logic.ts:25-27`); chave desconhecida vira texto vazio.

### 3.3 Gatilhos, publicação e versões

- Gatilhos ficam em `FlowTrigger`, editados por `PATCH /api/flows/[sessionId]/[flowId]` com `triggers[]` (apaga e recria em transação; `[flowId]/route.ts:37-52`). Tipos de comparação aceitos: EXACT, WORD, CONTAINS, REGEX (`:7`). Regex é testada só para ver se compila.
- Publicar copia `draftGraph` para `publishedGraph`, grava `publishedAt` e já ativa (`publish/route.ts:13-19`).
- Cada `FlowRun` guarda uma cópia do grafo (`schema.prisma:459`): editar não muda conversas em andamento.
- **Os gatilhos não são versionados**: valem na hora, mesmo antes de publicar.

### 3.4 Como uma mensagem recebida dispara ou avança um fluxo

Caminho: `messages.upsert` → `processAndSaveMessage` (`store/index.ts:70`) → só se a mensagem for nova e `type === "notify"` → `onIncomingMessage(sessionId, dbSessionId, linhaSalva)` (`store/index.ts:81-82`) ou `onPollVote` se for voto de enquete.

`onIncomingMessage` (`engine.ts:522-551`):
1. Ignora `fromMe`, grupos, `status@broadcast`, newsletter (`:524`).
2. Coloca na fila do contato (`enqueue("${dbSessionId}:${jid}")`, `:525`): promessas encadeadas em memória por contato (`:61-67`). Garante ordem dentro de um contato, sem paralelismo indevido.
3. Procura execução ativa (RUNNING/WAITING_INPUT/WAITING_DELAY) mais recente (`:526`).
   - Existe e está em `WAITING_INPUT` → `handleInput` (`:529`).
   - Existe em outro estado → **descarta a mensagem** (`:528`). Mensagem durante um atraso inteligente não faz nada.
4. Sem execução: se `pausedUntil` no futuro, para (`:533`).
5. Lê todos os fluxos ACTIVE publicados com gatilhos (`:535`) e escolhe, por prioridade: KEYWORD que bate (`:539-540`); senão FIRST_MESSAGE se o contato tiver `count(Message) <= 1` (`:541-544`); senão ANY_MESSAGE (`:545`).
6. `startRun` (`:549`).

Problema de lógica: FIRST_MESSAGE conta mensagens no banco. Com `syncFullHistory: true`, quem já tinha conversa antes do pareamento nunca é "primeira mensagem" (consequência direta do código; o efeito exato depende do histórico que o celular envia).

### 3.5 Estado da conversa e esperas

- `FlowRun.status` + `currentNodeId` + `wait` + `resumeAt` (`schema.prisma:453-476`).
- `wait` (`engine.ts:23-26`):
  - `{kind:"input", nodeId, itemIndex, attempts}` — esperando resposta a um item `input`.
  - `{kind:"menu", nodeId, errors, poll?}` — esperando escolha; `poll = {id, secret, creators[], values[]}` para descriptografar votos (`:29`).
  - `{kind:"delay", nodeId}` — atraso inteligente.
- `resumeAt`: prazo da espera (expiração da pergunta/menu, ou hora de retomar o atraso).
- `lastKeyId` evita processar a mesma mensagem duas vezes (`:528`).
- Limites: 150 passos por avanço, 5.000 por execução, 20 visitas ao mesmo bloco por avanço (`:17-19`).

### 3.6 Atrasos

- **Atraso curto** (`content.delay`): `sleep` dentro da fila do contato, até 60 s, com presença "composing" opcional (`engine.ts:201-209`). Ocupa a fila daquele contato durante a espera e se perde se o processo reiniciar.
- **Atraso inteligente** (`smartDelay`): grava `WAITING_DELAY` + `resumeAt` e sai (`:386-399`). Data já passada pula direto (`:391-395`). `datetime` é interpretado no fuso do sistema com `moment-timezone` (`:389`).
- **Agendador** `tick()` a cada 15 s (`:617-647`):
  1. Marca como FAILED execuções RUNNING sem atualização há 10 min (`:619`).
  2. Busca até 50 esperas vencidas, ordenadas por `resumeAt` (`:620`).
  3. Para cada uma, se a sessão não estiver conectada, pula (`:625`) — **a linha continua vencida e volta no próximo tick**. Com 50 esperas de uma sessão desconectada no topo, as outras sessões nunca avançam (bloqueio de cabeça de fila).
  4. Reivindicação atômica com `updateMany(where: id+status+resumeAt) → resumeAt=null` (`:628`), depois retoma: atraso → `next`; menu → saída `timeout`; input → `input:<id>:timeout` (`:635-638`). Sem saída ligada, a execução termina como EXPIRED (`:516`).

### 3.7 Menu numerado e menu como enquete

- Modo `number`: manda texto `pergunta\n\n1. opção…` (`logic.ts:37-39`). Resposta aceita "2", "2.", "2)" ou o texto da opção sem acento/maiúscula (`logic.ts:30-35`).
- Modo `poll`: `sendPoll` (`engine.ts:219-228`) gera um segredo de 32 bytes e manda `poll: {name, values, selectableCount: 1, messageSecret}`. Guarda `{id da mensagem, segredo, criadores possíveis (jid e lid da conta), valores}` no `wait`.
- Voto: `onPollVote` (`engine.ts:569-588`) acha a execução em WAITING_INPUT cujo `wait.poll.id` é o da enquete votada, tenta `decryptPollVote` com cada par (criador, votante) até um funcionar (`readPollVote`, `:554-566`), compara o hash SHA-256 de cada opção e chama `handleInput` com o número da opção.
- Erros: `invalidText` é reenviado; ao atingir `maxErrors`, segue a saída `error` (`:504-511`).

### 3.8 Etiquetas, pausa do robô e atendimento humano

- Etiquetas (`Label`/`ChatLabel`) são só do MarcFlow; nada é enviado às etiquetas do WhatsApp Business (busca por `addChatLabel`/`labels.association` não encontrou nada). `Label.sessionId` usa a **string** da sessão (`api/labels/[sessionId]/route.ts:28`; `engine.ts:234`), diferente da maioria das tabelas.
- Pausa: só existe pela ação `pauseAutomation` do próprio fluxo (`engine.ts:263-267`). Efeito: novos gatilhos não disparam (`:533`) e a resposta automática fica calada (`shouldSuppressAutoReply`, `:591-604`).
- **Não existe pausa automática quando o atendente responde pelo celular ou pelo painel.** `onIncomingMessage` ignora `fromMe` (`:524`). O padrão esperado é o fluxo marcar um campo (ex.: `atendimento_humano_ativo`) e pausar.
- Pausa não interrompe uma execução que já está esperando resposta: a verificação de execução ativa vem antes da verificação de pausa (`:526-533`).
- O painel mostra a faixa "robô pausado" e permite reativar: `GET/DELETE /api/flows/[sessionId]/contact-automation?jid=` (`contact-automation/route.ts`). O DELETE limpa `pausedUntil` e, se existir, troca o campo `atendimento_humano_ativo` para `"nao"` (`:35`) — nome de campo fixo no código.
- `shouldSuppressAutoReply` também cala a resposta automática se houver execução ativa ou se a mensagem casar com qualquer gatilho de fluxo ativo (`:600-603`).

### 3.9 Simulador e teste

- **Simular** (`POST /api/flows/[sessionId]/[flowId]/simulate`, `simulate/route.ts`): usa o **rascunho**. Contato fictício `sim-<userId>@sim` (`:15`). `isSimJid` faz os envios virarem só log (`engine.ts:55,159-163`), atrasos curtos são pulados (`:202`), a enquete simulada usa criador `simulador@sim` (`:30,223`). A resposta da rota lê os logs SEND/ERROR criados desde o início da chamada e devolve como "mensagens do bot" (`simulate/route.ts:29-42`). `{reset: true}` apaga execuções, campos, etiquetas e opt-out do contato fictício (`engine.ts:677-685`).
- **Testar** (`POST .../test`, `test/route.ts`): manda o **rascunho** de verdade para um número (10 a 15 dígitos), cancelando execuções ativas desse contato (`engine.ts:447-452`). Execuções de teste não contam estatística (`:88`).
- `applyExternalEvent` (`engine.ts:459-468`) existe para gravar campos e iniciar um fluxo num bloco a partir de um evento externo (o comentário cita webhook de compra), mas **não é chamado em lugar nenhum**.

### 3.10 Bot de comandos (`src/modules/whatsapp/bot/command-handler.ts`)

- Chamado para toda mensagem nova (`store/index.ts:78`), sem `await`.
- Lê `Session` e `BotConfig` a cada mensagem (`:71-82`), checa prefixo (padrão `#`) e permissão (`botMode` OWNER/ALL/SPECIFIC/BLACKLIST; comparação por `includes` de substring, `:115,130`).
- Comandos: `ping`, `id`, `uptime`, `sticker|s|stiker` (imagem com `sharp` 512 px, vídeo com `ffmpeg` via `exec` em arquivo temporário, remoção de fundo via API remove.bg com chave salva no `BotConfig`), `menu|help` (`:142-351`).
- Textos em inglês; o `stiker` é grafia indonésia (**hipótese** de origem).

### 3.11 Pseudocódigo do executor

```
on mensagem nova (não fromMe, não grupo):
  fila[sessão:contato].encadear:
    run = FlowRun ativo mais recente do contato
    if run:
       if run.lastKeyId == msg.keyId or run.status != WAITING_INPUT: return
       return handleInput(run, msg)
    if ContactFlowData.pausedUntil > agora: return
    flows = fluxos ACTIVE publicados + gatilhos
    hit = maior prioridade entre KEYWORD que casa
       ou FIRST_MESSAGE (se count(Message do contato) <= 1)
       ou ANY_MESSAGE
    if hit: startRun(hit.flow, grafo publicado)

startRun(flow, grafo, início = nó start ou bloco indicado):
  run = FlowRun.create(graph = cópia do grafo, status RUNNING)
  log START
  execute(run, início)

execute(run, nodeId, itemIndex = 0):
  vars = campos BOT + campos do contato + campos de sistema
  while nodeId:
    contar passo; falhar se passar de 150/advance, 5000/run, 20 visitas ao mesmo bloco
    node = grafo[nodeId]; salvar(RUNNING, currentNodeId); se itemIndex==0: log ENTER, stat "sent"++
    switch node.type:
      start:      nodeId = aresta(node, "next")
      content:    for item a partir de itemIndex:
                    enviar item (texto/mídia/vcard/pergunta; delay = dormir ≤60 s; autoOff = gravar)
                    if item é input: salvar(WAITING_INPUT, wait=input, resumeAt=agora+expira); return
                  nodeId = aresta(node, "next")
      menu:       enviar texto numerado ou enquete; salvar(WAITING_INPUT, wait=menu); return
      action:     para cada ação: executar (erro vira log, não para o fluxo); nodeId = aresta("next")
      condition:  etiquetas do contato + dia/hora no fuso + vars → true/false; nodeId = aresta(resultado)
      randomizer: sequencial = contador global do bloco (FlowNodeStat "seq"); aleatório = peso
      smartDelay: alvo = agora+duração ou data/hora; se já passou: seguir "next"
                  senão salvar(WAITING_DELAY, resumeAt=alvo); return
      flowLink:   terminar COMPLETED; se fluxo destino ACTIVE: startRun(destino); return
    itemIndex = 0
  terminar COMPLETED
  (exceção → FAILED com mensagem)

handleInput(run, msg):
  wait = run.wait
  if wait.input:
     valor = validar(tipo, msg)
     if inválido: tentativas++; se ≥ máximo: seguir "input:<id>:timeout" (ou EXPIRED)
                  senão reenviar mensagem de erro e salvar tentativas
     else: gravar campo; seguir "input:<id>:valid" ou continuar o mesmo bloco no item seguinte
  if wait.menu:
     opção = casar(msg, opções)
     if opção: stat "option:<id>"++; seguir "option:<id>"
     else erros++; se maxErrors>0 e erros ≥ maxErrors: seguir "error"
          senão reenviar invalidText e salvar erros

tick a cada 15 s:
  RUNNING parado há >10 min → FAILED
  até 50 esperas vencidas (por resumeAt):
     se sessão offline: pular (fica para o próximo tick)
     reivindicar (updateMany resumeAt=null onde ainda igual)
     delay → seguir "next"; menu → "timeout"; input → "input:<id>:timeout"; sem aresta → EXPIRED
```

Custo por bloco executado: 1 `update` (`save`) + 1 `insert` (log ENTER) + 1 `upsert` (estatística) + os do próprio bloco (`engine.ts:313-317`). A cada `execute`/`handleInput`, mais 3 leituras para montar `vars` (`:126-131`) e 1 para o fuso (`:77-80`).

---

## 4. Demais módulos

### 4.1 Transmissões (broadcast)

Arquivos: `src/modules/broadcast/runner.ts`, `template.ts`, rotas em `src/app/api/messages/[sessionId]/broadcast/*`, tela em `components/broadcast/new-broadcast.tsx`.

- **Criar** (`POST .../broadcast`, `route.ts`): até 10.000 destinatários, mensagem até 4.096 caracteres, anexo opcional (`FlowAsset`), agendamento, intervalo em segundos/minutos ou `delay` legado em ms (`:8-18`). Números viram `<dígitos>@s.whatsapp.net`; aceita também `@lid` e `@g.us` (`:42-43`). Remove quem está em `BroadcastOptOut` se `skipOptedOut` (`:45-49`). Grava `BroadcastLog` + todos os `BroadcastRecipient` num `create` aninhado (`:66-85`). Sem agendamento, chama `runBroadcast(log.id)` sem `await` (`:88`).
- **Executor** `runBroadcast` (`runner.ts:73-126`): laço infinito; a cada volta relê o log, pega o próximo `pending` (`orderBy id`), confere sessão conectada (senão pausa a campanha), confere opt-out, envia, atualiza destinatário e totais, emite progresso, conta pendentes e espera o intervalo. A espera acorda a cada 1 s para ver se a campanha foi pausada (`:60-67`), ou seja, 1 consulta por segundo durante toda a campanha.
- **Envio** `sendOne` (`:34-57`): busca o contato para `{{nome}}`, lê o anexo do disco **a cada destinatário**, e para áudio converte com `ffmpeg` **a cada destinatário** (`:47,52`). Legenda de áudio vai numa segunda mensagem.
- **Intervalo**: fixo, mínimo 2 s, máximo 1 h (`:9-11`). Sem variação aleatória, sem limite diário, sem "digitando…", sem verificar se o número existe no WhatsApp.
- **Controle** pausar/retomar/cancelar (`:129-147`); campanha agendada só pode ser cancelada.
- **Reinício do servidor**: campanhas "running" viram "paused" (`:150-153`); o usuário retoma.
- **Agendadas**: tick de 15 s com reivindicação atômica `updateMany(status scheduled → running)` (`:156-169`).
- **Variáveis**: `{{nome}}`, `{{primeiro_nome}}`, `{{telefone}}` (`template.ts:3-19`). Desconhecidas ficam como foram digitadas.
- **Rascunhos, histórico, público e teste**: `drafts`, `history`, `audience` (lista de contatos com etiquetas e opt-out, carregando **todos** os contatos e paginando em memória, `audience/route.ts:24-47`), `optout` (PUT), `test`, `[logId]/control`.

### 4.2 Agendador de mensagens (cron)

Dois agendadores leem a mesma tabela `ScheduledMessage`:

| | `src/lib/cron.ts` | `src/modules/whatsapp/scheduler.ts` |
|---|---|---|
| Disparo | `node-cron` `* * * * *` (`:8`) | `setInterval` 30 s (`:78`) + 1 vez ao subir (`:75`) |
| Quem chama | construtor do `WhatsAppManager` (`manager.ts:15`) | `server/index.ts:60` |
| Busca sessão | `msg.session.sessionId` (correto) (`:31`) | `waManager.getInstance(msg.sessionId)` com o **cuid** (`:22`) → nunca encontra; só registra aviso |
| Mídia | passa `{url}` ao Baileys (`:45-61`) | baixa com `fetch` (`:31-33`) |
| Recorrência | `cronExpression` com fuso fixo `Asia/Jakarta` (`:68,89`) | não trata |
| Reivindicação | nenhuma | nenhuma |

Efeito real hoje: só o `cron.ts` envia. O `scheduler.ts` é código morto que consulta o banco a cada 30 s. Se um dia o bug do id for "corrigido", as mensagens sairão em dobro.
Criação: `POST /api/scheduler/[sessionId]` converte `sendAt` do fuso do sistema para UTC com `moment.tz` (`api/scheduler/[sessionId]/route.ts:96-99`).

### 4.3 Grupos

- Sincronização ao conectar: `groupFetchAllParticipating` + `upsert` um a um + remove os que saíram (`store/groups.ts:25-62`).
- Atualizações por eventos `groups.update` e `group-participants.update` (`store/index.ts:215-285`); ao sair do grupo apaga grupo e categoria.
- Rotas: criar, sair, membros (adicionar/remover/promover), assunto, descrição, foto, configurações (announce/restrict), mensagens temporárias, convite (ver/gerar, aceitar), `update`, `remove`, categorias internas (`GroupCategory`).
- Ações em lote (vários grupos) são orquestradas **pelo navegador**, com pausa entre itens (`components/groups/group-batch.tsx:20,42`). Fechar a aba interrompe.

### 4.4 Respostas rápidas ("raio")

`src/modules/quick-replies/*`. Uma resposta = título + até 30 ações (`types.ts:18`):
- envio: `text {typing, text, wait}`, `image|video|audio|document|sticker {assetId}`, `contact`, `groupInvite` (gera link do grupo);
- tempo: `wait`, `typing`, `recording` (até 60 s);
- etiquetas: `addLabel`, `removeLabel`, `removeAllLabels`;
- utilidades: `archive`, `unarchive`, `pin`, `unpin`, `markUnread`, `block` (via `chatModify`/`updateBlockStatus`, `run.ts:82-89`).

Variáveis com `#tag`: `#nome`, `#primeiroNome`, `#numero`, `#periodo-dia`, `#saudação`/`#saudacao` e campos do contato (`logic.ts:53-69`). Hashtag desconhecida fica como está.
Execução numa fila por conversa, em segundo plano, com progresso por `quickreply.progress` (`run.ts:126-133`). Uma falha não interrompe as outras ações (`run.ts:114-123`).

Observação: o projeto tem **três sintaxes de variável diferentes** para a mesma coisa: `{primeiro-nome}` nos fluxos, `{{primeiro_nome}}` nas transmissões, `#primeiroNome` nas respostas rápidas. A resposta automática e as mensagens agendadas não têm variáveis.

### 4.5 Exportar conversas (archive)

`src/modules/archive/*` (733 linhas). Três fases que podem ser retomadas porque o estado está no banco (`import.ts:10-16`):
1. **scan**: copia o que já está em `Message` (lotes de 500, cursor por id) para `ArchiveMessage`.
2. **backfill**: pede ao celular mensagens mais antigas com `fetchMessageHistory(50, …)`, 5 conversas em paralelo, 12 s de espera por resposta e 3 s entre pedidos (`import.ts:18-22,223-268`). Para após 2 respostas vazias seguidas.
3. **media**: baixa áudios (e fotos/vídeos/documentos se marcado) do `raw` guardado, 25 por vez (`:270-302`).
Exportação: ZIP em streaming com `archiver`, uma pasta por conversa com `conversa.txt`, `audios/` e `midias/`; dividido em partes por `ARCHIVE_MAX_PACKAGE_BYTES` (`export.ts`). Uma exportação por sessão por vez (`import.ts:343-345`). Enquanto há exportação com mídia desligada, a sincronização de histórico do store deixa de baixar mídia pesada (`store/index.ts:491-495`).

### 4.6 Webhooks

`src/lib/webhook.ts` (832 linhas).
- Eventos: `message.received`, `message.sent`, `message.status`, `message.edited`, `message.deleted`, `contact.update`, `group.update`, `group.participant`, `test` (`:12-23`).
  - `connection.update` está no tipo e na tela, mas `onConnectionUpdate` (`:696-701`) nunca é chamado.
  - `status.update` aparece na tela (`dashboard/webhooks/page.tsx:69`) e nunca é emitido.
- Seleção: para cada evento, 4 consultas — sessão, acessos compartilhados, **todos os SUPERADMIN**, webhooks ativos (`:42-77`). Sem cache.
- Envio: `fetch` POST, `AbortSignal.timeout(10000)`, assinatura `X-Webhook-Signature: sha256=<hmac>` se houver segredo (`:136-203`). **Sem nova tentativa** e sem fila; falha só vira log.
- Log: um `WebhookLog` por tentativa com cabeçalhos e corpo completos; depois de cada gravação, apaga logs com mais de 30 dias e carrega **todos** os ids do webhook para manter só 500 (`:240-261`).
- Carga útil de mensagem: `from`, `receiver`, `sender` (em grupo, o objeto do participante), `isGroup`, `chatType`, `type`, `content`, `fileUrl`, `caption`, `quoted` (`:560-584`). Normaliza LID para número quando possível (`resolveToPhoneJidBySessionId`).
- `message.sent` é disparado à mão pelo `ChatService` e por algumas rotas (`fireSentWebhook`, `:642-677`); envios feitos por fluxo, transmissão, resposta automática e resposta rápida **não** geram `message.sent` (**hipótese** baseada no fato de que o store só dispara webhook para `type === "notify"`, `store/index.ts:76,581`).
- `onMessageSent` sempre manda `fromMe: true` por causa de `fromMe || true` (`:617`).

### 4.7 API REST

122 arquivos `route.ts` em `src/app/api` (7.644 linhas). Resposta padrão `{status, message, data}` ou `{status:false, message, error}`.

**Autenticação**: cabeçalho `X-API-Key` (chave por usuário, prefixo `wag_`, 32 caracteres de `Math.random`, guardada em texto puro; `api-auth.ts:251-258`) **ou** cookie de sessão do NextAuth. Toda rota com `[sessionId]` chama `canAccessSession`. Gerenciar a chave: `GET/POST/DELETE /api/user/api-key`.

Lista agrupada (métodos entre parênteses):

- **Auth**: `/auth/[...nextauth]`, `/auth/register` (POST, público).
- **Sessões**: `/sessions` (GET, POST), `/sessions/{id}` (GET), `/sessions/{id}/{start|stop|restart|logout|pair}` (POST), `/sessions/{id}/qr` (GET), `/sessions/{id}/settings` (GET, PATCH, DELETE), `/sessions/{id}/bot-config` (GET, POST), `/sessions/{id}/access` (GET, POST, DELETE).
- **Conversas**: `/chat/{id}` (GET lista), `/chat/{id}/{jid}` (GET mensagens), `/chat/{id}/{jid}/archive|mute|pin|read` (PUT), `/presence`, `/profile-picture` (POST), `/avatar` (GET), `/chat/{id}/check` (POST, existe no WhatsApp), `/chats/{id}/by-label/{labelId}` (GET).
- **Mensagens**: `/messages/{id}/{jid}/send|media|reply|poll|location|contact|list|sticker|spam` (POST), `/messages/{id}/{jid}/{msgId}` (PATCH editar, DELETE), `/react`, `/reply`, `/star` (POST), `/messages/{id}/forward` (POST), `/messages/{id}/search` (GET), `/messages/{id}/download/{msgId}/media` (GET). Obs.: `list` manda **texto numerado**, não lista nativa (`list/route.ts:41-53`).
- **Transmissão**: `/messages/{id}/broadcast` (POST), `/broadcast/{logId}/control`, `/broadcast/audience`, `/broadcast/drafts` (+`/{draftId}`), `/broadcast/history` (+`/{logId}`), `/broadcast/optout`, `/broadcast/test`.
- **Exportar conversas**: `/messages/{id}/archive` (GET), `/archive/chats`, `/archive/jobs` (POST), `/archive/jobs/{jobId}/control|download|missing|plan`.
- **Contatos**: `/contacts/{id}` (GET), `/contacts/{id}/{jid}/block|unblock` (POST).
- **Grupos**: `/groups/{id}` (GET), `/groups/{id}/create`, `/invite/accept`, `/categories` (+`/{catId}`, `/assign`), `/groups/{id}/{jid}` (GET) + `category|description|ephemeral|invite|leave|members|picture|remove|settings|subject|update`.
- **Etiquetas**: `/labels/{id}` (GET, POST), `/labels/{id}/{labelId}` (PUT, DELETE), `/labels/{id}/chats` (GET), `/labels/{id}/chat/{jid}/labels` (GET, PUT).
- **Fluxos**: `/flows/{id}` (GET, POST), `/flows/{id}/{flowId}` (GET, PATCH, DELETE), `/draft` (PUT), `/publish`, `/duplicate`, `/simulate`, `/test` (POST), `/runs` (GET), `/flows/{id}/runs/{runId}` (GET, DELETE), `/assets` (POST) + `/assets/{assetId}` (GET), `/fields` (POST, DELETE), `/bot-vars` (GET, PUT), `/meta` (GET), `/contact-automation` (GET, DELETE).
- **Respostas**: `/autoreplies/{id}` (GET, POST) + `/{replyId}` (PUT, DELETE); `/quick-replies/{id}` (GET, POST) + `/{qrId}` (PATCH, DELETE), `/categories`, `/meta`, `/send`.
- **Agendador**: `/scheduler/{id}` (GET, POST) + `/{scheduleId}` (PUT, DELETE).
- **Perfil da conta WhatsApp**: `/profile/{id}` (GET), `/name`, `/status` (PUT), `/picture` (PUT, DELETE).
- **Webhooks**: `/webhooks/{id}` (GET, POST), `/{webhookId}` (PUT, DELETE), `/test` (POST), `/logs` (GET).
- **Mídia**: `/media` (GET, DELETE), `/media/{filename}` (GET).
- **Sistema/usuários**: `/users` (GET, POST, só SUPERADMIN), `/users/{userId}` (PATCH, DELETE), `/settings/system` (GET; POST só SUPERADMIN), `/system/monitor` (+`/{id}`), `/system/check-updates`, `/notifications` (+`/read`, `/delete`), `/docs` (GET, especificação OpenAPI).

Além das rotas, a tela de chat usa **server actions** (`src/app/dashboard/chat/actions.ts`, `autoreply/actions.ts`), todas com `getAuthenticatedUserForAction` + `canAccessSession`.

Documentação da API: `src/lib/swagger.ts` (4.425 linhas escritas à mão, `next-swagger-doc` lendo `src/app/api` em tempo de execução), `swagger.json` estático (81 caminhos, `securitySchemes` ApiKeyAuth no cabeçalho e cookie), `docs/API_DOCUMENTATION.md` (7.230 linhas). Três fontes que podem divergir; a amostra já diverge do código (81 caminhos contra 122 rotas; "atraso aleatório de 10-20 s" contra intervalo fixo).

### 4.8 Autenticação do painel (NextAuth v5 beta)

- `src/lib/auth.ts`: provedor Credentials, `zod` (e-mail, senha mínima de 6), `bcrypt.compare` (`:11-34`).
- `src/auth.config.ts`: sessão JWT (`:36-38`), `id` e `role` no token (`:20-33`), `trustHost: true` (`:39`).
- Sem limite de tentativas de login, sem 2FA, sem bloqueio de conta.
- Cadastro aberto por padrão (2.1/`SystemConfig`). `scripts/setup-admin.js` cria ou promove SUPERADMIN.

### 4.9 Store de mensagens e contatos

`src/modules/whatsapp/store/index.ts` (595 linhas):
- `processAndSaveMessage` (`:288-594`):
  1. Ignora mensagens sem conteúdo.
  2. `protocolMessage` tipo 14 = edição → atualiza `content` (`:319-345`); tipo 0 = apagada → com `config.antiDelete` mantém o texto e acrescenta um aviso, senão troca por "[This message was deleted]" e **marca status FAILED** (`:348-397`).
  3. Ignora `senderKeyDistributionMessage`, `reactionMessage`, `keepInChatMessage` (`:400-411`). Reações não são guardadas.
  4. Deduplicação por `findUnique(sessionId,keyId)` (`:416-431`).
  5. Extrai texto e tipo (`:438-466`), normaliza LID para número com `resolveToPhoneJid` (`:480-486`).
  6. Baixa a mídia **antes** de gravar (`:493-498`) para `data/media/<sessionId>-<keyId>.<ext>` (`webhook.ts:458-467`), servida por `/api/media/<arquivo>` com checagem de acesso.
  7. `message.create`, `contact.upsert` (com `pushName`), e boas-vindas se `count(Message do contato) === 1` (`:567-577`).
  8. Webhook `message.received`/`message.sent` só se `notify` (`:581-587`).
- Contatos: `contacts.upsert` (`store/index.ts:133-176`), `contacts.update` (`contacts.ts:29-62`) e criação a partir das conversas do histórico (`contacts.ts:65-122`), tudo com `upsert` um a um.
- Não lidas: `ChatState` incrementado a cada mensagem recebida, zerado quando a conta responde ou quando o WhatsApp avisa leitura (`chat-state.ts`).
- Avatares: buscados sob demanda, guardados em `data/avatars`, no máximo 2 buscas simultâneas e cache de 24 h (`avatars.ts:7-77`). Bem feito.
- Lista de conversas: SQL bruto com "maior timestamp por remoteJid" sobre toda a tabela `Message` da sessão (`chat.service.ts:39-60`).

### 4.10 Outros

- **Resposta automática** (`store/autoreply.ts`): regras EXACT/CONTAINS/REGEX, filtro grupo/privado, mídia por URL; modo de acesso por `BotConfig.autoReplyMode`; no modo OWNER responde às **próprias** mensagens (atalhos/macros) (`:25`). Para na primeira regra que casa.
- **Anti-spam** (`antispam.ts`): fila por sessão em memória envolvendo todo `sendMessage`. Desligado por padrão. Quando ligado, deixa passar até `spamLimit` mensagens em `spamInterval` segundos e só então espera um valor aleatório entre `spamDelayMin` e `spamDelayMax` (`:104-131`).
- **Voz**: `toOggOpus` converte qualquer áudio para Ogg/Opus mono 48 kHz 32 kbps com `ffmpeg` (`voice.ts:8-27`) e `repackOpusForWhatsApp` reagrupa os quadros Opus para o iPhone tocar (`opus-repack.ts:90`). Trecho bem feito e reaproveitável.
- **Monitor**: `systeminformation` (CPU, memória, disco, rede) só para SUPERADMIN (`api/system/monitor/route.ts:17-29`).
- **Atualizações**: consulta a última versão no GitHub de `UPDATE_REPO` e cria notificação (`api/system/check-updates/route.ts`); qualquer usuário autenticado pode chamar (`:18-20`).

---

## 5. Patches, start.sh, Docker e variáveis de ambiente

### 5.1 `patches/@whiskeysockets+baileys+7.0.0-rc.9.patch` (1.250 linhas)

- 367 dos blocos são só mudança de permissão de arquivo (`old mode 100644 / new mode 100755`), ruído.
- Mudanças reais, todas para **canais (newsletter)**:
  1. `lib/Socket/messages-send.js` (linha 322 do patch): envia `mediatype` no nó `plaintext` de mensagem de canal.
  2. `lib/Utils/messages-media.js` (770-820): upload de mídia para canal usa caminho `/newsletter/newsletter-*`, `server_thumb_gen=1`, `server_transcode=1` para vídeo, e lê `direct_path`, miniatura e `handle` da resposta.
  3. `lib/Utils/messages.js` (825-910): monta a mensagem de mídia de canal sem `mediaKey`, troca `/o1/` por `/m1/`, **deixa `console.log` de depuração** ("=== MarcFlow NEWSLETTER MEDIA PAYLOAD DEBUG ==="); e `downloadMediaMessage` passa a baixar mídia sem criptografia de canal por `fetch` direto.
- Riscos: o `package.json` pede `^7.0.0-rc.9`; se o npm resolver outra versão rc, o `patch-package` não aplica (aviso ou falha, dependendo da configuração). **Hipótese** a conferir: o `.dockerignore` tem `*.patch` (`.dockerignore:22`); pelas regras do Docker esse padrão provavelmente só casa na raiz do contexto e não exclui `patches/…`, mas vale testar o build.
- O mesmo download de canal está duplicado no app (`lib/webhook.ts:393-418`).

### 5.2 `start.sh`

Script de implantação com PM2 (`start.sh`):
1. Exige `.env` (`:20-24`) e lê alguns valores com `grep|cut` para avisar se são padrão (`:28-49`).
2. Verifica se a porta está livre (`/dev/tcp`, `ss`, `netstat`) (`:51-80`).
3. `npm install` (`:84`), `npx prisma db push` (`:93`) — **sem migrações**.
4. Cria SUPERADMIN pelo `.env` ou perguntando no terminal (`:101-139`).
5. `npm run build` (`:143`), instala o PM2 globalmente se faltar e faz `start`/`reload` (`:150-171`).
6. Mostra o aviso de segurança no fim (`:194-205`).

### 5.3 Docker

- `Dockerfile`: `node:26-alpine` nos dois estágios (`:1,20`), `npm ci --legacy-peer-deps` (`:9`), build, `npm prune --omit=dev` e reinstala `tsx typescript` (`:17`). Copia `src` inteiro para a imagem final porque o servidor roda via `tsx` (`:27`).
  - **Não instala `ffmpeg`** (`:21` só tem `openssl ca-certificates`): nota de voz, áudio de transmissão e figurinha de vídeo falham no contêiner.
  - `CMD` (`:38`) roda `prisma db push` a cada início e tenta criar o admin com `[ -n "$ADMIN_EMAIL"]` — falta espaço antes do `]`, o teste dá erro de sintaxe e o admin nunca é criado por variável de ambiente.
- `docker-compose.yml`: MySQL 8 com porta `3306` publicada para fora (`:11-12`), app na 3000, volume `app_data:/app/data` (onde ficam mídia, avatares, arquivos de fluxo e exportações) e volume `uploads_data:/app/uploads` que o código não usa (`:52`). Padrões herdados: `TZ=Asia/Jakarta`, `LOCALE=id-ID` (`:43-44`).

### 5.4 Variáveis de ambiente (só nomes e função)

Usadas de fato pelo código:

| Nome | Função |
|---|---|
| `DATABASE_URL` | conexão MySQL do Prisma |
| `AUTH_SECRET` | segredo do NextAuth; obrigatório para subir |
| `PORT`, `HOSTNAME`, `NODE_ENV` | servidor |
| `BAILEYS_LOG_LEVEL` | nível de log do Baileys |
| `FFMPEG_PATH` | caminho do ffmpeg (não documentada no `.env.example`) |
| `TZ` | fuso de reserva se `SystemConfig` não existir |
| `UPDATE_REPO` | `dono/repo` para checar atualizações (não documentada) |
| `ARCHIVE_MAX_PACKAGE_BYTES`, `ARCHIVE_WAIT_MS`, `ARCHIVE_PACE_MS` | ajustes da exportação (não documentadas) |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL` | URLs públicas (SEO, Swagger) |
| `NEXT_PUBLIC_CHAT_PAGE_SIZE` | tamanho da página da lista de conversas |
| `NEXT_PUBLIC_ALLOW_INDEXING` | robots/sitemap |
| `NEXT_PUBLIC_SWAGGER_USERNAME`, `NEXT_PUBLIC_SWAGGER_PASSWORD` | "login" da página Swagger, **verificado no navegador** (ver 6.3) |
| `NEXTAUTH_URL`, `AUTH_TRUST_HOST` | lidas internamente pelo NextAuth |
| `MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Docker/start.sh |

Documentadas no `.env.example` mas **sem nenhum uso no código**: `BASE_URL`, `APP_NAME`, `LOGO_URL`, `FAVICON_URL`, `REMOVE_BG_API_KEY` (a chave real fica no `BotConfig`), `ENABLE_NOTIFICATIONS`, `ENABLE_AUTO_UPDATE_CHECK`, `ENABLE_EXPERIMENTAL_FEATURES`, `SESSION_TIMEOUT_HOURS`, `MAX_UPLOAD_SIZE_MB`, `ENABLE_RATE_LIMITING`, `RATE_LIMIT_PER_MINUTE`, `LOCALE`, `MEDIA_STORAGE_PATH`, `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_SWAGGER_ENABLED`.

---

## 6. Problemas encontrados

Severidade: 🔴 alta · 🟠 média · 🟡 baixa.

### 6.1 Gargalos de desempenho

| Sev. | Problema | Onde |
|---|---|---|
| 🔴 | **Um processo só** para Next, Socket.IO, todas as sessões Baileys, fluxos, transmissões, exportação e conversão de mídia. Qualquer bloqueio do event loop (regex, `sharp`, `ffmpeg` síncrono não é o caso, mas JSON grande e SQL lento sim) atinge todos. PM2 em `fork` de 1 instância; não dá para escalar horizontalmente porque filas e travas estão em memória. | `server/index.ts`, `ecosystem.config.js:11`, `engine.ts:58-67`, `runner.ts:13-14`, `antispam.ts:24-27` |
| 🔴 | **20 a 30 consultas por mensagem recebida** (estimativa contando o código): store (busca da sessão em cache, `botConfig`, `findUnique` de deduplicação, `create`, `contact.upsert`, `count` de boas-vindas, `resolveToPhoneJid`), bot de comandos (2), resposta automática (sessão+config, `shouldSuppressAutoReply` com 4, regras), fluxos (execução ativa, `ContactFlowData`, fluxos+gatilhos, talvez `count`), não lidas (1), webhook (4 + 1 por log + limpeza). Tudo sequencial dentro de cada ouvinte. | `store/index.ts:59-83,416-577`, `command-handler.ts:71-82`, `autoreply.ts:63-123`, `engine.ts:526-545,591-603`, `chat-state.ts:9-16`, `webhook.ts:42-77` |
| 🔴 | **Sincronização de histórico completa**, mensagem por mensagem, com download de toda mídia, no primeiro pareamento. Em conta antiga isso são horas de CPU, rede e disco, além de inflar `Message`. | `instance.ts:71`, `store/index.ts:114-122,493-495` |
| 🔴 | Regras da resposta automática lidas do banco **dentro do laço de mensagens** (uma consulta por mensagem, não por lote). | `autoreply.ts:117-123` |
| 🟠 | `dispatchWebhook` faz 4 consultas por evento sem cache; `message.status` gera um evento por recibo (entregue/lido) de cada mensagem. | `webhook.ts:42-77`, `store/index.ts:179-212` |
| 🟠 | Cada log de webhook carrega todos os ids do webhook para cortar em 500 (O(n) por entrega). | `webhook.ts:249-259` |
| 🟠 | Mídia baixada de novo pelo webhook quando o store não conseguiu (dois downloads da mesma mensagem). | `webhook.ts:548-555,598-603` |
| 🟠 | Transmissão: ~10 consultas por destinatário + 1 consulta por segundo durante a espera; anexo lido do disco e áudio reconvertido no `ffmpeg` para cada destinatário. | `runner.ts:19-28,34-57,60-67,78-117` |
| 🟠 | Motor de fluxos: 3 escritas por bloco (`save`, log, estatística) + 4 leituras por avanço; o `tick` processa em série e pode travar atrás de 50 esperas de uma sessão desconectada. | `engine.ts:313-317,126-131,620-640` |
| 🟠 | Lista de conversas recalcula "última mensagem por conversa" sobre toda a tabela `Message` da sessão a cada página. A busca é feita em memória **depois** do `LIMIT`, então só procura na página atual (bug funcional). | `chat.service.ts:39-60,113-119` |
| 🟠 | Público da transmissão carrega todos os contatos e etiquetas e pagina em memória. | `api/messages/[sessionId]/broadcast/audience/route.ts:24-47` |
| 🟠 | Estado de autenticação: um `upsert` por chave Signal, sem transação nem lote. | `usePrismaAuthState.ts:82-98` |
| 🟠 | Polling no front (3 s métricas, 3 s monitor, 2,5 s exportação) em vez de eventos. | `dashboard/sessions/[sessionId]/page.tsx:126`, `system-monitor/page.tsx:45`, `archive/page.tsx:59` |
| 🟠 | `message.upsert` emite o `WAMessage` bruto para a sala e ninguém escuta. | `store/index.ts:46` |
| 🟡 | Agendadores redundantes consultando o banco: 2 para mensagens agendadas, 1 para transmissões, 1 para fluxos. | `cron.ts:8`, `scheduler.ts:78`, `runner.ts:159`, `engine.ts:645` |
| 🟡 | `loadSessions` inicia sessões em série, cada uma com chamada de rede `fetchLatestBaileysVersion`. | `manager.ts:42-62`, `instance.ts:59` |
| 🟡 | TypeScript compilado em tempo de execução (`tsx`) também em produção. | `package.json` `start`, `Dockerfile:17,38` |
| 🟡 | Sem fila de tarefas: transmissão, teste de fluxo, resposta rápida e exportação são promessas soltas; se o processo cai, só voltam por rotinas de "órfãos" ou manualmente. | `broadcast/route.ts:88`, `test/route.ts:24`, `quick-replies/run.ts:128-133` |

### 6.2 Risco de bloqueio do número

| Sev. | Problema | Onde |
|---|---|---|
| 🔴 | Transmissão com **intervalo fixo**, piso de 2 s, sem variação aleatória, sem teto diário, sem "digitando…", sem aquecimento e sem checar se o número existe. A documentação diz "10-20 s aleatório". | `runner.ts:9-11,117`, `swagger.ts:33` |
| 🔴 | Não existe fila de envio única por número: transmissão, fluxos, resposta automática, boas-vindas, bot de comandos, respostas rápidas e agendador chamam `sendMessage` ao mesmo tempo. O anti-spam que serializaria isso vem **desligado** e, ligado, só atrasa depois de estourar o limite (5 em 10 s). | `instance.ts:75-80`, `schema.prisma:277-281`, `antispam.ts:104-131` |
| 🟠 | Respostas instantâneas sem atraso humano: resposta automática, boas-vindas e comandos respondem na hora, citando a mensagem. Fluxo manda itens de conteúdo em sequência sem pausa se não houver item `delay`. | `autoreply.ts:179-187`, `store/index.ts:567-577`, `engine.ts:326-335` |
| 🟠 | `syncFullHistory: true` + `browser` fixo `Ubuntu/Chrome 20.0.04` (**hipótese** de risco: assinatura de cliente pouco comum). | `instance.ts:69-71` |
| 🟠 | Exportação pede histórico ao celular em 5 conversas paralelas a cada 3 s (`fetchMessageHistory`), volume incomum de pedidos sob demanda (**hipótese** de risco). | `archive/import.ts:18-22,235,261` |
| 🟠 | Leitura automática (`autoRead`) marca tudo como lido na hora, comportamento de robô. | `store/index.ts:66-68` |
| 🟠 | Ação `notify` dos fluxos envia para números arbitrários da equipe a cada passagem; sem limite. | `engine.ts:253-262` |
| 🟡 | Reconexão rápida (3 s fixos) três vezes seguidas, sem backoff. | `instance.ts:179` |
| 🟡 | Grupos em lote disparados pelo navegador, sem controle no servidor. | `group-batch.tsx:20,42` |

### 6.3 Segurança

| Sev. | Problema | Onde |
|---|---|---|
| 🔴 | **Socket.IO sem autenticação**, CORS `*`. Qualquer um entra na sala de qualquer sessão (`join-session`) e recebe mensagens (inclusive o `WAMessage` bruto), QR, presença e progresso; ou na sala `user:<id>` e recebe notificações. | `server/socket.ts:13-21`, `server/index.ts:39-46`, `store/index.ts:46,98` |
| 🔴 | Ids de sessão curtos e previsíveis (4 a 6 caracteres base36 de `Math.random`) ou escolhidos pelo usuário. Junto com o item acima, dá para adivinhar salas. | `manager.ts:76` |
| 🔴 | **Sem limitação de taxa** em login, cadastro, API ou envio (as variáveis do `.env.example` não fazem nada). | busca por `RATE_LIMIT` só acha o `.env.example` |
| 🔴 | **Cadastro aberto por padrão**: qualquer pessoa cria conta OWNER e conecta números na instância. | `schema.prisma:300`, `api/auth/register/route.ts:17-49` |
| 🔴 | **SSRF** (servidor buscando URL arbitrária): URL de webhook sem validação (`api/webhooks/[sessionId]/route.ts:72-97`); `image/video/document/audio/sticker.url` da API buscados com `fetch` (`chat.service.ts:272-332`); mídia de mensagem agendada (`scheduler.ts:31`, `cron.ts:45-61`) e de resposta automática (`autoreply.ts:157-176`) passadas como `{url}`. Permite atingir a rede interna (ex.: o MySQL exposto, metadados de nuvem). | citados |
| 🟠 | **XSS armazenado**: o tipo "file" de arquivo de fluxo aceita qualquer `mime` (`/.*/`) e o arquivo é servido `inline` com o `Content-Type` enviado pelo próprio usuário, sem `nosniff`. Um HTML enviado roda na origem do painel para quem abrir. | `api/flows/[sessionId]/assets/route.ts:13,28`, `assets/[assetId]/route.ts:17-19` |
| 🟠 | Chave de API gerada com `Math.random` e guardada em texto puro. | `api-auth.ts:251-258`, `schema.prisma:44` |
| 🟠 | Swagger "protegido" por usuário/senha comparados **no navegador**, com variáveis `NEXT_PUBLIC_*` que vão para o JavaScript público; padrão `admin`/`admin123`. | `app/swagger/page.tsx:10-11,49-50` |
| 🟠 | ReDoS: regex do usuário (resposta automática e gatilho de fluxo) rodando em toda mensagem no único event loop. | `autoreply.ts:139`, `flows/logic.ts:169` |
| 🟠 | Acesso compartilhado pode apagar a sessão, deslogar e trocar configuração (usa `canAccessSession`, não `isSessionOwner`). | `sessions/[sessionId]/settings/route.ts:95-109`, `[action]/route.ts:21` |
| 🟠 | `GET /webhooks/{sessionId}` devolve os webhooks de todos os usuários da sessão **com o segredo HMAC** e `include: { session: true }` (inclui `qr` e `config`). | `api/webhooks/[sessionId]/route.ts:34-45` |
| 🟠 | Webhooks globais de SUPERADMIN recebem eventos de todas as sessões de todos os clientes. | `webhook.ts:58-74` |
| 🟠 | MySQL publicado na porta 3306 no compose, com usuário root. | `docker-compose.yml:11-12,30` |
| 🟡 | Rota de transmissão consulta a lista de opt-out e responde "todos descadastrados" **antes** de checar acesso à sessão. | `broadcast/route.ts:45-57` |
| 🟡 | `/api/media/{arquivo}`: se o nome não tiver hífen, a checagem de sessão é pulada (só exige login). | `api/media/[filename]/route.ts:15-22,43-49` |
| 🟡 | Qualquer usuário autenticado pode disparar a checagem de atualização (comentário admite). | `api/system/check-updates/route.ts:18-20` |
| 🟡 | SQL: as consultas brutas usam parâmetros (`?`) e as partes interpoladas são fixas; não achei injeção. | `chat.service.ts:39-60`, `chat/actions.ts:138`, `archive/export.ts:77` |
| 🟡 | Senha mínima de 6 caracteres, sem bloqueio por tentativas. | `lib/auth.ts:18`, `register/route.ts:9` |

### 6.4 Bugs e código morto

| Sev. | Problema | Onde |
|---|---|---|
| 🔴 | **Ids de sessão misturados**: `Label`, `BroadcastLog`, `BroadcastDraft`, `BroadcastOptOut` e `AuthState` guardam `Session.sessionId` (texto); o resto guarda `Session.id` (cuid). Já causou bug real: o segundo agendador procura a instância pelo cuid e nunca envia. | `scheduler.ts:22`, `api/labels/[sessionId]/route.ts:28`, `broadcast/route.ts:46,68`, `engine.ts:234,273` |
| 🔴 | **Dois agendadores** na mesma tabela, sem reivindicação. Hoje só um funciona; se o outro for consertado, mensagens saem em dobro. O `cron.ts` também pode reenviar se uma rodada passar de 1 min (**hipótese**: depende de o node-cron sobrepor execuções). | `cron.ts`, `scheduler.ts` |
| 🔴 | Apagar sessão deixa órfãos em ~15 tabelas sem FK (inclusive `AuthState`) e os arquivos em `data/`. | `manager.ts:112-119`, seção 2.1 |
| 🟠 | Apagar sessão pela rota apaga duas vezes: `waManager.deleteSession` (sem `await`) já apaga a linha, e a rota chama `prisma.session.delete` em seguida → erro P2025/500 por corrida. | `sessions/[sessionId]/settings/route.ts:109-114` |
| 🟠 | Reconexão: após 3 quedas seguidas a sessão fica STOPPED para sempre até ação manual (queda de rede de ~10 s derruba a conta). | `instance.ts:21,182-200` |
| 🟠 | Fuso fixo `Asia/Jakarta` na recorrência do cron e como padrão em vários lugares; o motor de fluxos usa `America/Sao_Paulo` como reserva. | `cron.ts:68,89`, `schema.prisma:299`, `api/scheduler/[sessionId]/route.ts:96`, `engine.ts:79` |
| 🟠 | Número começando com `0` vira DDI `62` (Indonésia). | `lib/jid-utils.ts:182` |
| 🟠 | Gatilho FIRST_MESSAGE e boas-vindas contam mensagens no banco; com histórico sincronizado, contatos antigos nunca disparam. | `engine.ts:541-544`, `store/index.ts:569-573` |
| 🟠 | Mensagem recebida durante `WAITING_DELAY` é ignorada por completo. | `engine.ts:528` |
| 🟠 | Busca da lista de conversas só filtra a página carregada. | `chat.service.ts:113-119` |
| 🟠 | Dockerfile: sem `ffmpeg`; teste de shell quebrado no `CMD`; `prisma db push` em todo início. | `Dockerfile:21,38` |
| 🟡 | Mensagem apagada vira `status: FAILED`. | `store/index.ts:382-385` |
| 🟡 | `fromMe || true` no webhook `message.sent`. | `webhook.ts:617` |
| 🟡 | Evento `connection.update` nunca enviado ao webhook; `status.update` oferecido na tela e nunca emitido. | `webhook.ts:696-701`, `dashboard/webhooks/page.tsx:69` |
| 🟡 | Código morto: `bindPpGuard` (só loga, `ppguard.ts`), modelo `Story`, `Message.contactId` (nunca gravado; relação `contract` com erro de digitação, `schema.prisma:116`), `WhatsAppInstance.rq`, `applyExternalEvent`, `src/fix_test.js`, comentário "Placeholder" (`store/index.ts:595`), `middleware.ts` na raiz (**hipótese**). | citados |
| 🟡 | `/messages/.../list` promete lista e manda texto. | `list/route.ts:41-53` |
| 🟡 | `messaging-history.set` tratado por 3 ouvintes separados (mais 1 durante exportação). | `store/index.ts:103`, `contacts.ts:65`, `chat-state.ts:28` |
| 🟡 | Patch do Baileys com `console.log` de depuração em produção. | patch, bloco de `lib/Utils/messages.js` |
| 🟡 | Sem testes automatizados: `scripts/test-*.ts` são scripts avulsos, não há Jest/Vitest. | `scripts/` |

### 6.5 Dependências desnecessárias ou duplicadas

| Grupo | Situação | Sugestão |
|---|---|---|
| `moment` + `moment-timezone` + `date-fns` + `Intl` | `moment-timezone` em `engine.ts`, rotas do agendador, tela do agendador, relógio; `date-fns` só em `inbox/page.tsx` e `navbar.tsx`; `logic.ts:177-183` já resolve fuso com `Intl` "sem dependência extra". | só `Intl` (ou `date-fns-tz`/Temporal) |
| `radix-ui` (pacote único) + 12 `@radix-ui/react-*` | `radix-ui` usado só em `checkbox`, `radio-group`, `tabs`; o resto usa os pacotes separados. | escolher um dos dois |
| `node-cron` + `cron-parser` + `setInterval` | três mecanismos de tempo. | um agendador com fila persistente |
| `qrcode` + `qrcode.react` | um no servidor (`qr/route.ts`), outro no cliente. | só um (gerar no cliente) |
| `swagger-ui-react` + `next-swagger-doc` + `swagger.json` + `lib/swagger.ts` (4.425 linhas) + `docs/API_DOCUMENTATION.md` (7.230) | três fontes da mesma documentação. | gerar OpenAPI dos schemas `zod` |
| Sem uso encontrado em `src/` nem `scripts/` | `recharts`, `react-syntax-highlighter` (+ `@types` em `dependencies`), `ts-morph`, `ts-node`, `postinstall-postinstall`; `tsconfig-paths` citado em `tsconfig.server.json` e não instalado. | remover |
| `jimp`, `audio-decode`, `sharp` | não importados pelo app (`sharp` só no bot de figurinha); **hipótese**: estão aí como dependências opcionais do Baileys (miniaturas e forma de onda de áudio; `next.config.ts:5-7`). | confirmar e manter só o necessário |
| `next-auth@5 beta`, `@whiskeysockets/baileys@7 rc` | versões não estáveis em produção. | fixar versão exata |
| `pino` | só para o logger do Baileys; o app tem logger próprio (`lib/logger.ts`). | unificar |
| `systeminformation` | só para a tela de monitor. | opcional |

---

## 7. Tamanho

Contagem de arquivos `.ts/.tsx/.js/.css/.prisma` e linhas (inclui comentários e linhas vazias).

| Área | Arquivos | Linhas | Observação |
|---|---:|---:|---|
| `src/` total | 278 | 39.643 | |
| `src/app/api` | 123 | 7.644 | 122 `route.ts` + `drafts/shape.ts` |
| `src/app/dashboard` | 30 | 8.821 | 26 telas (`page.tsx`) |
| `src/app` (total, inclui api, auth, docs, swagger, páginas legais) | 170 | 18.702 | |
| `src/components` | 58 | 9.190 | `ui` 25/1.820, `chat` 8/2.262, `dashboard` 14/1.994, `flows` 6/1.742, `groups` 2/772, `broadcast` 1/565 |
| `src/lib` | 14 | 6.101 | **`swagger.ts` sozinho tem 4.425**; `webhook.ts` 832 |
| `src/modules/whatsapp` | 17 | 3.028 | `store/` 6/1.058, `chat.service.ts` 466, `bot/` 355, `instance.ts` 273, `antispam.ts` 251 |
| `src/modules/flows` | 3 | 1.151 | `engine.ts` 685 |
| `src/modules/archive` | 4 | 733 | |
| `src/modules/quick-replies` | 3 | 265 | |
| `src/modules/broadcast` | 2 | 198 | |
| `src/modules/groups` | 1 | 19 | |
| `src/server` | 2 | 95 | |
| `scripts/` | 16 | 1.641 | utilitários e testes avulsos |
| `prisma/schema.prisma` | 1 | 704 | 38 modelos, 6 enums |
| `patches/` | 1 | 1.250 | 3 arquivos realmente alterados |
| `swagger.json` | 1 | 7.412 | 81 caminhos |
| `docs/*.md` | 9 | 8.251 | |

Leitura: o "núcleo" que importa para reescrever (WhatsApp + fluxos + transmissão + exportação + respostas + server) tem ~5,5 mil linhas. O resto é tela, rotas finas e documentação.

---

## 8. Reescrita: o que manter, mudar e cortar (priorizado)

### 8.1 Manter (ideias que funcionam; reaproveitar a lógica)

1. **Modelo de grafo dos fluxos** (`types.ts`): 8 blocos, `sourceHandle` com ids estáveis (`option:<id>`, `input:<id>:valid|timeout`), `validateGraph`, `outputsOf`. Dá para portar quase literal.
2. **Funções puras do motor** (`logic.ts`): validação de respostas (CPF, data BR, e-mail), `matchMenuOption`, `containsAnyPhrase` com prefixo `*`, condições, randomizador ponderado, `zonedParts` com `Intl`.
3. **Cópia do grafo por execução** + rascunho/publicado + concorrência otimista por revisão.
4. **Espera persistida** (`wait` + `resumeAt`) com reivindicação atômica no retorno; fila serial por contato.
5. **Menu como enquete** com segredo próprio e `decryptPollVote` testando os pares criador/votante (`engine.ts:219-228,554-566`).
6. **Simulador** que roda o rascunho sem tocar no WhatsApp e devolve a conversa pelos logs.
7. **Conversão de voz** (`voice.ts` + `opus-repack.ts`) para nota de voz tocar no iPhone.
8. **Escape de maiúsculas nas chaves do auth state** (`authKey`) e a reconversão de `app-state-sync-key` — sem isso o MySQL corrompe o app-state.
9. **Avatares sob demanda** com cache em disco e limite de concorrência.
10. **Transmissão com estado no banco** (pausar/retomar/cancelar, pausa automática se a sessão cair, opt-out compartilhado com fluxos).
11. **Exportação em fases retomáveis** e ZIP em streaming.
12. **Respostas rápidas** como lista de ações tipadas e validadas no servidor (`parseActions`).

### 8.2 Mudar (arquitetura e comportamento)

Prioridade 1 (base):
1. **Separar processos**: API/painel (Next ou outro) ↔ **worker de WhatsApp** (Baileys) ↔ **worker de tarefas**. Comunicação por fila (Redis/BullMQ ou Postgres com `SKIP LOCKED`) e eventos (Redis pub/sub). Permite reiniciar o painel sem derrubar números e escalar workers por grupo de sessões.
2. **Fila única de envio por número**, obrigatória para todos os módulos, com: intervalo aleatório (jitter), "digitando…" proporcional ao texto, teto por minuto/hora/dia, aquecimento de número novo, pausa automática em erro. Transmissão vira só "produtora" nessa fila.
3. **Um id de sessão só** (uuid) em todas as tabelas, com FK e `ON DELETE CASCADE`; limpeza de arquivos ao apagar.
4. **Auth state**: gravar `keys.set` em transação/lote; ou guardar o auth state em Redis/arquivo por sessão com snapshot no banco. Considerar Postgres (colação sensível a maiúsculas resolve o problema do `authKey`).
5. **Agendador único persistente** (tarefas com `runAt`, reivindicação atômica, nova tentativa com backoff) substituindo `node-cron`, os dois agendadores de mensagens, o tick de transmissão e o tick de fluxos.
6. **Socket.IO autenticado** (token do NextAuth no handshake) e checagem de acesso ao entrar em sala; parar de emitir `WAMessage` bruto.

Prioridade 2 (desempenho e dados):
7. **Pipeline de mensagem recebida em um só ouvinte**: salvar em lote, depois publicar um evento interno; resposta automática, bot, fluxos, webhooks e não lidas consomem o evento. Cachear `BotConfig`, regras, gatilhos e webhooks em memória com invalidação.
8. **Tabela `Chat`** desnormalizada (último texto, `lastMessageAt`, não lidas) para a lista de conversas; busca no banco, não em memória.
9. **Histórico**: `syncFullHistory` opcional e desligado por padrão; mídia do histórico só sob demanda.
10. **Webhooks com fila**, novas tentativas com backoff, validação de URL (bloquear IPs privados), segredo nunca devolvido pela API, retenção por tarefa periódica (não a cada envio).
11. **Reconexão** com backoff exponencial e sem limite fixo de 3; só para em `loggedOut`.
12. **Índices** da seção 2.3; migrações versionadas (`prisma migrate`) no lugar de `db push`.

Prioridade 3 (produto):
13. **Pausa automática no atendimento humano**: quando a conta responde (painel ou celular), pausar fluxos e resposta automática daquele contato por X minutos (configurável). Hoje só existe pausa feita pelo próprio fluxo.
14. **Gatilhos versionados junto com o grafo publicado**.
15. **Uma sintaxe de variável** para fluxo, transmissão, resposta rápida, resposta automática e agendador.
16. **Fuso e DDI configuráveis** com padrão Brasil; remover `Asia/Jakarta` e `62`.
17. **Primeira mensagem** decidida por "primeiro contato após a conta conectar" (marcação no `Contact`), não por contagem.
18. Mensagens recebidas durante atraso inteligente: decidir regra (ignorar, interromper ou disparar outro fluxo) e deixar explícita.
19. Implementar `applyExternalEvent` como **webhook de entrada** (ex.: compra aprovada grava campos e inicia fluxo num bloco) — a peça já está pronta no motor.
20. Segurança mínima: rate limit (login, API, envio), cadastro fechado por padrão, chave de API com `crypto.randomBytes` e guardada como hash, papéis com permissão real (STAFF não apaga sessão), validação de upload por conteúdo e `Content-Disposition: attachment` + `nosniff`, sem `NEXT_PUBLIC` para senha.
21. Validação de entrada com `zod` em todas as rotas e OpenAPI gerado desses schemas.
22. Docker com `ffmpeg`, servidor compilado (sem `tsx` em produção), MySQL/Postgres sem porta pública.

### 8.3 Cortar

1. `src/modules/whatsapp/scheduler.ts` (agendador duplicado e quebrado).
2. `store/ppguard.ts`, modelo `Story`, `Message.contactId`, `WhatsAppInstance.rq`, `src/fix_test.js`, `middleware.ts` da raiz (se confirmado), evento `message.upsert` bruto.
3. `src/lib/swagger.ts` escrito à mão, `swagger.json`, `docs/API_DOCUMENTATION.md` (substituir por OpenAPI gerado).
4. Dependências sem uso: `recharts`, `react-syntax-highlighter` (+ tipos), `ts-morph`, `ts-node`, `postinstall-postinstall`; e escolher um entre `moment`/`date-fns`, `radix-ui`/`@radix-ui/*`, `qrcode`/`qrcode.react`.
5. Variáveis de ambiente que não fazem nada (lista em 5.4).
6. Os 367 blocos de permissão de arquivo do patch; manter só as três mudanças reais (canais), sem `console.log`, e fixar a versão exata do Baileys.
7. Volume `uploads_data` e padrões `TZ=Asia/Jakarta`/`LOCALE=id-ID` do compose.
8. `/messages/.../list` (promete lista nativa que o Baileys não envia em conta comum) — ou renomear para "menu em texto".
9. Monitor de sistema e checagem de atualização pelo GitHub, se não forem usados (dependem de `systeminformation` e de `UPDATE_REPO`).
10. Bot de comandos de figurinha/remove.bg, se não for requisito (traz `sharp`, `wa-sticker-formatter`, `ffmpeg` por `exec` e chave de terceiro).
