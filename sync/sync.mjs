// Busca no Stripe as vendas dos links de pagamento do evento e grava a lista no Firestore.
// Roda no GitHub Actions. Variáveis: STRIPE_KEY, FIREBASE_SERVICE_ACCOUNT, CHECKIN_PIN (opcional).
import fs from "node:fs";
import Stripe from "stripe";
import admin from "firebase-admin";

const ev = JSON.parse(fs.readFileSync(new URL("../evento.json", import.meta.url), "utf8"));
const forcar = process.env.FORCAR === "true";

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("Falta o secret FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

// PIN da recepção (mantido no banco, fora do alcance do navegador). Gravado antes de tudo.
if (process.env.CHECKIN_PIN) {
  await db.doc("config/secreto").set({ pin: String(process.env.CHECKIN_PIN).trim() });
  console.log("PIN da recepção atualizado.");
}

if (!forcar && ev.sincronizarAte && new Date() > new Date(ev.sincronizarAte)) {
  console.log(`Prazo de sincronização encerrado (${ev.sincronizarAte}). Nada a fazer.`);
  process.exit(0);
}
if (!process.env.STRIPE_KEY) { console.error("Falta o secret STRIPE_KEY (PIN já gravado)."); process.exit(1); }
const stripe = new Stripe(process.env.STRIPE_KEY);

// 1. Descobre o id (plink_...) de cada URL de link de pagamento.
const norm = u => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const alvo = new Map(ev.links.map(l => [norm(l.url), l]));
const links = new Map(); // plink id -> {url, rotulo}
for await (const pl of stripe.paymentLinks.list({ limit: 100 })) {
  const l = alvo.get(norm(pl.url));
  if (l) links.set(pl.id, l);
}
const naoAchados = ev.links.filter(l => ![...links.values()].includes(l));
if (naoAchados.length) {
  console.warn("Links não encontrados nesta conta do Stripe:", naoAchados.map(l => l.url).join(", "));
}
if (!links.size) { console.error("Nenhum link encontrado. Confira a chave e as URLs."); process.exit(1); }

// 2. O que já está no banco.
const existentes = new Map();
(await db.collection("inscritos").where("origem", "==", "stripe").get())
  .forEach(d => existentes.set(d.id, d.data()));

// 3. Percorre as vendas concluídas de cada link.
const campoNome = s => {
  const f = (s.custom_fields || []).find(c => /nome|name/i.test(c.key + " " + (c.label?.custom || "")));
  const v = f?.text?.value || f?.dropdown?.value;
  return v ? String(v).trim() : "";
};
const camposExtras = s => Object.fromEntries((s.custom_fields || []).map(c =>
  [c.label?.custom || c.key, c.text?.value ?? c.dropdown?.value ?? c.numeric?.value ?? ""]));

let novos = 0, alterados = 0, vistos = 0;
let batch = db.batch(), ops = 0;
const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };

for (const [plid, link] of links) {
  for await (const s of stripe.checkout.sessions.list({
    payment_link: plid, status: "complete", limit: 100,
    expand: ["data.payment_intent.latest_charge"],
  })) {
    if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") continue;
    vistos++;
    const id = "stripe_" + s.id;
    const ch = s.payment_intent?.latest_charge;
    const reembolsado = !!ch && (ch.refunded || (ch.amount_refunded > 0 && ch.amount_refunded >= ch.amount));
    const parcial = !!ch && ch.amount_refunded > 0 && !reembolsado;
    const status = reembolsado ? "reembolsado" : "ativo";
    const atual = existentes.get(id);

    if (!atual) {
      const itens = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
      const qtd = itens.data.reduce((t, i) => t + (i.quantity || 1), 0) || 1;
      const unit = itens.data[0]?.price?.unit_amount ?? Math.round((s.amount_total || 0) / qtd);
      const rotulo = (ev.lotes || {})[String(Math.round(unit / 100))] || link.rotulo || `$ ${Math.round(unit / 100)}`;
      const cd = s.customer_details || {};
      batch.set(db.doc("inscritos/" + id), {
        nome: campoNome(s) || cd.name || cd.email || "(sem nome)",
        comprador: cd.name || "",
        email: cd.email || "",
        telefone: cd.phone || "",
        extras: camposExtras(s),
        origem: "stripe",
        rotulo,
        link: plid,
        sessao: s.id,
        valor: (s.amount_total || 0) / 100,
        moeda: (s.currency || "usd").toUpperCase(),
        qtd,
        status,
        reembolsoParcial: parcial,
        pagoEm: new Date(s.created * 1000).toISOString(),
        checkins: 0,
        checkinEm: "",
        checkinUlt: "",
        criadoEm: new Date().toISOString(),
      });
      novos++; ops++;
    } else if (atual.status !== status || !!atual.reembolsoParcial !== parcial) {
      // Só muda situação de pagamento; nunca mexe em check-in nem em nome já gravado.
      batch.update(db.doc("inscritos/" + id), { status, reembolsoParcial: parcial });
      alterados++; ops++;
    }
    if (ops >= 400) await flush();
  }
}
await flush();

await db.doc("config/sync").set({ ultimaExecucao: new Date().toISOString(), vendas: vistos, novos, alterados });
console.log(`Vendas vistas: ${vistos} · novas: ${novos} · alteradas (reembolso): ${alterados}`);
