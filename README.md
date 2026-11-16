# Financeiro de Eventos

App de controle financeiro dos eventos presenciais (painel de metas Free × Pagos, check-in, inscritos, gastos × budget, almoço, importação do extrato do Stripe, metas e budget, exportação para Excel), publicado no GitHub Pages com os dados no Firebase (Firestore). As vendas feitas pelos links de pagamento do evento entram sozinhas na lista de inscritos até o dia do evento.

- **Endereço:** https://ricardolemos2026.github.io/checkin-evento/
- **Check-in direto (recepção):** https://ricardolemos2026.github.io/checkin-evento/#dsv-nov26--checkin
- Acesso por **PIN**, pedido uma vez em cada aparelho:
  - PIN de **editor** (`CHECKIN_PIN`): lê e grava tudo, inclusive check-in.
  - PIN de **leitura** (`LEITURA_PIN`, opcional): só vê os números ("Modo leitura").

## Como está montado

| Arquivo | Função |
|---|---|
| `index.html` | O app (o mesmo do claude.ai / da versão com servidor) |
| `shim.js` | Liga o app ao Firestore, pede o PIN, botões Backup e Sair |
| `vendor/` | PapaParse 5.4.1 (MIT) e SheetJS 0.18.5 (Apache-2.0) |
| `evento.json` | Configuração do Firebase, evento sincronizado (`eventoId`), links de pagamento, prazo |
| `sync/sync.mjs` | Automação: grava os PINs e lança as vendas dos links como inscritos |
| `.github/workflows/sync.yml` | Roda a automação a cada 15 min (e manualmente em Actions → Run workflow) |
| `firestore.rules` | Regras de acesso do banco (colar no console do Firebase) |

Dados no Firestore, no mesmo modelo do app: `eventos/{id}`, `eventos/{id}/inscritos/{id}`, `.../gastos`, `.../almoco_despesas`, `.../almoco/receita`. PINs em `config/secreto` (ilegível pelo navegador); aparelhos liberados em `acessos/{uid}`.

## Automação do Stripe

- Considera as vendas concluídas dos links em `evento.json` → `links`.
- Cada venda vira uma linha `sub: "Ingresso"` em `eventos/<eventoId>/inscritos`, com `conta: "Stripe"`, taxa real (ou estimada em 2,9% + $ 0,30 se a chave não ler Balance Transactions) e `stripeId` = id da cobrança (`ch_...`), o mesmo que a importação do extrato usa. Compra de vários ingressos vira uma linha por ingresso.
- Não duplica: se a venda já foi lançada à mão ou pelo extrato (mesmo dia, nome parecido e mesmo valor), só vincula o `stripeId`.
- Reembolso total converte a linha em `sub: "Reembolso"`, `valor: 0`, mantendo a taxa.
- Origem das vendas novas: `origemPadrao` em `evento.json`, ou a primeira origem do tipo "pago" em Metas e Budget. Ajuste no app (aba Inscritos) se precisar.
- Para de rodar sozinha depois de `sincronizarAte`. Para forçar: Actions → Run workflow → marcar "Rodar mesmo depois do prazo".

## Secrets do GitHub (Settings → Secrets and variables → Actions)

- `FIREBASE_SERVICE_ACCOUNT`: JSON da conta de serviço do Firebase.
- `STRIPE_KEY`: chave restrita do Stripe (`rk_live_...`), leitura em Checkout Sessions, Payment Links, PaymentIntents, Charges (e Balance Transactions para a taxa real).
- `CHECKIN_PIN`: PIN de editor.
- `LEITURA_PIN` (opcional): PIN só de leitura.

Trocar um PIN: edite o secret; vale na próxima execução (até 15 min). Para tirar o acesso de todos os aparelhos, apague a coleção `acessos` no Firestore.

## Backup

Botão **Backup** no topo (editor, em telas largas): baixa um JSON com tudo e importa um backup ou o `dados_atuais.json`. Faça antes e depois de cada evento. Nunca coloque arquivos de dados neste repositório (ele é público).

## Atualizar o app

Se o app mudar, gere de novo o `index.html` a partir do HTML do app trocando apenas as linhas de script: Firebase compat (app, auth, firestore 10.12.2) → `shim.js` → `vendor/papaparse.min.js` → `vendor/xlsx.full.min.js`.
