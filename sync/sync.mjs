// Busca no Stripe as vendas dos links de pagamento do evento e lança como inscritos no app
// (eventos/<eventoId>/inscritos), no mesmo formato da importação do extrato do Stripe.
// Roda no GitHub Actions. Secrets: FIREBASE_SERVICE_ACCOUNT, STRIPE_KEY, CHECKIN_PIN (editor), LEITURA_PIN (opcional).
import fs from "node:fs";
import Stripe from "stripe";
import admin from "firebase-admin";

const ev = JSON.parse(fs.readFileSync(new URL("../evento.json", import.meta.url), "utf8"));
const forcar = process.env.FORCAR === "true";
const EID = ev.eventoId;

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("Falta o secret FIREBASE_SERVICE_ACCOUNT."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

// 0. PINs (mantidos no banco, fora do alcance do navegador). Gravados antes de tudo.
const pinEditor = String(process.env.CHECKIN_PIN || "").trim();
const pinLeitura = String(process.env.LEITURA_PIN || "").trim();
if (pinEditor) {
  await db.doc("config/secreto").set({ editor: pinEditor, leitura: pinLeitura && pinLeitura !== pinEditor ? pinLeitura : null });
  console.log("PINs atualizados" + (pinLeitura ? " (editor e leitura)." : " (editor)."));
}

// Limpeza única: a primeira versão do check-in gravava numa coleção "inscritos" solta.
const antigos = await db.collection("inscritos").get();
if (!antigos.empty) {
  const b = db.batch(); antigos.forEach(d => b.delete(d.ref)); await b.commit();
  console.log(`Removidos ${antigos.size} registro(s) da versão antiga do check-in.`);
}

if (!forcar && ev.sincronizarAte && new Date() > new Date(ev.sincronizarAte)) {
  console.log(`Prazo de sincronização encerrado (${ev.sincronizarAte}). Nada a fazer.`);
  process.exit(0);
}
if (!process.env.STRIPE_KEY) { console.error("Falta o secret STRIPE_KEY."); process.exit(1); }
if (!EID) { console.error("Falta eventoId em evento.json."); process.exit(1); }
const stripe = new Stripe(process.env.STRIPE_KEY);

const evDoc = await db.doc("eventos/" + EID).get();
if (!evDoc.exists) {
  console.log(`O evento ${EID} ainda não existe no app (importe os dados primeiro). Nada lançado.`);
  process.exit(0);
}
const segs = evDoc.data().segmentos || [];
const origemPadrao = ev.origemPadrao || (segs.find(s => s.tipo === "pago") || segs[0] || {}).nome || "";

// ---- mesmas regras de comparação da importação do app ----
const r2 = v => Math.round(v * 100) / 100;
const normName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function sameName(a, b) {
  a = normName(a); b = normName(b);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const ta = a.split(" "), tb = b.split(" ");
  return ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1];
}
const isoDay = sec => new Date(sec * 1000).toISOString().slice(0, 10);

// 1. Descobre o id (plink_...) de cada URL de link de pagamento.
const norm = u => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const alvo = new Map(ev.links.map(l => [norm(l.url), l]));
const links = new Map();
for await (const pl of stripe.paymentLinks.list({ limit: 100 })) {
  const l = alvo.get(norm(pl.url));
  if (l) links.set(pl.id, l);
}
const naoAchados = ev.links.filter(l => ![...links.values()].includes(l));
if (naoAchados.length) console.warn("Links não encontrados nesta conta do Stripe:", naoAchados.map(l => l.url).join(", "));
if (!links.size) { console.error("Nenhum link encontrado. Confira a chave e as URLs."); process.exit(1); }

// 2. O que já está no app.
const col = db.collection(`eventos/${EID}/inscritos`);
const existentes = (await col.get()).docs.map(d => ({ id: d.id, ...d.data() }));

// 3. Vendas concluídas de cada link.
let comTaxaReal = true;
async function listarSessoes(plid) {
  const out = [];
  const base = { payment_link: plid, status: "complete", limit: 100 };
  try {
    if (comTaxaReal) {
      for await (const s of stripe.checkout.sessions.list({ ...base, expand: ["data.payment_intent.latest_charge.balance_transaction"] })) out.push(s);
      return out;
    }
  } catch (e) {
    if (e?.type !== "StripePermissionError" && e?.statusCode !== 403) throw e;
    comTaxaReal = false; out.length = 0;
    console.warn("A chave não lê Balance Transactions: a taxa será estimada (2,9% + $ 0,30).");
  }
  for await (const s of stripe.checkout.sessions.list({ ...base, expand: ["data.payment_intent.latest_charge"] })) out.push(s);
  return out;
}

let vistos = 0, novos = 0, vinculados = 0, reembolsos = 0;
let batch = db.batch(), ops = 0;
const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
const agora = Date.now();

for (const [plid] of links) {
  for (const s of await listarSessoes(plid)) {
    if (s.payment_status !== "paid") continue;
    const ch = s.payment_intent?.latest_charge;
    if (!ch || typeof ch !== "object") continue;
    vistos++;
    const itens = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
    const qty = itens.data.reduce((t, i) => t + (i.quantity || 1), 0) || 1;
    const amount = (ch.amount || s.amount_total || 0) / 100;
    const bt = ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
    const fee = bt ? bt.fee / 100 : r2(amount * 0.029 + 0.30);
    const refunded = ch.refunded || (ch.amount_refunded > 0 && ch.amount_refunded >= ch.amount);
    const cd = s.customer_details || {};
    const name = (cd.name || cd.email || "(sem nome)").trim();
    const created = isoDay(ch.created || s.created);
    const avail = bt?.available_on ? isoDay(bt.available_on) : "";

    let restV = amount, restF = fee;
    for (let i = 1; i <= qty; i++) {
      const v = i === qty ? r2(restV) : r2(amount / qty), f = i === qty ? r2(restF) : r2(fee / qty);
      restV -= v; restF -= f;
      const stripeId = qty > 1 ? ch.id + "#" + i : ch.id;
      const cliente = qty > 1 ? `${name} (${i}/${qty})` : name;
      const bySid = existentes.find(e => e.stripeId === stripeId);
      const ex = bySid || existentes.find(e => !e.stripeId && e.dataProc === created && sameName(e.cliente, name) &&
        (Math.abs((+e.valor || 0) - v) < 0.005 || (e.sub === "Reembolso" && (+e.valor || 0) === 0)));

      if (ex) {
        const upd = {};
        if (!ex.stripeId) { upd.stripeId = stripeId; ex.stripeId = stripeId; vinculados++; }
        if (refunded && ex.sub !== "Reembolso") { upd.sub = "Reembolso"; upd.valor = 0; reembolsos++; }
        if (Object.keys(upd).length) { batch.update(col.doc(ex.id), upd); ops++; }
      } else {
        const id = "stripe_" + stripeId.replace(/[^A-Za-z0-9_]/g, "_");
        const novo = {
          cliente, origem: origemPadrao, sub: refunded ? "Reembolso" : "Ingresso", valor: refunded ? 0 : v, taxa: f,
          conta: "Stripe", dataProc: created, dataReceb: avail, stripeId, email: cd.email || "",
          seq: agora + novos, criadoEm: new Date().toISOString(), checkinEm: "", via: "sync-links",
        };
        batch.set(col.doc(id), novo); ops++; novos++;
        existentes.push({ id, ...novo });
      }
      if (ops >= 400) await flush();
    }
  }
}
await flush();
if (novos || reembolsos) await db.doc("eventos/" + EID).update({ ultimaAtividade: new Date().toISOString() });

console.log(`Vendas pelos links: ${vistos} · novos inscritos: ${novos} · já existentes vinculados: ${vinculados} · reembolsos: ${reembolsos}` +
  (comTaxaReal ? "" : " · taxa estimada"));
