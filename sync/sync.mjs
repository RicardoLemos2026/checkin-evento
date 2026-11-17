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

// 1. Descobre o id (plink_...) de cada URL de link de pagamento (buy.stripe.com).
const norm = u => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const alvo = new Map((ev.links || []).map(l => [norm(l.url), l]));
const links = new Map();
if (alvo.size) {
  for await (const pl of stripe.paymentLinks.list({ limit: 100 })) {
    const l = alvo.get(norm(pl.url));
    if (l) links.set(pl.id, l);
  }
  const naoAchados = ev.links.filter(l => ![...links.values()].includes(l));
  if (naoAchados.length) console.warn(`${naoAchados.length} link(s) de pagamento não encontrados nesta conta do Stripe.`);
}

// 2. O que já está no app.
const col = db.collection(`eventos/${EID}/inscritos`);
const existentes = (await col.get()).docs.map(d => ({ id: d.id, ...d.data() }));

let comTaxaReal = true;
async function listar(fn, params, expandCom, expandSem) {
  const out = [];
  try {
    if (comTaxaReal) { for await (const x of fn({ ...params, expand: expandCom })) out.push(x); return out; }
  } catch (e) {
    if (e?.type !== "StripePermissionError" && e?.statusCode !== 403) throw e;
    comTaxaReal = false; out.length = 0;
    console.warn("A chave não lê Balance Transactions: a taxa será estimada (2,9% + $ 0,30).");
  }
  for await (const x of fn({ ...params, expand: expandSem })) out.push(x);
  return out;
}

let vistos = 0, novos = 0, vinculados = 0, reembolsos = 0;
const revisar = [], plano = [];
const SIMULAR = ev.marcasSimular === true;
let batch = db.batch(), ops = 0;
const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
const agora = Date.now();
const feitos = new Set();

// Lança uma cobrança (ch) como 1 linha por ingresso, sem duplicar.
async function lancar(ch, { qty, name, email, via, totalIngressos, participantes = [], bump = 0, marca = false }) {
  if (feitos.has(ch.id)) return;
  feitos.add(ch.id); vistos++;
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const amountTotal = (ch.amount || 0) / 100;
  const amount = totalIngressos != null ? totalIngressos : amountTotal;
  const bt = ch.balance_transaction && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  const feeTotal = bt ? bt.fee / 100 : r2(amountTotal * 0.029 + 0.30);
  const fee = amountTotal > 0 ? r2(feeTotal * amount / amountTotal) : feeTotal;
  const refunded = ch.refunded || (ch.amount_refunded > 0 && ch.amount_refunded >= ch.amount);
  name = String(name || email || "(sem nome)").trim();
  const created = isoDay(ch.created);
  const avail = bt?.available_on ? isoDay(bt.available_on) : "";

  let restV = amount, restF = fee;
  for (let i = 1; i <= qty; i++) {
    const v = i === qty ? r2(restV) : r2(amount / qty), f = i === qty ? r2(restF) : r2(fee / qty);
    restV -= v; restF -= f;
    const stripeId = qty > 1 ? ch.id + "#" + i : ch.id;
    const part = i > 1 ? String(participantes[i - 2] || "").replace(/<[^>]*>/g, "").trim() : "";
    const cliente = qty > 1 ? (part ? `${part} (compra de ${name})` : `${name} (${i}/${qty})`) : name;
    const quem = part || name;
    const valorOk = e => Math.abs((+e.valor || 0) - v) < 0.005 || (e.sub === "Reembolso" && (+e.valor || 0) === 0);
    const bySid = existentes.find(e => e.stripeId === stripeId);
    const porNome = e => !e.stripeId && e.dataProc === created && (sameName(e.cliente, quem) || (!part && sameName(e.cliente, name)));
    let ex = bySid || existentes.find(e => porNome(e) && valorOk(e));
    if (!ex) {
      ex = existentes.find(porNome);   // mesma pessoa e dia, valor diferente: vincula e avisa
      if (ex && !(marca && SIMULAR)) revisar.push({ tipo: "valor diferente", existente: ex.id, nome: ex.cliente, valorApp: +ex.valor || 0, valorStripe: v, stripeId });
      if (ex && marca && SIMULAR) plano.push({ acao: "aviso", tipo: "valor diferente", existente: ex.id, nome: ex.cliente, valorApp: +ex.valor || 0, valorStripe: v });
    }

    if (ex) {
      const upd = {};
      if (!ex.stripeId) { upd.stripeId = stripeId; ex.stripeId = stripeId; vinculados++; }
      if (refunded && ex.sub !== "Reembolso") { upd.sub = "Reembolso"; upd.valor = 0; reembolsos++; }
      if (marca && SIMULAR) { plano.push({ acao: "vincular", existente: ex.id, nomeExistente: ex.cliente, comprador: name, valor: v, data: created, stripeId }); continue; }
      if (Object.keys(upd).length) { batch.update(col.doc(ex.id), upd); ops++; }
    } else {
      const id = "stripe_" + stripeId.replace(/[^A-Za-z0-9_]/g, "_");
      const novo = {
        cliente, origem: origemPadrao, sub: refunded ? "Reembolso" : "Ingresso", valor: refunded ? 0 : v, taxa: f,
        conta: "Stripe", dataProc: created, dataReceb: avail, stripeId, email: email || "",
        seq: agora + novos, criadoEm: new Date().toISOString(), checkinEm: "", via,
      };
      if (bump && i === 1) novo.bump = bump;
      // Mesmo dia e valor, sem stripeId e nome diferente: pode ser a mesma pessoa com outro nome.
      const parecidos = existentes.filter(e => !e.stripeId && e.dataProc === created && Math.abs((+e.valor || 0) - v) < 0.005);
      if (parecidos.length && !(marca && SIMULAR)) revisar.push({ novo: id, nomeNovo: cliente, candidatos: parecidos.map(e => ({ id: e.id, nome: e.cliente })) });
      if (marca && SIMULAR) { plano.push({ acao: "novo", id, cliente, valor: v, data: created, bump: i === 1 ? bump : 0, parecidos: parecidos.map(e => e.cliente) }); novos++; existentes.push({ id, ...novo }); continue; }
      batch.set(col.doc(id), novo); ops++; novos++;
      existentes.push({ id, ...novo });
    }
    if (ops >= 400) await flush();
  }
}

// 3a. Vendas pelos links de pagamento do Stripe.
for (const [plid] of links) {
  const sess = await listar(p => stripe.checkout.sessions.list(p), { payment_link: plid, status: "complete", limit: 100 },
    ["data.payment_intent.latest_charge.balance_transaction"], ["data.payment_intent.latest_charge"]);
  for (const s of sess) {
    if (s.payment_status !== "paid") continue;
    const ch = s.payment_intent?.latest_charge;
    if (!ch || typeof ch !== "object") continue;
    const itens = await stripe.checkout.sessions.listLineItems(s.id, { limit: 100 });
    const qty = itens.data.reduce((t, i) => t + (i.quantity || 1), 0) || 1;
    const cd = s.customer_details || {};
    await lancar(ch, { qty, name: cd.name, email: cd.email, via: "sync-links" });
  }
}

// 3b. Vendas do checkout próprio (cobranças com metadata.brand do evento).
const marcas = (ev.marcas || []).map(m => String(m).trim().toLowerCase()).filter(Boolean);
const desde = Math.floor(new Date((ev.vendasDesde || "2026-09-01") + "T00:00:00Z").getTime() / 1000);
const resumoMarcas = {}, chavesMeta = {}, amostra = [];
const cobrancas = await listar(p => stripe.charges.list(p), { created: { gte: desde }, limit: 100 },
  ["data.balance_transaction"], []);
for (const ch of cobrancas) {
  if (ch.status !== "succeeded" || !ch.paid) continue;
  const md = ch.metadata || {};
  const b = String(md.brand || "").trim();
  const k = b || "(sem marca)";
  resumoMarcas[k] = resumoMarcas[k] || { cobrancas: 0, valores: {} };
  resumoMarcas[k].cobrancas++;
  const val = String((ch.amount || 0) / 100); resumoMarcas[k].valores[val] = (resumoMarcas[k].valores[val] || 0) + 1;
  Object.keys(md).forEach(x => { chavesMeta[x] = (chavesMeta[x] || 0) + 1; });
  if (b && marcas.includes(b.toLowerCase())) {
    const bd = ch.billing_details || {};
    // Separa o valor do ingresso do "bump" (adicional). Os campos podem vir em centavos ou em dólares.
    const num = x => { const n = parseFloat(String(x ?? "").replace(",", ".")); return isFinite(n) ? n : 0; };
    const prod = num(md.amount_product), bmp = num(md.amount_bump), desc = num(md.amount_discount);
    const totCents = ch.amount || 0;
    let fator = 0;
    if (Math.abs(prod + bmp - desc - totCents) < 2) fator = 100;
    else if (Math.abs((prod + bmp - desc) * 100 - totCents) < 2) fator = 1;
    const bump = fator ? r2(bmp * (fator === 100 ? 0.01 : 1)) : 0;
    const totalIngressos = fator ? r2(totCents / 100 - bump) : null;
    const participantes = [2, 3, 4, 5, 6, 7, 8].map(n => md["participante_" + n] || "");
    amostra.push({ total: totCents / 100, quantidade: md.quantidade || "", amount_product: md.amount_product || "", amount_bump: md.amount_bump || "",
      amount_discount: md.amount_discount || "", has_bump: md.has_bump || "", offer_id: md.offer_id || "", access_tier: md.access_tier || "", cupom: md.cupom || "",
      fator, bump, totalIngressos });
    await lancar(ch, {
      qty: md.quantidade || md.quantity || md.qtd || 1,
      name: md.customer_name || [md.lead_first_name, md.lead_last_name].filter(Boolean).join(" ") || bd.name || ch.receipt_email,
      email: md.lead_email || md.customer_email || md.email || bd.email || ch.receipt_email,
      via: "sync-checkout", totalIngressos, participantes, bump, marca: true,
    });
  }
}
await flush();
if (novos || reembolsos) await db.doc("eventos/" + EID).update({ ultimaAtividade: new Date().toISOString() });

// Relatório no banco (só quem tem PIN lê). O log do GitHub é público: lá só vão números.
const stRef = db.doc(`eventos/${EID}/sync/status`);
const anterior = (await stRef.get()).data()?.revisar || [];
const idsAtuais = new Set(existentes.map(e => e.id));
const chave = r => r.novo || ("v:" + r.stripeId);
const revisarTodos = [...anterior.filter(r => (!r.novo || idsAtuais.has(r.novo)) && !revisar.some(x => chave(x) === chave(r))), ...revisar];
await stRef.set({
  ultimaExecucao: new Date().toISOString(), vistos, novos, vinculados, reembolsos, taxaReal: comTaxaReal,
  marcasConfiguradas: marcas, marcasNoStripe: resumoMarcas, chavesMetadata: chavesMeta, revisar: revisarTodos,
  simulacao: SIMULAR ? { plano, amostra } : null,
});

console.log(`Vendas consideradas: ${vistos} · novos inscritos: ${novos} · já existentes vinculados: ${vinculados} · reembolsos: ${reembolsos}` +
  ` · para revisar: ${revisarTodos.length} · marcas no Stripe desde ${ev.vendasDesde || "2026-09-01"}: ${Object.keys(resumoMarcas).length}` +
  (comTaxaReal ? "" : " · taxa estimada") + (SIMULAR ? " · SIMULAÇÃO (checkout próprio não gravado)" : ""));
