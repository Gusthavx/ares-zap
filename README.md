# Ares Zap

Automação de WhatsApp com fluxos visuais, transmissões com fila anti-bloqueio por número e inbox.
Reescrita otimizada a partir do [MarcFlow](https://github.com/marcolamaia/MarcFlow) (MIT, Marcos Maia): o modelo de grafo e a semântica do motor de fluxos vieram de lá; arquitetura, banco, envio e segurança foram refeitos.

## O que mudou em relação ao MarcFlow

| Tema | MarcFlow | Ares Zap |
|---|---|---|
| Processos | Um processo com Next + Socket.IO + todas as sessões + agendadores | **Servidor** (API/painel) e **worker** (WhatsApp, fila, tarefas) separados, conversando por Postgres (LISTEN/NOTIFY + tabelas de fila) |
| Conexão | Só Baileys | **Baileys ou API oficial (Cloud API)** atrás da mesma interface, por sessão |
| Envio | Cada módulo manda direto; transmissão com intervalo fixo, sem teto | **Fila única por número** (outbox): ordem por contato, "digitando…" sem travar os outros, intervalo aleatório, teto por minuto/hora/dia, aquecimento de número novo, janela de horário, pausa automática em erro grave |
| Motor de fluxos | 3–5 consultas por bloco | **1 leitura + 1 transação por avanço**; gatilhos versionados com o grafo publicado; regra explícita para mensagem durante atraso |
| Mensagem recebida | 5 ouvintes, 20–30 consultas | Um pipeline: 1 transação para contato/conversa/mensagem, motor com trava por contato |
| Atendimento humano | Só se o fluxo pausar a si mesmo | **Automático**: resposta pelo celular ou painel cancela o fluxo e pausa o contato (minutos configuráveis) |
| Agendadores | `node-cron` + 2 agendadores (um quebrado) + ticks em memória | **Uma fila persistente** (`jobs`, SKIP LOCKED, nova tentativa com espera crescente) |
| Reconexão | 3 tentativas fixas de 3 s | Espera crescente sem limite; só para em logout |
| Banco | MySQL, ids de sessão misturados, ~15 tabelas sem FK | Postgres, um id de sessão (uuid), FK com cascade em tudo, migrações versionadas |
| Conversas | Recalculadas a cada página; busca só na página carregada | Tabela `chats` desnormalizada; busca no banco |
| Segurança | Socket.IO aberto, chave de API com Math.random em texto puro, segredos de webhook listados, SSRF, upload com XSS | WebSocket autenticado, chave de API de 32 bytes guardada como hash, segredos cifrados (AES-GCM), bloqueio de URL interna, tipo de arquivo pelo conteúdo, rate limit, cadastro fechado |
| Simulador | Grava no banco com contato `@sim` | **Em memória**, sem tocar no banco nem no WhatsApp |

## Estrutura

```
packages/core     tipos do grafo, validação, lógica pura, configurações, eventos (usado também pelo painel)
packages/db       schema (Drizzle), migrações, cliente postgres.js, mídia, conversas, SSRF, cifra
packages/engine   motor de fluxos + store Postgres + store em memória (simulador/testes)
apps/worker       provedores (Baileys, API oficial), pipeline de entrada, sender por número, tarefas, webhooks
apps/server       API Fastify, WebSocket, webhook da Meta, simulador, serve o painel
apps/web          painel (Vite + React + @xyflow/react)
docs/API.md       contrato da API
```

## Rodar

Requisitos: Node 22+, Docker (para o Postgres) e ffmpeg (notas de voz).

```bash
docker compose up -d                 # Postgres em 127.0.0.1:5433
cp .env.example .env                 # e preencha APP_SECRET (48+ caracteres aleatórios)
npm install
npm run db:migrate
npm run make-admin -- voce@exemplo.com "sua-senha-forte" "Seu Nome"
npm run dev                          # servidor :3100, worker e painel :5173
```

Produção: `npm run build` e `npm start` (sobe servidor e worker compilados e reinicia o que cair).
O servidor escuta só em 127.0.0.1 por padrão; para expor, use `HOST=0.0.0.0` atrás de um proxy com HTTPS e `TRUST_PROXY=1`.

### API oficial
Crie a sessão com provedor "API oficial" (phoneNumberId, accessToken, appSecret). Na Meta, configure o webhook para
`https://seu-dominio/hooks/meta/<id-da-sessão>` com o verify token mostrado na sessão e assine `messages`.
Fora da janela de 24 h só sai modelo aprovado (`template` na API `/v1`).

## Testes

```bash
npm test                                         # lógica, motor e ritmo de envio
TEST_DATABASE_URL=postgres://areszap:areszap@127.0.0.1:5433/areszap_test npm test   # + integração com Postgres
```

## Riscos que continuam

- **Baileys é não oficial**: o número pode ser banido em envio em massa, mesmo com a fila anti-bloqueio. Para volume, prefira a API oficial.
- Um worker por vez neste momento (a trava por contato é em memória). As filas já usam SKIP LOCKED; para vários workers falta dividir as sessões entre eles.

## Licença

MIT. Partes adaptadas do MarcFlow (MIT, Marcos Maia) — ver [LICENSE](LICENSE).
