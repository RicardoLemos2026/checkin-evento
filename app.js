import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, increment,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

const S = { ev: null, db: null, uid: null, ins: [], q: "", f: "todos", focus: false, pend: false };
let fmtHora;

/* ---------- utilidades de tela ---------- */
let tTimer;
function toast(msg, undo) {
  const t = $("#toast");
  t.innerHTML = esc(msg) + (undo ? ' <button id="tUndo">Desfazer</button>' : "");
  t.classList.add("on");
  if (undo) $("#tUndo").onclick = () => { t.classList.remove("on"); undo(); };
  clearTimeout(tTimer); tTimer = setTimeout(() => t.classList.remove("on"), undo ? 5000 : 2500);
}
const hora = iso => (iso ? fmtHora.format(new Date(iso)) : "");
async function safe(fn, okMsg, undo) {
  try { await fn(); if (okMsg) toast(okMsg, undo); }
  catch (e) { console.error(e); toast(e?.code === "permission-denied" ? "Sem permissão. Recarregue a página." : "Não salvou. Confira a internet e tente de novo."); }
}

/* ---------- início ---------- */
async function boot() {
  try {
    S.ev = await (await fetch("evento.json", { cache: "no-store" })).json();
  } catch { app.innerHTML = '<div class="center">Não consegui ler a configuração do evento.</div>'; return; }
  fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: S.ev.fuso || undefined });
  document.title = "Check-in · " + S.ev.nome;
  $("#tit").textContent = S.ev.nome;
  const [y, m, d] = (S.ev.data || "").split("-");
  $("#sub").textContent = d ? `Check-in · ${d}/${m}/${y}` : "Check-in";

  const fb = initializeApp(S.ev.firebaseConfig);
  const auth = getAuth(fb);
  S.db = getFirestore(fb);
  onAuthStateChanged(auth, async user => {
    if (!user) { signInAnonymously(auth).catch(e => { console.error(e); app.innerHTML = '<div class="center">Sem conexão. Recarregue a página.</div>'; }); return; }
    S.uid = user.uid;
    let ok = false;
    try { ok = (await getDoc(doc(S.db, "acessos", user.uid))).exists(); } catch { ok = false; }
    ok ? start() : pinScreen();
  });
}

function pinScreen() {
  app.innerHTML = `<div class="center"><div>
    <div style="font-size:18px;font-weight:650">Digite o PIN da recepção</div>
    <input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12">
    <div class="err" id="perr"></div>
    <button class="btn dark" id="pgo">Entrar</button>
    <div class="foot">O PIN é pedido só uma vez em cada aparelho.</div></div></div>`;
  const go = async () => {
    const pin = $("#pin").value.trim();
    if (!pin) return;
    $("#pgo").disabled = true; $("#perr").textContent = "";
    try {
      await setDoc(doc(S.db, "acessos", S.uid), { pin, em: new Date().toISOString() });
      start();
    } catch (e) {
      console.error(e);
      $("#perr").textContent = e?.code === "permission-denied" ? "PIN incorreto." : "Sem conexão. Tente de novo.";
      $("#pgo").disabled = false;
    }
  };
  $("#pgo").onclick = go;
  $("#pin").onkeydown = e => { if (e.key === "Enter") go(); };
  $("#pin").focus();
}

function start() {
  app.innerHTML = `
    <div class="kpis">
      <div class="kpi ok"><div class="l">Presentes</div><div class="v" id="kIn">0</div></div>
      <div class="kpi"><div class="l">Faltam</div><div class="v" id="kOut">0</div></div>
      <div class="kpi"><div class="l">Inscritos</div><div class="v" id="kTot">0</div></div>
    </div>
    <div class="search">
      <input id="q" type="search" placeholder="Buscar nome ou e-mail" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="tabs">
        <button data-f="todos">Todos</button><button data-f="faltam">Faltam</button><button data-f="presentes">Presentes</button>
      </div>
    </div>
    <div class="list" id="list"></div>
    <div class="foot" id="foot"></div>
    <button class="fab" id="add">+ Adicionar</button>`;
  $("#q").oninput = e => { S.q = e.target.value; draw(); };
  document.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.f = b.dataset.f; draw(); });
  $("#add").onclick = () => addDialog();
  $("#list").onclick = onListClick;

  onSnapshot(collection(S.db, "inscritos"), snap => {
    S.ins = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    draw();
  }, e => { console.error(e); toast("Perdeu a conexão com a lista. Recarregue a página."); });
}

/* ---------- lista ---------- */
const ativos = () => S.ins.filter(r => r.status !== "reembolsado");
const qtdDe = r => Math.max(1, +r.qtd || 1);
const chk = r => Math.min(qtdDe(r), Math.max(0, +r.checkins || 0));

function draw() {
  const all = ativos();
  const tot = all.reduce((t, r) => t + qtdDe(r), 0);
  const inn = all.reduce((t, r) => t + chk(r), 0);
  $("#kIn").textContent = inn; $("#kOut").textContent = tot - inn; $("#kTot").textContent = tot;
  document.querySelectorAll("[data-f]").forEach(b => b.classList.toggle("on", b.dataset.f === S.f));

  const q = norm(S.q);
  let rows = all.filter(r => !q || norm(r.nome + " " + (r.email || "") + " " + (r.comprador || "")).includes(q));
  if (S.f === "faltam") rows = rows.filter(r => chk(r) < qtdDe(r));
  if (S.f === "presentes") rows = rows.filter(r => chk(r) > 0);
  rows.sort(S.f === "presentes"
    ? (a, b) => String(b.checkinUlt || b.checkinEm).localeCompare(String(a.checkinUlt || a.checkinEm))
    : (a, b) => norm(a.nome).localeCompare(norm(b.nome)));

  $("#list").innerHTML = rows.length ? rows.map(rowHtml).join("") :
    `<div class="empty">${q ? "Ninguém com esse nome. Use <b>+ Adicionar</b> para cadastrar." : "Lista vazia."}</div>`;
  const reemb = S.ins.length - all.length;
  $("#foot").textContent = `${all.length} cadastro(s)` + (reemb ? ` · ${reemb} reembolsado(s) fora da lista` : "");
}

function rowHtml(r) {
  const q = qtdDe(r), c = chk(r), full = c >= q;
  const tags = [
    r.origem === "manual" ? '<span class="tag man">Manual</span>' : (r.rotulo ? `<span class="tag">${esc(r.rotulo)}</span>` : ""),
    q > 1 ? `<span class="tag qtd">${q} ingressos</span>` : "",
    r.reembolsoParcial ? '<span class="tag warn">Reembolso parcial</span>' : "",
  ].join("");
  const meta = [r.email, r.comprador && norm(r.comprador) !== norm(r.nome) ? "comprador: " + r.comprador : ""].filter(Boolean).map(esc).join(" · ");
  const right = full
    ? `<span class="okmark">✓ ${esc(hora(r.checkinUlt || r.checkinEm))}${q > 1 ? ` · ${c}/${q}` : ""}</span><button class="btn ghost" data-un="${esc(r.id)}">desfazer</button>`
    : `<button class="btn go" data-ck="${esc(r.id)}">${q > 1 ? `Chegou ${c + 1}/${q}` : "Chegou"}</button>` +
      (c > 0 ? `<button class="btn ghost" data-un="${esc(r.id)}">desfazer (${c}/${q})</button>` : "");
  const edit = r.origem === "manual" ? ` <button class="btn ghost" data-ed="${esc(r.id)}" style="padding:0 4px">editar</button>` : "";
  return `<div class="row${full ? " done" : ""}"><div class="info"><div class="nm">${esc(r.nome)}</div>
    <div class="meta">${tags}${meta}${edit}</div></div><div class="right">${right}</div></div>`;
}

function onListClick(e) {
  const b = e.target.closest("button"); if (!b) return;
  const find = id => S.ins.find(r => r.id === id);
  if (b.dataset.ck) { const r = find(b.dataset.ck); if (r) checkin(r, b); }
  else if (b.dataset.un) { const r = find(b.dataset.un); if (r) undoCheckin(r); }
  else if (b.dataset.ed) { const r = find(b.dataset.ed); if (r) addDialog(r); }
}

function checkin(r, btn) {
  if (chk(r) >= qtdDe(r)) return;
  if (btn) btn.disabled = true;
  const now = new Date().toISOString();
  const data = { checkins: increment(1), checkinUlt: now };
  if (!r.checkinEm) data.checkinEm = now;
  safe(() => updateDoc(doc(S.db, "inscritos", r.id), data), `✓ ${r.nome}`, () => undoCheckin(r, true));
  if (S.q) { S.q = ""; $("#q").value = ""; draw(); }
}

function undoCheckin(r, silent) {
  const cur = S.ins.find(x => x.id === r.id) || r;
  const c = chk(cur); if (c <= 0) return;
  const data = { checkins: increment(-1) };
  if (c - 1 === 0) { data.checkinEm = ""; data.checkinUlt = ""; }
  safe(() => updateDoc(doc(S.db, "inscritos", r.id), data), silent ? "Check-in desfeito" : `Desfeito: ${r.nome}`);
}

/* ---------- adicionar / editar ---------- */
function addDialog(rec) {
  const dlg = $("#dlg");
  let modo = "um";
  const render = () => {
    dlg.innerHTML = `<form method="dialog" class="dlg">
      <h2>${rec ? "Editar cadastro" : "Adicionar"}</h2>
      ${rec ? "" : `<div class="seg"><button type="button" data-m="um" class="${modo === "um" ? "on" : ""}">Uma pessoa</button>
        <button type="button" data-m="lista" class="${modo === "lista" ? "on" : ""}">Lista de nomes</button></div>`}
      ${modo === "um" ? `
        <label>Nome</label><input id="fNome" required value="${esc(rec?.nome || (S.q || ""))}">
        <label>E-mail (opcional)</label><input id="fEmail" type="email" value="${esc(rec?.email || "")}">
        <label>Quantidade de ingressos</label><input id="fQtd" type="number" min="1" max="20" value="${esc(rec?.qtd || 1)}">
        <label>Observação (ex.: mentorado, convidado)</label><input id="fObs" value="${esc(rec?.obs || "")}">
        ${rec ? "" : '<label class="chk"><input type="checkbox" id="fCk" checked> Fazer check-in agora</label>'}`
      : `<label>Um nome por linha (pode colar de uma planilha). Para incluir e-mail: Nome ; e-mail</label>
        <textarea id="fLista" placeholder="Maria Silva&#10;João Souza ; joao@email.com"></textarea>
        <label>Observação para todos (ex.: mentorado)</label><input id="fObsL" value="Mentorado">`}
      <div class="act">
        ${rec ? '<button type="button" class="btn ghost" id="fDel" style="color:#c0392b">Excluir</button>' : ""}
        <button type="button" class="btn ghost" id="fCancel">Cancelar</button>
        <button type="submit" class="btn dark" id="fOk">Salvar</button>
      </div></form>`;
    dlg.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { modo = b.dataset.m; render(); });
    $("#fCancel").onclick = () => dlg.close();
    if (rec) $("#fDel").onclick = () => {
      if (!confirm(`Excluir ${rec.nome} da lista?`)) return;
      dlg.close(); safe(() => deleteDoc(doc(S.db, "inscritos", rec.id)), "Excluído");
    };
    dlg.querySelector("form").onsubmit = e => { e.preventDefault(); save(); };
  };
  const save = () => {
    const now = new Date().toISOString();
    if (modo === "lista") {
      const obs = $("#fObsL").value.trim();
      const linhas = $("#fLista").value.split(/\r?\n/).map(l => l.split(/[;\t]/).map(x => x.trim())).filter(p => p[0]);
      if (!linhas.length) return;
      const existe = new Set(S.ins.map(r => norm(r.nome)));
      const novos = linhas.filter(p => !existe.has(norm(p[0])));
      dlg.close();
      safe(async () => {
        for (const [nome, email] of novos) await addDoc(collection(S.db, "inscritos"), base(nome, email || "", 1, obs, now));
      }, `${novos.length} adicionado(s)` + (linhas.length > novos.length ? ` · ${linhas.length - novos.length} já estavam na lista` : ""));
      return;
    }
    const nome = $("#fNome").value.trim(); if (!nome) return;
    const email = $("#fEmail").value.trim(), qtd = Math.max(1, Math.min(20, +$("#fQtd").value || 1)), obs = $("#fObs").value.trim();
    dlg.close();
    if (rec) {
      const data = { nome, email, qtd, obs };
      if (chk(rec) > qtd) data.checkins = qtd;
      safe(() => updateDoc(doc(S.db, "inscritos", rec.id), data), "Salvo");
    } else {
      const d = base(nome, email, qtd, obs, now);
      if ($("#fCk").checked) { d.checkins = 1; d.checkinEm = now; d.checkinUlt = now; }
      if (S.q) { S.q = ""; $("#q").value = ""; }
      safe(() => addDoc(collection(S.db, "inscritos"), d), d.checkins ? `✓ ${nome} cadastrado e presente` : `${nome} cadastrado`);
    }
  };
  render();
  dlg.showModal();
  setTimeout(() => (dlg.querySelector("#fNome") || dlg.querySelector("#fLista"))?.focus(), 50);
}

const base = (nome, email, qtd, obs, now) => ({
  nome, email, telefone: "", qtd, obs, origem: "manual", status: "ativo", rotulo: "",
  checkins: 0, checkinEm: "", checkinUlt: "", criadoEm: now,
});

boot();
