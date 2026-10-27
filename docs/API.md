# Ares Zap · contrato da API

Base: `/api`. JSON em tudo (exceto upload). Datas em ISO 8601 (UTC). Erros: `{ "error": "mensagem em português", "issues"?: [...] }` com status HTTP adequado (400 validação, 401 sem login, 403 sem permissão, 404, 409 conflito, 422 regra de negócio, 429 limite).

Autenticação do painel: cookie httpOnly `az_session` (JWT), criado no login. Integrações: header `x-api-key: <chave>` vale em todas as rotas `/api/*`.

Tipos compartilhados (grafo, gatilhos, configurações, eventos) estão em `packages/core/src` e podem ser importados pelo painel como `@areszap/core`.

## Autenticação
| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | /auth/login | `{email, password}` | `{user}` + cookie |
| POST | /auth/logout | — | `{ok}` |
| GET | /auth/me | — | `{user: {id, email, name, role}}` ou 401 |
| POST | /auth/password | `{current, next}` | `{ok}` |

## Sessões (números)
`Session = {id, name, provider: "baileys"|"cloud", enabled, status, phone, lastError, settings: SessionSettings, connectedAt, createdAt, qr: string|null}`
`status`: `stopped | starting | qr | connected | reconnecting | logged_out | error`

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /sessions | — | `Session[]` |
| POST | /sessions | `{name, provider, cloud?: {phoneNumberId, wabaId, accessToken, appSecret, verifyToken}}` | `Session` |
| GET | /sessions/:id | — | `Session` |
| PATCH | /sessions/:id | `{name?, settings?: Partial<SessionSettings>, cloud?}` | `Session` |
| DELETE | /sessions/:id | — | `{ok}` (admin) |
| POST | /sessions/:id/start · /stop · /logout | — | `{ok}` |
| GET | /sessions/:id/stats | — | `{outbox: {queued, held, sending, sentToday, failedToday}, cap: {today, perDay}, flows: {active, runsActive}}` |

O QR chega pelo WebSocket (`session.status` com `qr`) e também no campo `qr` de `GET /sessions/:id`.
Webhook da API oficial: configurar na Meta a URL `/hooks/meta/:sessionId` com o `verifyToken` da sessão.

## Conversas (inbox)
`Chat = {id, jid, title, phone, lastMessageText, lastMessageAt, lastFromMe, unread, archived, contactId, pausedUntil, activeRun: {id, flowId, flowName, status} | null}`
`Message = {id, waId, fromMe, sender: "contact"|"flow"|"broadcast"|"agent"|"api"|"phone"|"notify", type, body, media: {assetId, mime, fileName} | null, status, createdAt}`
`status` de mensagem enviada: `queued | sent | delivered | read | failed`.

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | /sessions/:id/chats | `?search=&archived=0|1&cursor=<iso>&limit=40` | `{items: Chat[], nextCursor: string|null}` (mais recente primeiro) |
| GET | /chats/:chatId/messages | `?before=<iso>&limit=50` | `{items: Message[]}` (mais nova primeiro) |
| GET | /chats/:chatId | — | `Chat` |
| POST | /chats/:chatId/messages | `{text}` ou `{assetId, caption?}` | `{outboxId, waId}` — aparece na hora com status `queued`; conta como atendimento humano (pausa o robô) |
| POST | /chats/:chatId/read | — | `{ok}` |
| POST | /chats/:chatId/archive | `{archived: boolean}` | `{ok}` |
| POST | /chats/:chatId/automation | `{action: "resume"}` ou `{action: "pause", minutes}` | `{pausedUntil}` |

## Contatos, etiquetas, variáveis
`Contact = {id, jid, phone, name, pushName, fields: Record<string,string>, labels: {id,name,color}[], pausedUntil, optedOutAt, createdAt}`
`Label = {id, name, color, count}`

| Método | Rota | Corpo / query | Resposta |
|---|---|---|---|
| GET | /sessions/:id/contacts | `?search=&labelId=&cursor=&limit=50` | `{items: Contact[], nextCursor}` |
| PATCH | /contacts/:id | `{name?, fields?, labelIds?, optedOut?}` | `Contact` |
| GET | /sessions/:id/labels | — | `Label[]` |
| POST | /sessions/:id/labels | `{name, color?}` | `Label` |
| PATCH / DELETE | /labels/:id | `{name?, color?}` | `Label` / `{ok}` |
| GET | /sessions/:id/variables | — | `Record<string,string>` (campos de escopo BOT) |
| PUT | /sessions/:id/variables | `Record<string,string|null>` (null apaga) | `Record<string,string>` |

## Fluxos
`FlowSummary = {id, name, status: "draft"|"active"|"inactive", publishedVersion, publishedAt, updatedAt, triggers: FlowTrigger[], hasUnpublishedChanges, runsActive}`
`Flow = FlowSummary & {sessionId, draftGraph: FlowGraph, draftTriggers: FlowTrigger[], draftRevision, publishedGraph, publishedTriggers}`

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /sessions/:id/flows | — | `FlowSummary[]` |
| POST | /sessions/:id/flows | `{name, graph?, triggers?}` | `Flow` |
| POST | /sessions/:id/flows/import | JSON exportado (Ares Zap ou MarcFlow) | `Flow` |
| GET | /flows/:id | — | `Flow` |
| GET | /flows/:id/export | — | `{name, graph, triggers}` |
| PATCH | /flows/:id | `{name}` | `Flow` |
| PUT | /flows/:id/draft | `{graph, triggers, revision}` | `{revision}` ou 409 `{revision}` se outra aba salvou antes |
| POST | /flows/:id/validate | — | `{issues: GraphIssue[]}` |
| POST | /flows/:id/publish | — | `{version, issues}` ou 422 `{issues}` (publica rascunho + gatilhos e ativa) |
| POST | /flows/:id/activate · /deactivate | — | `{ok}` |
| POST | /flows/:id/duplicate | — | `Flow` |
| DELETE | /flows/:id | — | `{ok}` |
| POST | /flows/:id/simulate | `{text?, optionId?, reset?: boolean}` | `SimResult` (usa o RASCUNHO; nada vai ao WhatsApp) |
| POST | /flows/:id/test | `{phone}` | `{contactId, queued: true}` (rascunho num número real; roda no worker) |
| GET | /flows/:id/stats | — | `{nodes: Record<nodeId, Record<key, number>>, runs: Record<status, number>}` (key: `entered`, `option:<id>`) |
| GET | /flows/:id/runs | `?status=&limit=50` | `{items: Run[]}` |
| GET | /runs/:id/events | — | `{items: {id, nodeId, kind, detail, createdAt}[]}` |
| POST | /runs/:id/cancel | — | `{ok}` |

`POST /flows/:id/simulate` também aceita `{skipWait: true}`: retoma na hora a espera atual (atraso inteligente ou "se não responder").
`GET /sessions/:id/fields` → `{contact: string[], bot: string[]}` (campos usados nos contatos e variáveis do robô, para o editor sugerir).

`SimResult = {result: "started"|"handled"|"busy"|"paused"|"no-trigger"|"ignored"|"duplicate"|"reset", messages: SimMessage[], run: {status, currentNodeId, wait, resumeAt} | null, fields: Record<string,string>, tags: string[]}`
`SimMessage = {kind: "text"|"media"|"vcard"|"menu"|"template", text, options?: {id,text}[], mode?: "number"|"interactive", typingMs, delayMs, to?: string}` — mensagens novas desde a chamada anterior.
`Run = {id, flowId, flowVersion, contactId, jid, status, currentNodeId, resumeAt, isTest, error, createdAt, updatedAt}`

## Mídia
`Asset = {id, fileName, mime, size, createdAt, url}` (`url` = `/api/assets/:id/file`)

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /sessions/:id/assets | — | `Asset[]` |
| POST | /sessions/:id/assets | multipart `file` (até 64 MB; tipo conferido pelo conteúdo) | `Asset` |
| GET | /assets/:id/file | — | arquivo (`nosniff`; não é imagem/áudio/vídeo = download) |
| DELETE | /assets/:id | — | `{ok}` |

## Transmissões
`Broadcast = {id, name, status: "scheduled"|"running"|"paused"|"completed"|"cancelled", message: OutMessage, scheduledAt, minGapSec, maxGapSec, skipOptedOut, total, sent, failed, skipped, createdAt, startedAt, finishedAt, etaAt: string|null}`

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /sessions/:id/broadcasts | — | `Broadcast[]` |
| POST | /sessions/:id/broadcasts | `{name, text, assetId?, recipients?: {phone, vars?}[], labelIds?: string[], scheduledAt?, minGapSec?, maxGapSec?, skipOptedOut?}` | `Broadcast & {invalidNumbers: number}` (máx. 50.000 destinatários; variáveis `{nome}` etc. vêm de `vars` e dos campos do contato) |
| GET | /broadcasts/:id | — | `Broadcast` |
| GET | /broadcasts/:id/recipients | `?status=&limit=100&offset=0` | `{items: {id, jid, status, error, sentAt}[], total}` (status: `pending, queued, sent, failed, skipped, cancelled`) |
| POST | /broadcasts/:id/pause · /resume · /cancel | — | `{ok}` |

O ritmo vem da fila do número: intervalo aleatório entre `minGapSec` e `maxGapSec` (padrão da sessão 15–45 s), teto por hora/dia, aquecimento de número novo e janela de envio.

## Webhooks de saída
Eventos: `message.received, message.sent, message.status, session.status, flow.completed, contact.optout, broadcast.finished`.
Entrega: `POST url` com corpo `{event, sessionId, data, at}` e header `x-areszap-signature: sha256=<hmac do corpo com o segredo>`. Até 6 tentativas com espera crescente. URLs para IP privado são recusadas.

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /webhooks | — | `{id, sessionId, url, events, active, lastStatus, lastError, lastAt, createdAt}[]` |
| POST | /webhooks | `{sessionId?: string|null, url, events}` | webhook + `secret` (só nesta resposta) |
| PATCH | /webhooks/:id | `{url?, events?, active?}` | webhook |
| DELETE | /webhooks/:id | — | `{ok}` |
| POST | /webhooks/:id/test | — | `{ok}` |

## Chaves de API e usuários
| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | /api-keys | — | `{id, name, prefix, lastUsedAt, createdAt}[]` |
| POST | /api-keys | `{name}` | `{..., key}` (só nesta resposta) |
| DELETE | /api-keys/:id | — | `{ok}` |
| GET | /users | — | `{id, email, name, role, createdAt}[]` (admin) |
| POST | /users | `{email, name, password, role}` | usuário (admin) |
| DELETE | /users/:id | — | `{ok}` (admin) |

## API pública (integrações, `x-api-key`)
| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| POST | /v1/sessions/:id/messages | `{to, text?, media?: {type: "image"|"video"|"audio"|"file", url?, assetId?, caption?, fileName?}}` | `{outboxId, waId}` |
| POST | /v1/sessions/:id/events | `{phone, name?, fields?, flowId?, nodeId?}` | `{contactId, runId: string|null}` (ex.: compra aprovada grava campos e inicia fluxo num bloco) |

## Tempo real
`GET /ws` (WebSocket; cookie do painel ou `?key=<api key>`). O servidor manda objetos `BusEvent` (`packages/core/src/events.ts`):
`session.status`, `message`, `message.status`, `chat`, `broadcast`, `run`. O painel usa o evento para recarregar a parte afetada.

## Saúde
`GET /api/health` → `{ok, db, worker: {alive, lastBeatAt}}` (sem login).
