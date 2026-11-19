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

## 2. Estrutura do código e boundaries

<!-- Camadas (domínio, aplicação, infraestrutura, interfaces), portas e adapters. -->

## 3. Escopo e decisões de fora do escopo

<!-- Teste de carga, autenticação real, CI, partidas dobradas, OpenTelemetry: o que não foi feito e por quê. -->

## 4. Autenticação

<!-- Desenho que seria adotado com um IdP externo e ponto de extensão deixado no código. -->

## 5. Money

<!-- Representação interna, validação de entrada, serialização, persistência. -->

## 6. Modelo de domínio

### 6.1 Transições de status de `WagerTransaction`

<!-- Diagrama/tabela de transições válidas. -->

### 6.2 Interpretações adicionais das regras de negócio

## 7. ORM e mapeamento de persistência

<!-- Escolha do ORM, mapeamento domínio × ORM, mapeamento do Money, estratégia transacional. -->

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

## 17. Testes

<!-- Estratégia, como cada cenário obrigatório é exercitado, determinismo. -->

## 18. Trade-offs e limitações conhecidas

## 19. Uso de IA

<!-- Para que foi usada e como o conteúdo foi validado. -->
