# Architecture

> Documento vivo: cada decisão é registrada no momento em que é tomada, durante o desenvolvimento.
>
> Formato de cada decisão:
> - **Decisão:**
> - **Alternativas consideradas:**
> - **Por que escolhi:**
> - **Trade-offs / limitações:**

## 1. Visão geral

<!-- Resumo do sistema, principais componentes e fluxo HTTP/SQS → use case → banco → outbox → publicação. -->

### 1.1 Stack e ferramentas

Versões em uso: Bun 1.4, TypeScript 7 (modo estrito), NestJS 12, MikroORM 7, PostgreSQL 17.

Antes de qualquer código de domínio, um spike validou que a stack funciona junta: NestJS subindo no Bun com injeção de dependências por decorators, MikroORM conectando no PostgreSQL, CLI de migrations rodando no Bun, migration reversível (`up`/`down`) e testes com `bun test`.

#### Adaptador HTTP do NestJS

- **Decisão:** Express.
- **Alternativas consideradas:** Fastify.
- **Por que escolhi:** é o adaptador padrão do NestJS. O gargalo deste sistema é o banco (locks e transações), não o framework HTTP, então o ganho de desempenho do Fastify não compensa.
- **Trade-offs / limitações:** menor throughput HTTP bruto que o Fastify.

#### Emulador de SQS

- **Decisão:** LocalStack com a versão fixada em `4.14.0`.
- **Alternativas consideradas:** LocalStack mais recente (2026.x) com `LOCALSTACK_AUTH_TOKEN`; MiniStack (alternativa open source citada no case).
- **Por que escolhi:** as versões atuais do LocalStack só sobem com token de licença, o que obrigaria qualquer pessoa que rode o projeto a criar uma conta. A `4.14.0` é a última que roda sem token. Optei pelo LocalStack por ser mais conhecido, por eu já ter experiência com ele (diferente do MiniStack) e por ser o primeiro citado no case.
- **Trade-offs / limitações:** a versão fica congelada, sem atualizações nem correções. Para um case técnico isso não é um problema, mas em um projeto que vai para produção o ideal seria usar as versões atuais. Se for preciso atualizar no futuro, basta trocar a imagem no `docker-compose.yml`.

#### Configuração

- **Decisão:** variáveis de ambiente lidas e validadas no boot por um loader tipado (`src/config/app-config.ts`), com valores padrão apontando para o ambiente local. Valor inválido ou ausente impede a aplicação de subir.
- **Alternativas consideradas:** `@nestjs/config`.
- **Por que escolhi:** poucas variáveis; um loader simples evita uma dependência e mantém a configuração tipada.
- **Trade-offs / limitações:** sem recursos como múltiplos arquivos `.env` por ambiente.

#### Execução das migrations

- **Decisão (provisória):** migrations rodam por comando separado (`bun run db:migrate`), não no boot da aplicação.
- **Alternativas consideradas:** rodar as migrations automaticamente ao subir a aplicação.
- **Por que escolhi:** com várias instâncias subindo ao mesmo tempo, todas tentariam migrar o banco simultaneamente.
- **Trade-offs / limitações:** exige um passo a mais no setup. A decisão pode ser revista quando a forma de rodar múltiplas instâncias for definida.

## 2. Estrutura do código e boundaries

<!-- Camadas (domínio, aplicação, infraestrutura, interfaces), portas e adapters. -->

## 3. Escopo e decisões de fora do escopo

Ficaram fora do escopo, por decisão, para concentrar o prazo nas áreas que mais pesam na avaliação (correção financeira, concorrência, idempotência e mensageria):

| Item | Status no case | Motivo |
|---|---|---|
| Autenticação real com IdP | Não pontua; pode ser só documentada | Ver seção 4 |
| Teste de carga | Diferencial opcional | Prazo |
| Ledger de partidas dobradas | Diferencial opcional | Prazo; o ledger simples atende às invariantes exigidas |
| OpenTelemetry / dashboard | Opcional | Prazo; logs estruturados, métricas e health checks cobrem o obrigatório |
| CI | Não pedido | Prazo |

## 4. Autenticação

- **Decisão:** não implementar autenticação neste desafio; deixar o ponto de extensão explícito no código.
- **Alternativas consideradas:** integrar um Identity Provider externo (Keycloak ou Zitadel) via OIDC.
- **Por que escolhi:** autenticação não vale pontos na avaliação e competiria em tempo com correção financeira, concorrência e idempotência, como o próprio case orienta.
- **Trade-offs / limitações:** a API fica aberta.

**Ponto de extensão no código:**
- `AuthGuard` (`src/auth/auth.guard.ts`), registrado como guard global: hoje libera todas as requisições. Uma implementação real validaria aqui o token emitido pelo IdP.
- Decorator `@Public()` (`src/auth/public.decorator.ts`): marca rotas que não exigem autenticação. Já aplicado aos health checks, que o case exige abertos.
- Mensagens da fila são tratadas como canal interno confiável, mas a identidade do provedor contida na mensagem continua sujeita às validações de domínio.

<!-- Desenho que seria adotado com um IdP externo: a definir. -->

## 5. Money

<!-- Representação interna, validação de entrada, serialização, persistência. -->

## 6. Modelo de domínio

### 6.1 Transições de status de `WagerTransaction`

<!-- Diagrama/tabela de transições válidas. -->

### 6.2 Interpretações adicionais das regras de negócio

## 7. ORM e mapeamento de persistência

### 7.1 Escolha do ORM

- **Decisão:** MikroORM.
- **Alternativas consideradas:** TypeORM (aceito pelo case).
- **Por que escolhi:** é o preferencial do case e oferece Unit of Work, Identity Map, `em.transactional()` e `LockMode` explícitos, recursos diretamente ligados às exigências de atomicidade e concorrência.
- **Trade-offs / limitações:** <!-- a definir -->

### 7.2 Mapeamento domínio × ORM

<!-- A decidir na etapa 3. -->

**Observação do spike:** uma classe com construtor `private` e sem decorators pode ser mapeada via `EntitySchema`. Em runtime funciona (o ORM reidrata sem chamar o construtor), mas o TypeScript recusa o construtor privado no `EntitySchema`, o que exige um cast (`as unknown as EntityCtor<T>`) em cada entidade.

**Observação sobre migrations:** a migration gerada com `--initial` não inclui `down`; as geradas a partir de diferenças no schema incluem. Como o case exige migrations reversíveis, todo `down` é conferido.

<!-- Mapeamento do Money e estratégia transacional: a definir. -->

## 8. Schema, constraints e índices

<!-- Como cada garantia da seção 6 do case é aplicada no banco. -->

## 9. Concorrência

## 10. Idempotência

<!-- Fluxo, replay, conflito, algoritmo do payloadHash. -->

## 11. API HTTP

### 11.1 Mapeamento de status HTTP

### 11.2 Taxonomia de `failureCode`

## 12. Processamento por SQS

<!-- Inbox, ack, classificação de erros, retry, DLQ, shutdown. -->

## 13. Transactional Outbox

## 14. Referências fora de ordem (`PENDING_REFERENCE`)

## 15. Reconciliação

## 16. Observabilidade

### 16.1 Logs estruturados

- **Decisão:** `pino` via `nestjs-pino`, com saída em JSON.
- **Alternativas consideradas:** `winston`; estender o logger nativo do NestJS para gerar JSON.
- **Por que escolhi:** JSON nativo; o `nestjs-pino` propaga o contexto da requisição (via `AsyncLocalStorage`) para todos os logs gerados durante ela, sem passar o logger manualmente.

**Como está configurado:**
- **`correlationId`:** reutiliza o header `x-correlation-id` da requisição, ou gera um UUID. É devolvido no mesmo header da resposta e aparece em todos os logs da requisição.
- Requisições aos health checks não geram log de acesso, para não poluir os logs com as sondagens.

<!-- messageId, transactionId, walletId, providerId: a adicionar com o use case e o consumidor SQS. -->

### 16.2 Health checks

- `GET /health/live`: indica que o processo está de pé e respondendo. Não consulta dependências, para que uma falha no banco ou na fila não faça o orquestrador reiniciar o processo à toa.
- `GET /health/ready`: verifica o PostgreSQL (`select 1`) e o SQS (`GetQueueUrl` da fila principal), cada um com timeout de 2 s. Responde 200 se ambos estiverem acessíveis e 503 caso contrário, indicando qual dependência falhou. O motivo da falha é registrado no log.
- Os dois são públicos (`@Public()`), como o case exige.

### 16.3 Métricas

<!-- A definir. -->

## 17. Testes

<!-- Estratégia, como cada cenário obrigatório é exercitado, determinismo. -->

## 18. Trade-offs e limitações conhecidas

## 19. Uso de IA

<!-- Para que foi usada e como o conteúdo foi validado. -->
