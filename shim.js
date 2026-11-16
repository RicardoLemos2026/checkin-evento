/*
 * Camada de compatibilidade: dá ao app as mesmas funções que ele tinha dentro do claude.ai
 * (window.claude.use("db" | "user" | "downloads")), usando o Firebase (Firestore) e um PIN:
 *   - db: documentos e coleções do Firestore, com atualização em tempo real
 *   - user: permissão de edição conforme o PIN (editor ou leitura)
 *   - downloads: baixa arquivos no navegador
 * Também mostra a tela de PIN e os botões "Backup" e "Sair".
 * Depende de firebase-app-compat, firebase-auth-compat e firebase-firestore-compat (carregados antes).
 */
(function () {
  'use strict';
  var role = null, authPromise = null, fs = null, auth = null;

  function onBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  function mapErr(e) {
    if (e && typeof e === 'object') {
      var c = e.code || '';
      if (c === 'permission-denied') e.code = 'invalid_argument';
      else if (c === 'resource-exhausted') e.code = 'resource_exhausted';
      else if (c === 'unauthenticated') e.code = 'unauthenticated';
      else if (c === 'not-found') e.code = 'not_found';
      else if (c === 'unavailable' || c === 'deadline-exceeded') e.code = 'unavailable';
    }
    return e;
  }
  function wrap(p) { return Promise.resolve(p).catch(function (e) { throw mapErr(e); }); }

  var cfgPromise = fetch('evento.json', { cache: 'no-store' }).then(function (r) { return r.json(); });

  async function init() {
    if (fs) return;
    var ev = await cfgPromise;
    if (!firebase.apps.length) firebase.initializeApp(ev.firebaseConfig);
    auth = firebase.auth(); fs = firebase.firestore();
    await new Promise(function (res, rej) {
      var off = auth.onAuthStateChanged(function (u) {
        if (u) { off(); res(); } else auth.signInAnonymously().catch(function (e) { off(); rej(e); });
      });
    });
  }

  // ---------------- PIN ----------------
  var CSS = '.lg-ov{position:fixed;inset:0;z-index:99999;background:#14100d;display:grid;place-items:center;padding:20px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    '.lg-box{width:min(400px,100%);background:#1b1713;border:1px solid #322b25;border-radius:18px;padding:28px;color:#efe9e2}' +
    '.lg-logo{width:44px;height:44px;border-radius:12px;background:#f57c00;color:#fff;display:grid;place-items:center;font-weight:800;font-size:22px}' +
    '.lg-box h1{margin:14px 0 4px;font-size:22px;line-height:1.2;color:#efe9e2}.lg-box p{margin:0 0 18px;color:#a39990;font-size:14px}' +
    '.lg-box input{width:100%;box-sizing:border-box;font:inherit;font-size:22px;letter-spacing:.2em;text-align:center;padding:12px 14px;border-radius:10px;border:1px solid #322b25;background:#100d0b;color:#efe9e2}' +
    '.lg-box input:focus{outline:2px solid #f57c00;outline-offset:-1px}' +
    '.lg-box button{width:100%;margin-top:12px;font:inherit;font-weight:700;font-size:16px;padding:12px;border:0;border-radius:10px;background:#f57c00;color:#fff;cursor:pointer}' +
    '.lg-box button:disabled{opacity:.6;cursor:wait}.lg-err{min-height:20px;margin-top:10px;color:#ff7a6b;font-size:14px}' +
    '.lg-out{border:0;background:rgba(255,255,255,.1);color:#e9e2dc;font:inherit;font-size:12px;padding:5px 12px;border-radius:999px;cursor:pointer;margin-left:8px}' +
    '.lg-out:hover{background:rgba(255,255,255,.2)}.hin .chips{margin-left:auto}' +
    '.bk-ov{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}' +
    '.bk-box{width:min(480px,100%);background:#fff;color:#1d1a17;border-radius:16px;padding:22px}.bk-box h2{margin:0 0 6px;font-size:19px}' +
    '.bk-box p{color:#6b625b;font-size:14px;margin:6px 0 12px}.bk-box button{font:inherit;font-weight:650;padding:10px 14px;border-radius:10px;border:0;background:#14100d;color:#fff;cursor:pointer;margin:4px 6px 4px 0}' +
    '.bk-box button.sec{background:#efe9e3;color:#1d1a17}.bk-box hr{border:0;border-top:1px solid #eee;margin:16px 0}.bk-msg{min-height:20px;font-size:14px;margin-top:8px}' +
    '@media (max-width:600px){.hin .chips{display:none}#lgBackup{display:none}.lg-out{padding:5px 10px}}';
  onBody(function () { var s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); });

  function pinFlow(message) {
    return new Promise(function (resolve) {
      onBody(function () {
        var old = document.getElementById('lgOverlay'); if (old) old.remove();
        var ov = document.createElement('div'); ov.className = 'lg-ov'; ov.id = 'lgOverlay';
        ov.innerHTML = '<form class="lg-box" autocomplete="off"><div class="lg-logo">$</div><h1>Financeiro de Eventos</h1><p>Digite o PIN para entrar. Ele é pedido só uma vez em cada aparelho.</p>' +
          '<input type="password" id="lgPass" inputmode="numeric" placeholder="PIN" required>' +
          '<button type="submit" id="lgBtn">Entrar</button><div class="lg-err" id="lgErr" role="alert"></div></form>';
        document.body.appendChild(ov);
        var form = ov.querySelector('form'), inp = ov.querySelector('#lgPass'), btn = ov.querySelector('#lgBtn'), err = ov.querySelector('#lgErr');
        if (message) err.textContent = message;
        setTimeout(function () { inp.focus(); }, 30);
        form.addEventListener('submit', async function (e) {
          e.preventDefault(); err.textContent = ''; btn.disabled = true;
          var pin = inp.value.trim(), ref = fs.doc('acessos/' + auth.currentUser.uid);
          for (var papel of ['editor', 'leitura']) {
            try {
              await ref.set({ pin: pin, papel: papel, em: new Date().toISOString() });
              role = papel; ov.remove(); addButtons(); resolve(); return;
            } catch (ex) {
              if (ex && ex.code !== 'permission-denied') { err.textContent = 'Sem conexão. Tente de novo.'; btn.disabled = false; return; }
            }
          }
          err.textContent = 'PIN incorreto.'; btn.disabled = false; inp.select();
        });
      });
    });
  }

  function ensureAuth() {
    if (role) return Promise.resolve();
    if (authPromise) return authPromise;
    authPromise = (async function () {
      try { await init(); } catch (e) {
        console.error(e);
        onBody(function () { document.body.insertAdjacentHTML('afterbegin', '<div style="background:#c0392b;color:#fff;padding:10px;text-align:center">Sem conexão com o banco de dados. Recarregue a página.</div>'); });
        throw e;
      }
      var snap = null;
      try { snap = await fs.doc('acessos/' + auth.currentUser.uid).get(); } catch (e) { snap = null; }
      var p = snap && snap.exists ? (snap.data() || {}).papel : null;
      if (p === 'editor' || p === 'leitura') { role = p; addButtons(); return; }
      await pinFlow('');
    })();
    return authPromise;
  }

  function addButtons() {
    onBody(function tryAdd() {
      if (!role || document.getElementById('lgOut')) return;
      var host = document.querySelector('.hin');
      if (!host) { setTimeout(tryAdd, 300); return; }
      if (role === 'editor') {
        var k = document.createElement('button'); k.id = 'lgBackup'; k.className = 'lg-out'; k.textContent = 'Backup';
        k.onclick = backupDialog; host.appendChild(k);
      }
      var b = document.createElement('button'); b.id = 'lgOut'; b.className = 'lg-out'; b.textContent = 'Sair';
      b.title = 'Sair deste aparelho (vai pedir o PIN de novo)';
      b.onclick = async function () { try { await auth.signOut(); } catch (e) { } location.reload(); };
      host.appendChild(b);
    });
  }

  // ---------------- backup ----------------
  var SUBCOLS = ['inscritos', 'gastos', 'almoco_despesas', 'almoco'];
  async function exportAll() {
    var out = [];
    var evs = await fs.collection('eventos').get();
    for (var e of evs.docs) {
      out.push({ path: 'eventos/' + e.id, data: e.data() });
      for (var c of SUBCOLS) {
        var s = await fs.collection('eventos/' + e.id + '/' + c).get();
        s.docs.forEach(function (d) { out.push({ path: 'eventos/' + e.id + '/' + c + '/' + d.id, data: d.data() }); });
      }
    }
    return { app: 'financeiro-eventos', formato: 1, exportadoEm: new Date().toISOString().slice(0, 10), docs: out };
  }
  async function importDocs(content, replace, progress) {
    var docs = Array.isArray(content) ? content : content && content.docs;
    if (!Array.isArray(docs)) throw new Error('Formato inesperado: esperava { "docs": [ { "path", "data" } ] }.');
    var added = 0, replaced = 0, skipped = 0, invalid = 0;
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i], segs = typeof d.path === 'string' ? d.path.split('/') : [];
      if (segs[0] !== 'eventos' || segs.length < 2 || segs.length % 2 || !d.data || typeof d.data !== 'object' || Array.isArray(d.data)) { invalid++; continue; }
      var ref = fs.doc(d.path), ex = await ref.get();
      if (ex.exists && !replace) { skipped++; continue; }
      await ref.set(JSON.parse(JSON.stringify(d.data)));
      if (ex.exists) replaced++; else added++;
      if (progress) progress(i + 1, docs.length);
    }
    return { added: added, replaced: replaced, skipped: skipped, invalid: invalid };
  }
  function backupDialog() {
    var ov = document.createElement('div'); ov.className = 'bk-ov';
    ov.innerHTML = '<div class="bk-box"><h2>Backup</h2><p>Baixe um arquivo com todos os eventos, inscritos, gastos e almoço. Faça antes e depois de cada evento.</p>' +
      '<button id="bkDown">Baixar backup (.json)</button><hr><h2>Importar dados</h2>' +
      '<p>Escolha um backup ou o arquivo <b>dados_atuais.json</b>. Por padrão, o que já existe não é alterado.</p>' +
      '<input type="file" id="bkFile" accept=".json,application/json"><p><label><input type="checkbox" id="bkRep"> Substituir os registros que já existem</label></p>' +
      '<button id="bkImp">Importar</button><button class="sec" id="bkClose">Fechar</button><div class="bk-msg" id="bkMsg"></div></div>';
    document.body.appendChild(ov);
    var msg = ov.querySelector('#bkMsg');
    ov.querySelector('#bkClose').onclick = function () { ov.remove(); };
    ov.querySelector('#bkDown').onclick = async function () {
      msg.textContent = 'Gerando…';
      try {
        var data = await exportAll();
        await dlApi.save({ filename: 'backup-financeiro-' + data.exportadoEm + '.json', data: JSON.stringify(data, null, 1) });
        msg.textContent = data.docs.length + ' registros no arquivo.';
      } catch (e) { console.error(e); msg.textContent = 'Não foi possível gerar o backup.'; }
    };
    ov.querySelector('#bkImp').onclick = async function () {
      var f = ov.querySelector('#bkFile').files[0]; if (!f) { msg.textContent = 'Escolha um arquivo.'; return; }
      var rep = ov.querySelector('#bkRep').checked;
      try {
        var content = JSON.parse(await f.text());
        var r = await importDocs(content, rep, function (a, b) { msg.textContent = 'Importando… ' + a + '/' + b; });
        msg.textContent = 'Concluído: ' + r.added + ' novos, ' + r.replaced + ' substituídos, ' + r.skipped + ' já existiam, ' + r.invalid + ' inválidos.';
      } catch (e) { console.error(e); msg.textContent = 'Falhou: ' + (e.message || e); }
    };
  }

  // ---------------- banco ----------------
  function docRef(path) {
    var r = fs.doc(path);
    return {
      id: r.id, path: path,
      get: function () { return wrap(r.get()); },
      set: function (d) { return wrap(r.set(d)); },
      update: function (d) { return wrap(r.update(d)); },
      delete: function () { return wrap(r.delete()); },
      onSnapshot: function (cb, err) { return r.onSnapshot(cb, function (e) { if (err) err(mapErr(e)); else console.error(e); }); }
    };
  }
  function colRef(path) {
    var c = fs.collection(path);
    return {
      path: path,
      doc: function (id) { return docRef(id ? path + '/' + id : c.doc().path); },
      add: function (d) { return wrap(c.add(d)).then(function (ref) { return docRef(ref.path); }); },
      get: function () { return wrap(c.get()); },
      onSnapshot: function (cb, err) { return c.onSnapshot(cb, function (e) { if (err) err(mapErr(e)); else console.error(e); }); }
    };
  }
  var dbApi = { doc: docRef, collection: colRef };

  var userApi = {
    can: async function () { return role === 'editor'; },
    isOwner: async function () { return role === 'editor'; },
    canEdit: async function () { return role === 'editor'; },
    role: function () { return role; }
  };

  var MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv;charset=utf-8', json: 'application/json', pdf: 'application/pdf', txt: 'text/plain;charset=utf-8' };
  var dlApi = {
    save: async function (req) {
      var name = String((req && req.filename) || 'arquivo').replace(/[\\/:*?"<>|]+/g, '_');
      var ext = name.split('.').pop().toLowerCase();
      var blob = new Blob([req.data], { type: MIME[ext] || 'application/octet-stream' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return { status: 'saved' };
    }
  };

  window.claude = {
    use: async function (name) {
      await ensureAuth();
      if (name === 'db') return dbApi;
      if (name === 'user') return userApi;
      if (name === 'downloads') return dlApi;
      return null;
    }
  };
  window.__fin = { exportAll: function () { return ensureAuth().then(exportAll); }, importDocs: function (c, r) { return ensureAuth().then(function () { return importDocs(c, r); }); } };
})();
