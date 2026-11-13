# Check-in do evento

Página de check-in para a recepção (celular) + lista de inscritos atualizada automaticamente a partir das vendas dos links de pagamento do Stripe, até o dia do evento.

- **Página:** GitHub Pages (`index.html`, `app.js`). Pede um PIN uma vez por aparelho.
- **Dados:** Firebase Firestore (coleção `inscritos`). Atualiza ao vivo em todos os aparelhos.
- **Automação:** GitHub Actions (`.github/workflows/sync.yml`) a cada 15 min busca as vendas dos links listados em `evento.json` e grava novos pagantes. Reembolso total tira a pessoa da lista. Para sozinha depois de `sincronizarAte`.

## Configuração (uma vez)

1. **Firebase** (projeto novo, plano gratuito):
   - Authentication → Sign-in method → ativar **Anônimo**.
   - Firestore Database → criar banco → aba **Regras** → colar o conteúdo de `firestore.rules` → Publicar.
   - Configurações do projeto → Seus apps → adicionar app **Web** → copiar `apiKey`, `authDomain`, `projectId`, `appId` para `evento.json`.
   - Configurações do projeto → Contas de serviço → **Gerar nova chave privada** (arquivo JSON).
   - Authentication → Configurações → Domínios autorizados → adicionar `<usuario>.github.io`.
2. **Stripe:** Desenvolvedores → Chaves de API → **Criar chave restrita**, só **Leitura** em: Checkout Sessions, Payment Links, PaymentIntents, Charges.
3. **GitHub** → Settings → Secrets and variables → Actions → New repository secret:
   - `STRIPE_KEY` = chave restrita (`rk_live_...`)
   - `FIREBASE_SERVICE_ACCOUNT` = conteúdo inteiro do JSON da conta de serviço
   - `CHECKIN_PIN` = PIN da recepção (ex.: 4 a 6 dígitos)
4. **GitHub** → Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
5. **Actions** → "Sincronizar vendas do Stripe" → **Run workflow** para a primeira carga.

## Ajustes em `evento.json`

- `links[].rotulo`: nome que aparece ao lado do inscrito (ex.: "Lote 1", "VIP").
- `sincronizarAte`: data/hora em que a automação para (com fuso).
- `fuso`: fuso do evento, usado nos horários de check-in.

## Na recepção

- Buscar o nome → **Chegou**. Compras com mais de um ingresso mostram "Chegou 1/2", "2/2".
- **+ Adicionar**: quem chegou sem estar na lista (já faz o check-in) ou uma **lista de nomes** (mentorados, convidados).
- "desfazer" corrige um toque errado.

Para tirar o acesso de todos os aparelhos: troque o `CHECKIN_PIN` e apague a coleção `acessos` no Firestore.
