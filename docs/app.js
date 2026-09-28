/* Monitor de cheias: painel estático que lê dados/<cidade>.json */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, casas = 2) =>
    n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const pct = (p) => (p == null ? "–" : p < 0.01 && p > 0 ? "<1%" : `${Math.round(p * 100)}%`);
  const dataLocal = (s) => new Date(s.length <= 10 ? `${s}T12:00` : s);
  const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const naDia = (s) => { const d = dataLocal(s).getDay(); return `${d === 0 || d === 6 ? "no" : "na"} ${SEMANA[d]}`; };
  const SEMANA_CURTA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const dataCurta = (s) => dataLocal(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const dataLonga = (s) => dataLocal(s).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" });
  const hora = (s) => s.slice(11, 16);
  const css = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();

  let D = null;
  const graficos = {};

  // ------------------------------------------------------------ dados
  async function carregar() {
    if (window.__DADOS__) return window.__DADOS__;
    const params = new URLSearchParams(location.search);
    let cidades = [];
    try {
      const r = await fetch("dados/indice.json", { cache: "no-cache" });
      if (r.ok) cidades = (await r.json()).cidades || [];
    } catch (_) { /* sem índice: usa ?cidade= */ }
    const slug = params.get("cidade") || cidades[0]?.slug;
    if (!slug) throw new Error("Nenhuma cidade publicada ainda. Rode o coletor para gerar docs/dados/<cidade>.json.");
    if (cidades.length > 1) montarSeletor(cidades, slug);
    const r = await fetch(`dados/${encodeURIComponent(slug)}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Não encontrei os dados de "${slug}". Confira o nome da cidade no endereço.`);
    return r.json();
  }

  function montarSeletor(cidades, atual) {
    const sel = $("#seletor-cidade");
    sel.innerHTML = cidades.map((c) => `<option value="${esc(c.slug)}"${c.slug === atual ? " selected" : ""}>${esc(c.nome)}</option>`).join("");
    $("#seletor-cidade-rotulo").hidden = false;
    sel.addEventListener("change", () => {
      const u = new URL(location.href);
      u.searchParams.set("cidade", sel.value);
      location.href = u.toString();
    });
  }

  // ------------------------------------------------------------ faixas
  const faixas = () => [...D.config.cotas.faixas].sort((a, b) => a.cota - b.cota);
  function statusDe(nivel) {
    let s = { id: "normal", nome: "Normal", cota: null };
    for (const f of faixas()) if (nivel >= f.cota) s = f;
    return s;
  }
  const corStatus = (id) => css(`--${id}`) || css("--agua");
  const inundacao = () => D.config.cotas.inundacao;

  // ------------------------------------------------------------ topo
  const horaCurta = (s) => { const [h, m] = hora(s).split(":"); return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`; };
  const minutosDesde = (s) => Math.max(0, Math.round((Date.now() - dataLocal(s).getTime()) / 60000));

  function renderTopo() {
    const c = D.config;
    document.title = `${c.nome_app}: ${c.rio} em ${c.local}`;
    $("#nome-app").textContent = c.nome_app;
    $("#local").textContent = `${c.rio}, ${c.local}`;
    $("#demo-aviso").hidden = !D.demo;
    const st = statusDe(D.atual.nivel);
    const t = D.atual.tendencia_cm_h;
    const seta = t == null || Math.abs(t) < 0.5 ? "→" : t < 0 ? "↓" : "↑";
    const tarja = $("#tarja-nivel");
    tarja.dataset.status = st.id;
    tarja.innerHTML = `${fmt(D.atual.nivel)} m ${seta} <span class="faixa">${esc(st.nome)}</span>`;
    tarja.setAttribute("aria-label", `Nível do rio: ${fmt(D.atual.nivel)} metros, ${st.nome}`);

    const quando = dataLocal(D.atual.hora);
    const el = $("#boletim-hora");
    let texto = `Boletim das ${horaCurta(D.atual.hora)} de ${SEMANA[quando.getDay()]}, ${dataCurta(D.atual.hora)}. Estação ANA ${c.estacao.codigo}.`;
    const minutos = minutosDesde(D.atual.hora);
    el.classList.remove("velho");
    if (D.demo) texto += " Dados fictícios de demonstração.";
    else if (minutos > 120) {
      el.classList.add("velho");
      texto += ` A última leitura tem ${minutos < 2880 ? `${Math.round(minutos / 60)} horas` : `${Math.round(minutos / 1440)} dias`}: a estação pode estar sem transmitir.`;
    }
    el.textContent = texto;
  }

  // ------------------------------------------------------------ agora
  function textoTendencia(t) {
    if (t == null) return ["Tendência indisponível", ""];
    if (Math.abs(t) < 0.5) return ["Estável", "estavel"];
    return t < 0 ? [`Baixando ${fmt(Math.abs(t), 1)} cm/h`, "desce"] : [`Subindo ${fmt(t, 1)} cm/h`, "sobe"];
  }

  function diagnostico() {
    const n = D.atual.nivel;
    const cotaInund = inundacao();
    const partes = [];
    if (cotaInund != null && n < cotaInund) {
      partes.push(`Faltam <strong>${fmt(cotaInund - n)} m</strong> para a cota de inundação (${fmt(cotaInund)} m).`);
    } else if (cotaInund != null) {
      partes.push(`O rio está <strong>${fmt(n - cotaInund)} m acima</strong> da cota de inundação (${fmt(cotaInund)} m).`);
    }
    const t = D.atual.tendencia_cm_h;
    const proxima = faixas().find((f) => f.cota > n);
    if (t != null && t > 0.5 && proxima) {
      const horas = ((proxima.cota - n) * 100) / t;
      if (horas <= 48) partes.push(`No ritmo atual, chega a ${proxima.nome.toLowerCase()} (${fmt(proxima.cota)} m) em cerca de ${Math.max(1, Math.round(horas))} h.`);
    }
    const amanha = D.previsao_dias[1];
    if (amanha?.min != null) partes.push(`Previsão para amanhã: entre ${fmt(amanha.min)} e ${fmt(amanha.max)} m.`);
    return partes.join(" ");
  }

  function renderSpark() {
    const serie = D.serie_horaria.slice(-25);
    const svg = $("#spark");
    if (serie.length < 2) { svg.innerHTML = ""; return; }
    const vals = serie.map((p) => p[1]);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 0.2) { const m = (max + min) / 2; min = m - 0.1; max = m + 0.1; }
    const x = (i) => (i / (serie.length - 1)) * 300;
    const y = (v) => 58 - ((v - min) / (max - min)) * 52;
    const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg.innerHTML = `<path class="area" d="${d}L300,64L0,64Z"/><path class="linha" d="${d}"/>`;
    svg.setAttribute("aria-label", `Nível nas últimas 24 horas: de ${fmt(vals[0])} m para ${fmt(vals.at(-1))} m`);
  }

  function estadoRio() {
    const t = D.atual.tendencia_cm_h;
    if (t == null || Math.abs(t) < 0.5) return "estável";
    const v = Math.abs(t);
    return (t < 0 ? "baixando" : "subindo") + (v >= 3 ? " rápido" : v < 1.5 ? " devagar" : "");
  }

  function manchete() {
    const c = D.config, n = D.atual.nivel, cota = inundacao();
    const estado = estadoRio();
    const acima = cota != null && n >= cota;
    const titulo = acima ? `O ${c.rio} está acima da cota de inundação e ${estado}.` : `O ${c.rio} está ${estado}.`;
    const dias = D.previsao_dias.slice(1);
    const maior = (arr) => arr.reduce((a, b) => ((b.prob_inundacao ?? 0) > (a.prob_inundacao ?? 0) ? b : a), arr[0]);
    // porcentagem só até 3 dias à frente; depois disso a chuva prevista erra demais
    const perto = maior(dias.slice(0, 3)), longe = maior(dias.slice(3));
    const pPerto = perto?.prob_inundacao ?? 0, pLonge = longe?.prob_inundacao ?? 0;
    let sub;
    if (acima) sub = "Quem mora em área de risco deve seguir as orientações da Defesa Civil: <strong>199</strong>.";
    else if (pPerto >= 0.2) sub = `<strong>Pode passar da cota de inundação (${fmt(cota)} m) ${naDia(perto.data)}</strong>: chance de ${pct(pPerto)}, contando com a chuva prevista.`;
    else if (pLonge >= 0.3) sub = `Sem risco nos próximos 3 dias. <strong>Pode subir ${naDia(longe.data)}</strong>, se a chuva prevista se confirmar. A previsão fica mais segura nos próximos dias.`;
    else if (pPerto >= 0.05 || pLonge >= 0.1) sub = "Risco baixo de inundação nos próximos dias.";
    else sub = "Sem risco de inundação previsto para os próximos 7 dias.";
    return [titulo, sub];
  }

  function renderAgora() {
    const a = D.atual;
    const st = statusDe(a.nivel);
    const [m, sub] = manchete();
    $("#manchete").textContent = m;
    $("#submanchete").innerHTML = sub;
    $("#nivel-valor").textContent = fmt(a.nivel);
    $("#leitura").dataset.status = st.id;
    const carimbo = $("#carimbo");
    carimbo.dataset.status = st.id;
    carimbo.textContent = st.nome;
    const [tend] = textoTendencia(a.tendencia_cm_h);
    const cota = inundacao();
    const falta = cota != null && a.nivel < cota ? ` Faltam ${fmt(cota - a.nivel)} m para a cota de inundação (${fmt(cota)} m).` : "";
    $("#tendencia").textContent = `${tend}.${falta}`;
    renderSpark();

    const tbody = $("#chuva-tabela tbody");
    tbody.innerHTML = a.chuva_pontos.map((p) => `<tr><td>${esc(p.nome)}</td><td>${fmt(p.h24, 1)} mm</td><td>${fmt(p.h72, 1)} mm</td></tr>`).join("");
    $("#chuva-tabela").hidden = !a.chuva_pontos.length;

    const canal = (D.config.alertas || {}).telegram_canal;
    const link = $("#link-alertas");
    if (canal) { link.href = `https://t.me/${canal.replace(/^@/, "")}`; link.hidden = false; }

    montarLocais();
    renderLocal();
    renderRegua();
  }

  // ------------------------------------------------------------ onde eu moro
  const chaveLocal = () => `regua-viva:${D.config.slug}:local`;
  function listaLocais() {
    const locais = (D.config.locais || []).filter((x) => x.nome && x.cota != null);
    if (locais.length) return locais;
    return (D.config.regua || []).filter((x) => x.cota != null).map((x) => ({ nome: x.titulo, cota: x.cota }));
  }
  function localEscolhido() {
    try {
      const nome = localStorage.getItem(chaveLocal());
      return listaLocais().find((x) => x.nome === nome) || null;
    } catch (_) {
      return null;
    }
  }
  function montarLocais() {
    const sel = $("#local-select");
    const locais = [...listaLocais()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    sel.innerHTML = `<option value="">Escolha sua rua, bairro ou ponte</option>` +
      locais.map((x) => `<option value="${esc(x.nome)}">${esc(x.nome)} (${fmt(x.cota)} m)</option>`).join("");
    const e = localEscolhido();
    if (e) sel.value = e.nome;
  }
  function renderLocal() {
    const e = localEscolhido();
    const el = $("#local-resultado");
    el.classList.remove("perigo");
    if (!e) {
      el.textContent = "Escolha um lugar para saber a partir de que nível a água chega lá e se a previsão indica risco. A escolha fica guardada só neste aparelho.";
      return;
    }
    const n = D.atual.nivel;
    if (n >= e.cota) {
      el.classList.add("perigo");
      el.innerHTML = `<strong>O rio já passou do nível em que ${esc(e.nome)} é atingido (${fmt(e.cota)} m).</strong> Siga as orientações da Defesa Civil: 199.`;
      return;
    }
    const chave = Number(e.cota).toFixed(2);
    const dias = D.previsao_dias.slice(1);
    const melhor = dias.reduce((a, d) => ((d.prob_cotas?.[chave] ?? 0) > (a.prob_cotas?.[chave] ?? 0) ? d : a), dias[0]);
    const p = melhor?.prob_cotas?.[chave];
    const perto = dias.slice(0, 3).reduce((a, d) => ((d.prob_cotas?.[chave] ?? 0) > (a.prob_cotas?.[chave] ?? 0) ? d : a), dias[0]);
    const pPerto = perto?.prob_cotas?.[chave] ?? 0;
    let previsao = "";
    if (p != null && p < 0.05) previsao = " Pela previsão, a água não chega lá nos próximos 7 dias.";
    else if (pPerto >= 0.05) previsao = ` Chance de chegar lá nos próximos 3 dias: <strong>${pct(pPerto)}</strong>, maior ${naDia(perto.data)}.`;
    else if (p != null && p >= 0.2) previsao = ` Nos próximos 3 dias, não. Depois, <strong>pode chegar lá se a chuva prevista se confirmar</strong>; a previsão fica mais segura mais perto da data.`;
    else if (p != null) previsao = " Risco baixo nos próximos 7 dias.";
    el.innerHTML = `<strong>${esc(e.nome)}</strong> começa a ser atingido com ${fmt(e.cota)} m. O rio está <strong>${fmt(e.cota - n)} m abaixo</strong> disso.${previsao}`;
    if (pPerto >= 0.2) el.classList.add("perigo");
  }

  // ------------------------------------------------------------ régua
  function renderRegua() {
    const el = $("#regua");
    const cfg = D.config;
    const atual = D.atual.nivel;
    const itens = [...(cfg.regua || [])].sort((a, b) => a.cota - b.cota);
    const topo = Math.max(cfg.cotas.maximo_regua || 0, ...itens.map((i) => i.cota + 0.6), atual + 1);
    let base = Math.max(0, Math.floor(Math.min(itens[0]?.cota ?? atual, atual) - 1));
    const estreito = el.clientWidth < 420;
    const X = estreito ? 84 : 104; // onde começam os rótulos
    const GAP = 6;
    const statusAtual = statusDe(atual).id;

    el.innerHTML = "";
    const agua = document.createElement("div");
    agua.className = "regua-agua";
    el.appendChild(agua);

    const idxAgora = itens.reduce((acc, it, i) => (it.cota <= atual ? i : acc), -1);
    const marcos = itens.map((it, i) => {
      const m = document.createElement("div");
      m.className = "marco";
      if (it.cota <= atual) m.classList.add("atingido");
      if (i === idxAgora) { m.classList.add("marco-atual"); m.dataset.status = statusAtual; }
      const prox = itens[i + 1];
      m.innerHTML =
        `<div><span class="marco-cota">${fmt(it.cota)} m</span><span class="marco-titulo">${esc(it.titulo)}</span>` +
        (i === idxAgora ? `<span class="marco-agora-tag">O rio está aqui</span>` : "") +
        `</div>${it.texto ? `<p class="marco-texto">${esc(it.texto)}</p>` : ""}` +
        (i === idxAgora && prox ? `<p class="marco-proximo">Próximo marco (${fmt(prox.cota)} m): ${esc(prox.titulo)}. Faltam ${fmt(prox.cota - atual)} m.</p>` : "");
      m.style.left = `${X}px`;
      m.style.top = "0px";
      el.appendChild(m);
      return { it, m };
    });

    // Escala linear (a régua continua "em escala"). Se os marcos acima ou abaixo
    // da água não couberem no espaço proporcional, abre espaço extra no topo ou
    // estende a régua para baixo, em vez de deixar rótulos cruzarem a linha d'água.
    const acima = marcos.filter((o) => o.it.cota > atual);
    const abaixo = marcos.filter((o) => o.it.cota <= atual);
    const somaGrupo = (g) => g.reduce((s, o) => s + o.m.offsetHeight + GAP, 0);
    const H0 = Math.max(window.innerWidth < 560 ? 640 : 700, Math.ceil(somaGrupo(marcos) * 1.15) + 60);
    const PAD = 14, FOLGA_SUP = 30, FOLGA_INF = 10;
    const escala = (H0 - 2 * PAD) / (topo - base); // px por metro
    const extraTopo = Math.max(0, somaGrupo(acima) + FOLGA_SUP - (PAD + (topo - atual) * escala));
    const y = (c) => PAD + extraTopo + (topo - c) * escala;
    const yAgua = y(atual);
    const H = Math.ceil(Math.max(H0 + extraTopo, yAgua + FOLGA_INF + somaGrupo(abaixo) + PAD));
    base = Math.max(0, topo - (H - 2 * PAD - extraTopo) / escala); // régua desce até o fim da área
    el.style.height = `${H}px`;
    agua.style.top = `${yAgua}px`;
    const rotuloAgua = document.createElement("span");
    rotuloAgua.className = "regua-agua-rotulo";
    rotuloAgua.textContent = `Agora: ${fmt(atual)} m`;
    rotuloAgua.style.top = `${yAgua}px`;
    rotuloAgua.style.left = `${X}px`;
    el.appendChild(rotuloAgua);

    // distribui rótulos sem sobreposição; quem já foi atingido fica abaixo da linha d'água
    function distribuir(grupo, limiteSup, limiteInf) {
      const g = [...grupo].sort((a, b) => b.it.cota - a.it.cota);
      g.forEach((o) => { o.h = o.m.offsetHeight; });
      const cabe = g.reduce((s, o) => s + o.h + GAP, 0) <= limiteInf - limiteSup;
      if (!cabe) return false;
      let fundo = limiteSup - GAP;
      for (const o of g) { o.top = Math.max(y(o.it.cota) - o.h / 2, fundo + GAP); fundo = o.top + o.h; }
      let teto = limiteInf + GAP;
      for (let i = g.length - 1; i >= 0; i--) { const o = g[i]; o.top = Math.min(o.top, teto - GAP - o.h); teto = o.top; }
      g.forEach((o) => { o.top = Math.max(limiteSup, o.top); o.m.style.top = `${o.top}px`; o.centro = o.top + Math.min(o.h / 2, 14); });
      return true;
    }
    const ok = distribuir(acima, 0, yAgua - FOLGA_SUP) && distribuir(abaixo, yAgua + FOLGA_INF, H);
    if (!ok) distribuir(marcos, 0, H);

    // desenho da régua
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "regua-svg");
    svg.setAttribute("width", X);
    svg.setAttribute("height", H);
    svg.setAttribute("aria-hidden", "true");
    const partes = [];
    const X0 = estreito ? 6 : 16, LARG = estreito ? 30 : 34, XF = X0 + LARG + 4;
    partes.push(`<rect class="regua-esmalte" x="${X0}" y="${y(topo) - 4}" width="${LARG}" height="${y(base) - y(topo) + 8}" rx="2"/>`);
    const pxPorMetro = (H - 2 * PAD) / (topo - base);
    for (let m = Math.floor(base); m < Math.ceil(topo); m++) {
      // blocos em "E": 5 cm pretos a cada 10 cm, como nas réguas linimétricas
      if (pxPorMetro >= 25) {
        for (let k = 0; k < 10; k += 1) {
          const c = m + k / 10;
          if (c < base || c + 0.05 > topo) continue;
          partes.push(`<rect class="regua-bloco-e" x="${X0 + 1}" y="${y(c + 0.05)}" width="${k % 5 === 0 ? 16 : 12}" height="${Math.max(1, y(c) - y(c + 0.05))}"/>`);
        }
      }
      if (m >= base && m <= topo) {
        partes.push(`<line class="regua-marca" x1="${X0}" x2="${X0 + LARG}" y1="${y(m)}" y2="${y(m)}"/>`);
        partes.push(`<text class="regua-numero" x="${X0 + LARG - 3}" y="${y(m) - 3}" text-anchor="end">${m}</text>`);
      }
    }
    // faixas de alerta ao lado da régua
    const fs = faixas();
    fs.forEach((f, i) => {
      const fim = Math.min(topo, fs[i + 1]?.cota ?? topo);
      if (f.cota >= topo) return;
      partes.push(`<rect class="regua-faixa" x="${XF}" y="${y(fim)}" width="5" height="${y(Math.max(f.cota, base)) - y(fim)}" fill="${corStatus(f.id)}"><title>${esc(f.nome)} a partir de ${fmt(f.cota)} m</title></rect>`);
    });
    // ligações régua → rótulo
    marcos.forEach(({ it, centro }) => {
      const yc = y(it.cota);
      const cls = it.cota <= atual ? "regua-ligacao atingido" : "regua-ligacao";
      partes.push(`<polyline class="${cls}" points="${X0},${yc} ${XF + 12},${yc} ${X - 10},${centro} ${X},${centro}"/>`);
    });
    svg.innerHTML = partes.join("");
    el.appendChild(svg);
    const voce = localEscolhido();
    if (voce && voce.cota >= base && voce.cota <= topo) {
      const marcador = document.createElement("span");
      marcador.className = "regua-voce";
      marcador.textContent = "Você";
      marcador.title = `${voce.nome}: ${fmt(voce.cota)} m`;
      marcador.style.top = `${y(voce.cota)}px`;
      el.appendChild(marcador);
    }
  }

  // ------------------------------------------------------------ gráficos
  const linhasPlugin = {
    id: "linhasCota",
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx, chartArea: a, scales } = chart;
      const ys = scales.y;
      ctx.save();
      for (const l of opts.linhas || []) {
        const yy = ys.getPixelForValue(l.valor);
        if (yy < a.top || yy > a.bottom) continue;
        ctx.strokeStyle = l.cor; ctx.lineWidth = 1.25; ctx.setLineDash(l.traco || [5, 4]);
        ctx.beginPath(); ctx.moveTo(a.left, yy); ctx.lineTo(a.right, yy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = l.cor; ctx.font = `600 11px ${css("--fonte")}`;
        ctx.textAlign = l.direita ? "right" : "left";
        ctx.fillText(l.rotulo, l.direita ? a.right - 6 : a.left + 6, yy - 4);
        ctx.textAlign = "left";
      }
      if (opts.agora != null) {
        const xx = scales.x.getPixelForValue(opts.agora);
        ctx.strokeStyle = css("--tinta-suave"); ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, a.top); ctx.lineTo(xx, a.bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = css("--tinta"); ctx.font = `600 11px ${css("--fonte")}`;
        ctx.textAlign = "center"; ctx.fillText("agora", xx, a.top - 4);
      }
      ctx.restore();
    },
  };

  function opcoesBase(extra = {}) {
    const tinta = css("--tinta-suave");
    const grade = css("--linha");
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 16 } },
      plugins: {
        legend: { labels: { color: tinta, boxWidth: 14, font: { family: css("--fonte") }, filter: (i) => !i.text.startsWith("_") } },
        tooltip: { filter: (i) => !i.dataset.label.startsWith("_") && i.raw != null },
        linhasCota: extra.linhasCota || {},
      },
      scales: {
        x: { ticks: { color: tinta, maxRotation: 0, autoSkipPadding: 12 }, grid: { color: grade, drawTicks: false } },
        y: { ticks: { color: tinta, callback: (v) => `${fmt(v, 1)} m` }, grid: { color: grade }, ...(extra.y || {}) },
        ...(extra.scales || {}),
      },
    };
  }

  function linhasFaixas() {
    return faixas().map((f) => ({ valor: f.cota, cor: corStatus(f.id), rotulo: `${f.nome} (${fmt(f.cota)} m)` }));
  }

  function faixaDatasets(maxs, mins) {
    const agua = css("--agua");
    return [
      { label: "_max", data: maxs, borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: css("--agua-fundo"), spanGaps: false },
      { label: "Faixa provável (8 em 10 casos)", data: mins, borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: css("--agua-fundo"), borderColor: agua },
    ];
  }

  function limitesY(valores, extra = []) {
    const v = valores.filter((x) => x != null);
    const proxima = faixas().find((f) => f.cota > Math.max(...v));
    const alvo = [...v, ...extra, proxima ? proxima.cota + 0.2 : Math.max(...v) + 0.5];
    return { min: Math.max(0, Math.floor(Math.min(...alvo) - 0.5)), max: Math.ceil(Math.max(...alvo) + 0.3) };
  }

  function destruir(nome) { if (graficos[nome]) { graficos[nome].destroy(); delete graficos[nome]; } }

  function grafico48h() {
    destruir("48h");
    const obs = D.serie_horaria.slice(-25);
    const prev = D.previsao_horaria;
    const rotulos = [...obs.map((p) => p[0]), ...prev.map((p) => p.hora)].map((s) => `${SEMANA_CURTA[dataLocal(s).getDay()]} ${hora(s)}`);
    const n = obs.length;
    const vazio = (k) => Array(k).fill(null);
    const observado = [...obs.map((p) => p[1]), ...vazio(prev.length)];
    const previsto = [...vazio(n - 1), obs.at(-1)[1], ...prev.map((p) => p.media)];
    const maxs = [...vazio(n - 1), obs.at(-1)[1], ...prev.map((p) => p.max)];
    const mins = [...vazio(n - 1), obs.at(-1)[1], ...prev.map((p) => p.min)];
    const agua = css("--agua");
    graficos["48h"] = new Chart($("#graf-48h"), {
      type: "line",
      data: {
        labels: rotulos,
        datasets: [
          { label: "Medido", data: observado, borderColor: css("--tinta"), borderWidth: 2.5, pointRadius: 0, tension: 0.3 },
          { label: "Previsto", data: previsto, borderColor: agua, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 0, tension: 0.3 },
          ...faixaDatasets(maxs, mins),
        ],
      },
      options: opcoesBase({ y: limitesY([...observado, ...maxs, ...mins]), linhasCota: { linhas: linhasFaixas(), agora: n - 1 } }),
    });
    const h24 = prev[23], h48 = prev[47];
    const agora = D.atual.nivel;
    const dif = h48.media - agora;
    const verbo = Math.abs(dif) < 0.15 ? "deve ficar estável" : dif < 0 ? "deve continuar baixando" : "deve subir";
    $("#diag-48h").textContent = `O rio ${verbo}: cerca de ${fmt(h24.media)} m em 24 h e ${fmt(h48.media)} m em 48 h (entre ${fmt(h48.min)} e ${fmt(h48.max)} m).`;
  }

  function grafico7d() {
    destruir("7d");
    // a previsão é do nível médio do dia, então o passado também é a média (e não o máximo)
    const passados = (D.serie_diaria_media || D.serie_diaria_max).slice(-8, -1);
    const futuros = D.previsao_dias.slice(1);
    const rotDatas = [...passados.map((p) => p[0]), D.previsao_dias[0].data, ...futuros.map((d) => d.data)];
    const rotulos = rotDatas.map((s) => dataCurta(s));
    const vazio = (k) => Array(k).fill(null);
    const np = passados.length;
    const agora = D.atual.nivel;
    const observado = [...passados.map((p) => p[1]), agora, ...vazio(futuros.length)];
    const previsto = [...vazio(np), agora, ...futuros.map((d) => d.media)];
    const maxs = [...vazio(np), agora, ...futuros.map((d) => d.max)];
    const mins = [...vazio(np), agora, ...futuros.map((d) => d.min)];
    const chuvaMap = Object.fromEntries(D.chuva_diaria.map((c) => [c[0], c]));
    const chuva = rotDatas.map((d) => chuvaMap[d]?.[1] ?? null);
    const agua = css("--agua");
    const cfg = opcoesBase({
      y: limitesY([...observado, ...maxs, ...mins]),
      linhasCota: { linhas: linhasFaixas(), agora: np },
      scales: {
        y2: {
          position: "right", beginAtZero: true, suggestedMax: 60,
          grid: { display: false }, ticks: { color: css("--tinta-fraca"), callback: (v) => `${v} mm` },
        },
      },
    });
    graficos["7d"] = new Chart($("#graf-7d"), {
      data: {
        labels: rotulos,
        datasets: [
          { type: "line", label: D.serie_diaria_media ? "Nível médio do dia" : "Nível máximo do dia", data: observado, borderColor: css("--tinta"), borderWidth: 2.5, pointRadius: 3, tension: 0.35 },
          { type: "line", label: "Nível previsto", data: previsto, borderColor: agua, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 3, tension: 0.35 },
          ...faixaDatasets(maxs, mins).map((d) => ({ ...d, type: "line", tension: 0.35 })),
          {
            type: "bar", label: "Chuva na bacia", data: chuva, yAxisID: "y2", order: 10,
            backgroundColor: rotDatas.map((d, i) => (i > np ? css("--agua-forte") : css("--agua-fundo"))),
            borderColor: agua, borderWidth: { top: 1, left: 0, right: 0, bottom: 0 }, barPercentage: 0.55,
          },
        ],
      },
      options: cfg,
    });

    const pico = futuros.reduce((a, b) => (b.media > a.media ? b : a), futuros[0]);
    const riscoMax = futuros.reduce((a, b) => ((b.prob_inundacao ?? 0) > (a.prob_inundacao ?? 0) ? b : a), futuros[0]);
    const cotaInund = inundacao();
    let texto;
    const indiceRisco = futuros.indexOf(riscoMax) + 1; // 1 = amanhã
    if ((riscoMax.prob_inundacao ?? 0) >= 0.2 && indiceRisco <= 3) {
      texto = `Atenção: há ${pct(riscoMax.prob_inundacao)} de chance de o rio passar de ${fmt(cotaInund)} m ${naDia(riscoMax.data)} (${dataCurta(riscoMax.data)}), contando com a chuva prevista.`;
    } else if ((riscoMax.prob_inundacao ?? 0) >= 0.3) {
      texto = `Com a chuva prevista, o rio pode voltar a subir e chegar perto de ${fmt(cotaInund)} m ${naDia(riscoMax.data)} (${dataCurta(riscoMax.data)}). Como faltam mais de 3 dias, trate como tendência: a previsão de chuva ainda pode mudar bastante.`;
    } else if (pico.media > agora + 0.15) {
      texto = `Com a chuva prevista, o rio deve voltar a subir e chegar perto de ${fmt(pico.media)} m ${naDia(pico.data)} (${dataCurta(pico.data)}), abaixo da cota de inundação.`;
    } else {
      texto = `Sem subida importante prevista para os próximos 7 dias. Nível mais alto esperado: ${fmt(pico.media)} m.`;
    }
    $("#diag-7d").textContent = texto;
  }

  function iconeTempo(codigo) {
    const sol = '<circle class="ic-sol" cx="12" cy="11" r="5"/>';
    const nuvem = '<path class="ic-nuvem" d="M8 22h13a5 5 0 0 0 0-10 7 7 0 0 0-13-1 5.5 5.5 0 0 0 0 11z"/>';
    const gotas = '<path class="ic-gota" d="M11 24l-1.5 3M16 24l-1.5 3M21 24l-1.5 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="stroke:var(--agua)"/>';
    const raio = '<path class="ic-raio" d="M16 20l-3 6h3l-1 5 5-7h-3l2-4z"/>';
    let corpo, nome;
    if (codigo == null) { corpo = nuvem; nome = "Sem previsão"; }
    else if (codigo === 0) { corpo = sol; nome = "Céu limpo"; }
    else if (codigo <= 2) { corpo = sol + nuvem; nome = "Poucas nuvens"; }
    else if (codigo === 3) { corpo = nuvem; nome = "Nublado"; }
    else if (codigo <= 48) { corpo = nuvem; nome = "Neblina"; }
    else if (codigo <= 57) { corpo = nuvem + gotas; nome = "Garoa"; }
    else if (codigo <= 67) { corpo = nuvem + gotas; nome = codigo >= 65 ? "Chuva forte" : codigo >= 63 ? "Chuva moderada" : "Chuva fraca"; }
    else if (codigo <= 77) { corpo = nuvem; nome = "Neve"; }
    else if (codigo <= 82) { corpo = nuvem + gotas; nome = codigo === 82 ? "Pancadas fortes" : "Pancadas de chuva"; }
    else { corpo = nuvem + raio; nome = "Temporal"; } // códigos de granizo (96/99) não são confiáveis fora da Europa
    return `<svg viewBox="0 0 32 32" aria-hidden="true">${corpo}</svg><span>${nome}</span>`;
  }

  function statusRisco(p) {
    if (p == null) return "normal";
    return p < 0.05 ? "normal" : p < 0.2 ? "atencao" : p < 0.5 ? "alerta" : "emergencia";
  }

  function impactoDoDia(d, i, marcos) {
    const n = D.atual.nivel;
    if (i === 0) {
      const marco = marcos.filter((m) => m.cota <= n).at(-1);
      return { risco: statusDe(n).id, texto: `<span class="nivel">${fmt(n)} m</span> agora, ${estadoRio()}.${marco ? ` Marco atual: ${esc(marco.titulo)}.` : ""}` };
    }
    const probs = d.prob_cotas || {};
    const distante = i >= 4; // 4 dias ou mais: só tendência, sem porcentagem
    const inicioAlerta = faixas()[0]?.cota ?? 0; // marcos abaixo da 1ª faixa (ex.: leito normal) não são impacto
    const possiveis = marcos
      .filter((m) => m.cota > n && m.cota >= inicioAlerta)
      .map((m) => ({ m, p: probs[Number(m.cota).toFixed(2)] ?? (d.media >= m.cota ? 1 : 0) }))
      // perto: vale mostrar possibilidades a partir de 10%; longe: só o que é provável (tendência)
      .filter((o) => o.p >= (distante ? 0.4 : 0.1));
    let texto = `<span class="nivel">${fmt(d.media)} m</span>`;
    let risco = "normal";
    const alvo = possiveis.at(-1);
    if (alvo && distante) {
      texto += `Tendência: pode chegar a <strong>${esc(alvo.m.titulo)}</strong> (${fmt(alvo.m.cota)} m), se a chuva prevista se confirmar.`;
      risco = "atencao";
    } else if (alvo) {
      texto += `${alvo.p >= 0.5 ? "Deve chegar a" : "Pode chegar a"} <strong>${esc(alvo.m.titulo)}</strong> (${fmt(alvo.m.cota)} m): chance de ${pct(alvo.p)}.`;
      // cor de alarme só quando a chance é relevante; possibilidade pequena fica só em negrito
      const st = statusDe(alvo.m.cota).id;
      risco = alvo.p < 0.3 ? "baixo" : st === "normal" ? "atencao" : st;
    } else {
      const atual = marcos.filter((m) => m.cota <= n).at(-1);
      texto += atual && d.max < atual.cota
        ? `Deve voltar para baixo do marco de ${fmt(atual.cota)} m (${esc(atual.titulo)}).`
        : "Nenhum marco novo deve ser atingido.";
    }
    return { risco, texto };
  }

  const palavraChuva = (mm, p) => {
    if ((mm ?? 0) < 0.5 && (p == null || p < 15)) return "sem chuva";
    if (p == null) return "";
    return p >= 70 ? "quase certa" : p >= 40 ? "chuva provável" : p >= 15 ? "pode chover" : "improvável";
  };

  function renderImpactos() {
    const dias = D.previsao_dias;
    const marcos = [...(D.config.regua || [])].filter((m) => m.cota != null).sort((a, b) => a.cota - b.cota);
    const n = D.atual.nivel;
    const valores = [n, ...dias.flatMap((d) => [d.min ?? d.media, d.max ?? d.media, d.media])].filter((v) => v != null);
    let lo = Math.max(0, Math.floor(Math.min(...valores) - 0.5));
    let hi = Math.ceil(Math.max(...valores) + 0.5);
    const proxima = faixas().find((f) => f.cota > Math.max(...valores));
    // mostra a próxima faixa acima só se ela estiver perto; senão a escala fica espremida
    if (proxima && proxima.cota - Math.max(...valores) <= 2) hi = Math.max(hi, Math.ceil(proxima.cota + 0.6));
    const pos = (v) => ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100;
    const x = (v) => `${pos(v).toFixed(2)}%`;

    // zonas de alerta como fundo colorido da barra (em vez de linhas soltas)
    const fs = faixas();
    const zonas = [{ id: "normal", nome: "Normal", de: lo, ate: fs[0]?.cota ?? hi }]
      .concat(fs.map((f, i) => ({ id: f.id, nome: f.nome, de: f.cota, ate: fs[i + 1]?.cota ?? hi })))
      .filter((z) => z.ate > lo && z.de < hi);
    const tinta = (id) => (id === "normal" ? "transparent" : `color-mix(in srgb, var(--${id}) 30%, transparent)`);
    const fundo = `linear-gradient(to right, ${zonas.map((z) => `${tinta(z.id)} ${x(z.de)} ${x(z.ate)}`).join(", ")})`;
    const nomesZonas = zonas
      .map((z) => `<span class="zona-nome" data-status="${z.id}" title="${esc(z.nome)}: de ${fmt(Math.max(z.de, lo), 1)} a ${fmt(Math.min(z.ate, hi), 1)} m" style="left:${x(z.de)};width:calc(${x(z.ate)} - ${x(z.de)})">${esc(z.nome)}</span>`).join("");
    const passo = hi - lo > (window.innerWidth < 560 ? 5 : 8) ? 2 : 1;
    const metros = [];
    for (let m = Math.ceil(lo); m <= hi; m += passo) {
      const ajuste = pos(m) > 95 ? "transform:translateX(-100%)" : pos(m) < 5 ? "transform:none" : "";
      metros.push(`<span style="left:${x(m)};${ajuste}">${m} m</span>`);
    }

    const cabeca = `<li class="impacto impacto-cabeca">
      <span>Dia</span><span>Chuva</span>
      <div class="impactos-escala"><div class="zonas-nomes">${nomesZonas}</div><div class="metros">${metros.join("")}</div></div>
      <span class="so-largo">O que significa</span>
    </li>`;

    $("#impactos").innerHTML = cabeca + dias.map((d, i) => {
      const dt = dataLocal(d.data);
      const nome = i === 0 ? "Hoje" : i === 1 ? "Amanhã" : SEMANA_CURTA[dt.getDay()];
      const { risco, texto } = impactoDoDia(d, i, marcos);
      const icone = iconeTempo(d.codigo).split("</svg>")[0] + "</svg>";
      const faixa = i === 0 || d.min == null ? "" : `<span class="faixa-prov" style="left:${x(d.min)};width:calc(${x(d.max)} - ${x(d.min)})"></span>`;
      const rotulo = i === 0 ? `Agora: ${fmt(n)} metros` : `Mais provável ${fmt(d.media)} metros; pode ficar entre ${fmt(d.min)} e ${fmt(d.max)}`;
      const entre = i === 0 || d.min == null ? "" : `<small class="entre">entre ${fmt(d.min, 1)} e ${fmt(d.max, 1)} m</small>`;
      return `<li class="impacto${i === 0 ? " hoje" : ""}" data-risco="${risco}">
        <div class="impacto-dia">${nome}<small>${dataCurta(d.data)}</small></div>
        <div class="impacto-chuva">${icone}<span>${d.chuva_mm != null ? `${fmt(d.chuva_mm, 0)} mm` : "–"}<small>${palavraChuva(d.chuva_mm, d.prob)}</small></span></div>
        <div class="alcance" role="img" aria-label="${rotulo}" style="background:${fundo}">${faixa}<span class="media" style="left:${x(i === 0 ? n : d.media)}"></span></div>
        <p class="impacto-texto">${texto}${entre}</p>
      </li>`;
    }).join("");
    // nome da zona que não cabe na largura dela fica só na dica (title), sem texto cortado
    $$("#impactos .zona-nome").forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1) el.classList.add("apertado");
      if (el.scrollWidth > el.clientWidth + 1) el.classList.add("sem-texto");
    });
  }

  function renderPorque() {
    const f = D.fatores;
    const pontos = D.atual.chuva_pontos;
    const partes = [];
    if (pontos.length) {
      const c72 = pontos.reduce((s, p) => s + p.h72, 0) / pontos.length;
      const quanto = { baixo: "pouca chuva", moderado: "uma quantidade moderada", alto: "bastante chuva", "muito alto": "muita chuva" }[f.chuva_7d.nivel] || "";
      partes.push(`Nas últimas 72 horas choveu em média ${fmt(c72, 1)} mm na bacia, e a previsão é de ${fmt(f.chuva_7d.mm, 0)} mm nos próximos 7 dias${quanto ? `, ${quanto}` : ""}.`);
    }
    if (f.solo) {
      const cheio = f.solo.nivel === "encharcado" || f.solo.nivel === "muito úmido";
      partes.push(`O solo está ${f.solo.nivel} (${fmt(f.solo.umidade * 100, 0)}% de água)${cheio ? ", então quase toda chuva nova escorre para o rio" : " e ainda absorve parte da chuva antes de ela chegar ao rio"}.`);
    }
    if (f.montante) {
      const v = f.montante.variacao_24h;
      const mudou = v == null ? "sem variação medida" : Math.abs(v) < 0.05 ? "estável nas últimas 24 horas" : `${v > 0 ? "subiu" : "baixou"} ${fmt(Math.abs(v))} m em 24 horas`;
      partes.push(`Rio acima, em ${esc(f.montante.nome)}, o nível está ${mudou}.`);
    }
    partes.push("O modelo junta tudo isso com o nível de agora e a velocidade com que o rio vem mudando.");
    $("#porque").innerHTML = partes.join(" ");

    const m = D.modelo;
    $("#nota-modelo").innerHTML = m.tipo === "calibrado"
      ? `<strong>Como a previsão é feita.</strong> Um modelo estatístico aprendeu, com ${m.n_dias} dias de dados desta estação, como o rio responde à chuva na bacia. Ele é retreinado toda semana. ${D.cenarios_chuva ? `A faixa e as chances levam em conta ${D.cenarios_chuva} versões da previsão de chuva (conjunto do centro europeu ECMWF): se a chuva forte aparece só em parte delas, a chance fica menor.` : "Nesta atualização a previsão de chuva por conjunto não estava disponível, então as chances tratam a chuva prevista como certa e podem estar altas demais."} Porcentagens aparecem só até 3 dias à frente; depois disso o site mostra só a tendência. É uma estimativa, não uma certeza: siga sempre a Defesa Civil.`
      : `<strong>Previsão ainda não calibrada para esta estação</strong> (${esc(m.motivo || "sem histórico suficiente")}). Os valores usam coeficientes genéricos e podem errar bastante.`;
    $("#glofas").innerHTML = f.glofas
      ? `<strong>Vazão prevista pelo sistema europeu GloFAS:</strong> pico de ${fmt(f.glofas.pico_m3s, 0)} m³/s em ${dataCurta(f.glofas.data)}. É um modelo global de baixa resolução, mostrado só como referência; ele não entra na previsão acima.`
      : "";
  }

  // ------------------------------------------------------------ rio acima (desenho)
  function renderRioAcima() {
    const m = D.fatores?.montante;
    const fig = $("#rio-acima");
    if (!m) { fig.hidden = true; return; }
    fig.hidden = false;
    const sh = D.serie_horaria;
    const v24 = sh.length > 24 ? sh.at(-1)[1] - sh.at(-25)[1] : null;
    const mudou = (v) => (v == null ? "sem dado de 24 h" : Math.abs(v) < 0.05 ? "estável em 24 h" : `${v > 0 ? "subiu" : "baixou"} ${fmt(Math.abs(v))} m em 24 h`);
    const svg = $("#rio-desenho");
    svg.setAttribute("viewBox", "0 0 900 220");
    const d = "M20,120 C200,70 330,165 460,118 S720,80 880,120";
    svg.innerHTML = `<path id="rio-caminho" class="rio-leito" d="${d}"/><path class="rio-fluxo" d="${d}"/>`;
    const caminho = $("#rio-caminho");
    const total = caminho.getTotalLength();
    const p1 = caminho.getPointAtLength(total * 0.1), p2 = caminho.getPointAtLength(total * 0.9), meio = caminho.getPointAtLength(total * 0.5);
    const estacao = (p, papel, nome, valor, sub, ancora) => `
      <circle class="rio-estacao" cx="${p.x}" cy="${p.y}" r="11"/>
      <text class="rio-papel" x="${p.x}" y="${p.y - 50}" text-anchor="${ancora}">${esc(papel)}</text>
      <text class="rio-nome" x="${p.x}" y="${p.y - 26}" text-anchor="${ancora}">${esc(nome)}</text>
      <text class="rio-valor" x="${p.x}" y="${p.y + 50}" text-anchor="${ancora}">${fmt(valor)} m</text>
      <text class="rio-sub" x="${p.x}" y="${p.y + 72}" text-anchor="${ancora}">${esc(sub)}</text>`;
    svg.insertAdjacentHTML("beforeend",
      estacao(p1, "rio acima", m.nome, m.nivel, mudou(m.variacao_24h), "start") +
      estacao(p2, "aqui", D.config.estacao.nome || D.config.local, D.atual.nivel, mudou(v24), "end") +
      `<text class="rio-tempo" x="${meio.x}" y="${meio.y + 48}" text-anchor="middle">a água desce ${m.atraso_horas ? `em cerca de ${m.atraso_horas} h` : "até aqui"} →</text>`);
    svg.setAttribute("aria-label", `${m.nome}, rio acima: ${fmt(m.nivel)} metros, ${mudou(m.variacao_24h)}. ${D.config.estacao.nome}: ${fmt(D.atual.nivel)} metros.`);
    $("#rio-acima-nota").textContent = m.no_modelo
      ? `Quando o rio sobe em ${m.nome}, a subida chega aqui depois. O modelo já usa essa estação como aviso antecipado.`
      : `Quando o rio sobe em ${m.nome}, a subida chega aqui depois. Por enquanto é só informação: a estação entra no cálculo da previsão quando houver histórico suficiente (cerca de 90 dias de dados).`;
  }

  // ------------------------------------------------------------ mapa do tempo (Windy)
  const CAMADAS_TEMPO = {
    radar: { nota: "Onde está chovendo agora, pelos radares meteorológicos. As manchas amarelas e vermelhas são chuva forte. Em algumas áreas do interior a cobertura dos radares tem falhas.", zoom: 8 },
    satellite: { nota: "As nuvens vistas do satélite. As mais brancas e brilhantes costumam ser nuvens de tempestade; dá para ver quando elas estão vindo na direção da bacia.", zoom: 7 },
    rain: { nota: "Chuva prevista para as próximas horas pelo modelo europeu (ECMWF), a mesma base usada na previsão do rio. Use a linha do tempo do mapa para avançar as horas.", zoom: 8 },
  };
  let camadaTempo = "radar";
  function renderTempo(camada = camadaTempo) {
    camadaTempo = camada;
    const c = D.config.estacao;
    const info = CAMADAS_TEMPO[camada] || CAMADAS_TEMPO.radar;
    const params = new URLSearchParams({
      lat: c.lat, lon: c.lon, detailLat: c.lat, detailLon: c.lon, zoom: info.zoom,
      level: "surface", overlay: camada, product: "ecmwf", menu: "", message: "true", marker: "true",
      calendar: "now", pressure: "", type: "map", location: "coordinates", detail: "",
      metricWind: "km/h", metricTemp: "°C", metricRain: "mm", radarRange: "-1",
    });
    const url = `https://embed.windy.com/embed2.html?${params}`;
    const quadro = $("#mapa-tempo");
    if (quadro.getAttribute("src") !== url) quadro.setAttribute("src", url);
    $("#tempo-nota").textContent = info.nota;
    $$("#camada-tempo button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.camada === camada));
  }

  // ------------------------------------------------------------ gráfico com alternância
  let graficoAtivo = "7d";
  function mostrarGrafico(qual) {
    graficoAtivo = qual;
    $("#caixa-7d").hidden = qual !== "7d";
    $("#caixa-48h").hidden = qual !== "48h";
    $$("#alterna-grafico button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.grafico === qual));
    if (typeof Chart === "undefined") return;
    if (qual === "7d") grafico7d(); else grafico48h();
  }

  const cm = (m) => (m == null ? "–" : `${Math.round(m * 100)} cm`);

  function renderPlacar() {
    destruir("placar");
    const el = $("#placar");
    const partes = [];
    const v = D.modelo?.validacao;
    if (v?.erro_medio?.[0] != null) {
      const [ini, fim] = v.periodo || [];
      partes.push(`<p class="placar-teste"><strong>No teste com o passado</strong> (${v.n_dias} dias, de ${ini ? dataCurta(ini) + "/" + ini.slice(0, 4) : "?"} a ${fim ? dataCurta(fim) + "/" + fim.slice(0, 4) : "?"}), a previsão para o dia seguinte errou em média ${cm(v.erro_medio[0])}. O palpite "amanhã o rio fica igual a hoje" errou ${cm(v.erro_palpite[0])}. Esse teste usa a chuva que de fato caiu; com a chuva prevista, o erro real tende a ser um pouco maior. É isso que o placar abaixo mede.</p>`);
    }
    const p = D.placar;
    const h = (p?.horizontes || []).filter((x) => x.n > 0);
    if (!h.length) {
      partes.push(`<p class="placar-vazio">O placar ao vivo começa a encher amanhã: a primeira previsão ${p?.desde ? `foi guardada em ${dataCurta(p.desde)}` : "é guardada hoje às 7h"}. Com algumas semanas dá para tirar conclusões; com a próxima cheia, dá para ver como ela se sai quando mais importa.</p>`);
      el.innerHTML = partes.join("");
      return;
    }
    partes.push(`<table class="tabela"><thead><tr><th scope="col">Previsão feita com</th><th scope="col">Erro médio</th><th scope="col">Palpite "igual a hoje"</th><th scope="col">Caiu dentro da faixa</th><th scope="col">Dias conferidos</th></tr></thead><tbody>${
      h.map((x) => `<tr><td>${x.dias === 1 ? "1 dia" : `${x.dias} dias`} de antecedência</td>
        <td class="${x.erro_medio <= x.erro_palpite ? "melhor" : "pior"}">${cm(x.erro_medio)}</td>
        <td>${cm(x.erro_palpite)}</td>
        <td>${x.na_faixa == null ? "–" : pct(x.na_faixa)} <small>(esperado: 80%)</small></td>
        <td>${x.n}</td></tr>`).join("")
    }</tbody></table>`);
    partes.push(`<p class="explica">Em verde, quando a previsão errou menos que o palpite. Se a faixa acertar bem menos que 80% das vezes, ela está estreita demais; se acertar quase sempre, está larga demais.</p>`);
    if ((p.serie || []).length >= 3) partes.push(`<div class="grafico"><canvas id="graf-placar" aria-label="Previsto e observado, dia a dia"></canvas></div>`);
    el.innerHTML = partes.join("");
    if ((p.serie || []).length >= 3 && typeof Chart !== "undefined") {
      graficos.placar = new Chart($("#graf-placar"), {
        type: "line",
        data: {
          labels: p.serie.map((x) => dataCurta(x[0])),
          datasets: [
            { label: "O que o rio fez (média do dia)", data: p.serie.map((x) => x[1]), borderColor: css("--tinta"), borderWidth: 2.5, pointRadius: 2, tension: 0.3 },
            { label: "Previsto 1 dia antes", data: p.serie.map((x) => x[2]), borderColor: css("--agua"), borderWidth: 2, borderDash: [6, 4], pointRadius: 2, tension: 0.3 },
            { label: "Previsto 3 dias antes", data: p.serie.map((x) => x[3]), borderColor: css("--lama"), borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.3, spanGaps: true },
          ],
        },
        options: opcoesBase({ linhasCota: { linhas: linhasFaixas() } }),
      });
    }
  }

  // ------------------------------------------------------------ histórico
  let diasHistorico = 30;
  function graficoHistorico() {
    destruir("hist");
    const horario = diasHistorico <= 30;
    const serie = horario
      ? D.serie_horaria
      : D.serie_diaria_max.filter((p) => dataLocal(p[0]) >= new Date(Date.now() - diasHistorico * 864e5));
    const valores = serie.map((p) => p[1]);
    const rotulos = serie.map((p) => (horario ? `${dataCurta(p[0])} ${hora(p[0])}` : dataCurta(p[0])));
    const pico = serie.reduce((a, b) => (b[1] > a[1] ? b : a), serie[0]);
    const minimo = serie.reduce((a, b) => (b[1] < a[1] ? b : a), serie[0]);
    const media = valores.reduce((s, v) => s + v, 0) / valores.length;
    $("#resumo-historico").innerHTML = `
      <div><dt>Mais alto</dt><dd>${fmt(pico[1])} m<small>${dataCurta(pico[0])}</small></dd></div>
      <div><dt>Mais baixo</dt><dd>${fmt(minimo[1])} m<small>${dataCurta(minimo[0])}</small></dd></div>
      <div><dt>Média</dt><dd>${fmt(media)} m</dd></div>
      ${D.indicadores?.vazao_m3s != null ? `<div><dt>Vazão agora</dt><dd>${fmt(D.indicadores.vazao_m3s, 0)} m³/s<small>${esc(D.indicadores.fonte_vazao || "")}</small></dd></div>` : ""}`;

    const mostrarPontes = $("#mostrar-pontes").checked;
    const linhas = linhasFaixas();
    const topoDados = Math.max(...valores, inundacao() ?? 0);
    const pontes = mostrarPontes ? (D.config.pontes || []).filter((p) => p.cota <= topoDados * 1.35 + 1) : [];
    pontes.forEach((p) => linhas.push({ valor: p.cota, cor: css("--lama"), rotulo: `${p.nome} (${fmt(p.cota, 1)} m)`, traco: [2, 3], direita: true }));
    const yMax = Math.ceil(Math.max(topoDados, ...pontes.map((p) => p.cota)) + 0.5);

    graficos.hist = new Chart($("#graf-historico"), {
      type: "line",
      data: {
        labels: rotulos,
        datasets: [{
          label: horario ? "Nível (média por hora)" : "Nível máximo do dia", data: valores,
          borderColor: css("--agua"), backgroundColor: css("--agua-fundo"), fill: "origin", borderWidth: 2, pointRadius: 0, tension: 0.2,
        }],
      },
      options: opcoesBase({ y: { min: 0, max: yMax }, linhasCota: { linhas } }),
    });
  }

  function graficoGumbel() {
    destruir("gumbel");
    const e = D.extremos;
    if (!e) { $("#bloco-extremos").hidden = true; return; }
    const cotaInund = inundacao();
    $("#extremos-fonte").textContent = `Distribuição de Gumbel ajustada às cheias máximas de ${e.n_anos} anos (${e.periodo[0]} a ${e.periodo[1]}).`;
    graficos.gumbel = new Chart($("#graf-gumbel"), {
      type: "line",
      data: {
        datasets: [{
          label: "Altura esperada", data: e.curva.map((p) => ({ x: p.anos, y: p.cota })),
          borderColor: css("--lama"), backgroundColor: css("--lama"), pointRadius: 3, tension: 0.3,
        }],
      },
      options: opcoesBase({
        y: { title: { display: true, text: "Altura da cheia", color: css("--tinta-suave") } },
        linhasCota: { linhas: cotaInund != null ? [{ valor: cotaInund, cor: corStatus("emergencia"), rotulo: `Inundação (${fmt(cotaInund)} m)` }] : [] },
        scales: {
          x: {
            type: "logarithmic", min: 1, max: 100,
            title: { display: true, text: "Acontece em média a cada (anos)", color: css("--tinta-suave") },
            ticks: { color: css("--tinta-suave"), callback: (v) => ([1, 2, 5, 10, 25, 50, 100].includes(v) ? v : "") },
            grid: { color: css("--linha") },
          },
        },
      }),
    });
    $("#tabela-retorno tbody").innerHTML = e.tabela.map((l) =>
      `<tr class="${cotaInund != null && l.cota >= cotaInund ? "acima-inundacao" : ""}"><td>${esc(l.nome)}</td><td>${l.anos} anos</td><td>${fmt(l.cota)} m</td><td>${pct(l.chance)}</td></tr>`).join("");
  }

  function renderCheias() {
    const lista = [...(D.config.cheias_historicas || [])].sort((a, b) => b.cota - a.cota);
    if (!lista.length) { $("#bloco-cheias").hidden = true; return; }
    const pontes = [...(D.config.pontes || [])].sort((a, b) => a.cota - b.cota);
    const topo = Math.ceil(Math.max(...lista.map((c) => c.cota), ...pontes.map((p) => p.cota), 1) + 0.5);
    const x = (v) => `${((v / topo) * 100).toFixed(2)}%`;
    const linhas = pontes.map((p) => `<span class="cheia-ponte" style="left:${x(p.cota)}"></span>`).join("");
    const curto = (nome) => nome.replace(/^Ponte\s+(da\s+|do\s+|de\s+)?/i, "");
    const cabeca = pontes.length ? `<div class="cheias-cabeca" aria-hidden="true"><span>Pontes</span><div class="cheias-trilho">${
      pontes.map((p, i) => `<span class="rotulo-ponte" style="left:${x(p.cota)};bottom:${i % 2 ? 20 : 4}px;${p.cota / topo > 0.8 ? "transform:translateX(-100%)" : p.cota / topo < 0.15 ? "transform:none" : ""}">${esc(curto(p.nome))} ${fmt(p.cota, 1)}</span>`).join("")
    }</div></div>` : "";
    $("#cheias").innerHTML = cabeca + lista.map((c) => {
      const cobertas = pontes.filter((p) => c.cota >= p.cota).map((p) => p.nome);
      const resumo = pontes.length ? (cobertas.length ? `Cobriu: ${cobertas.join(", ")}.` : "Não cobriu nenhuma ponte.") : "";
      return `<div class="cheia">
        <div class="cheia-info"><b>${fmt(c.cota)} m</b><span>${esc(dataLonga(c.data))}</span></div>
        <div class="cheia-trilho" role="img" aria-label="${fmt(c.cota)} metros. ${esc(resumo)}"><span class="cheia-barra" style="width:${x(c.cota)}"></span>${linhas}</div>
        <p class="cheia-texto">${esc(c.texto || "")} ${esc(resumo)}</p>
      </div>`;
    }).join("");
  }

  function renderHistorico() {
    if (typeof Chart !== "undefined") { graficoHistorico(); graficoGumbel(); }
    const e = D.extremos, cota = inundacao();
    $("#chance-anual").innerHTML = e?.chance_anual_inundacao != null
      ? `<b>${pct(e.chance_anual_inundacao)}</b> de chance de o rio passar de ${fmt(cota)} m em um ano qualquer.`
      : "";
    renderCheias();
  }

  // ------------------------------------------------------------ emergência
  function renderEmergencia() {
    const ct = D.config.contatos || {};
    const tel = (n) => `tel:${n.replace(/[^\d+]/g, "")}`;
    const orgaos = (ct.orgaos || []).filter((o) => o.nome && (o.fixo || o.plantao));
    $("#bloco-orgaos").hidden = !orgaos.length;
    $("#orgaos").innerHTML = orgaos.map((o) => `<li><h4>${esc(o.nome)}</h4><p>${esc(o.descricao || "")}</p><div class="acoes">
        ${o.plantao ? `<a class="botao botao-forte" href="${tel(o.plantao)}">Plantão ${esc(o.plantao)}</a>` : ""}
        ${o.fixo ? `<a class="botao" href="${tel(o.fixo)}">Fixo ${esc(o.fixo)}</a>` : ""}
      </div></li>`).join("");
    const abrigos = (ct.abrigos || []).filter((a) => a.nome);
    $("#bloco-abrigos").hidden = !abrigos.length;
    const porCidade = {};
    abrigos.forEach((a) => (porCidade[a.cidade || ""] ||= []).push(a));
    $("#abrigos").innerHTML = Object.entries(porCidade).map(([cid, lista]) => `
      <div>${cid ? `<h4>${esc(cid)}</h4>` : ""}<ul>${lista.map((a) => `<li><strong>${esc(a.nome)}</strong>
        <span>${esc([a.endereco, a.capacidade ? `Capacidade para ${Number(a.capacidade).toLocaleString("pt-BR")} pessoas` : "", a.obs].filter(Boolean).join(". "))}</span></li>`).join("")}</ul></div>`).join("");
    renderPlano();
  }

  function renderPlano() {
    const c = D.config;
    const local = localEscolhido();
    const ct = c.contatos || {};
    const orgaos = (ct.orgaos || []).filter((o) => o.nome && (o.plantao || o.fixo));
    const abrigos = (ct.abrigos || []).filter((a) => a.nome);
    const campo = (rotulo, valor = "") => `<div class="plano-campo"><span>${rotulo}</span><span class="linha-escrever">${valor}</span></div>`;
    const site = c.url_site || location.href.split("#")[0].split("?")[0];
    $("#plano-conteudo").innerHTML = `<div class="plano-folha">
      <h4>Plano da família para cheias</h4>
      <p>${esc(c.rio)}, ${esc(c.local)}. Nível do rio e previsão: ${esc(site)}</p>
      ${campo("Nosso lugar é atingido com:", local ? `${esc(local.nome)}: ${fmt(local.cota)} m` : "")}
      ${campo("Combinamos sair de casa com o rio em:")}
      ${campo("Abrigo ou casa combinada:")}
      ${campo("Ponto de encontro da família:")}
      ${campo("Quem busca crianças e idosos:")}
      ${campo("Para onde vão os animais:")}
      <div><strong>Telefones</strong><div class="plano-telefones"><span>Defesa Civil 199</span><span>Bombeiros 193</span><span>SAMU 192</span><span>Polícia 190</span>${
        orgaos.map((o) => `<span>${esc(o.nome)}: ${esc(o.plantao || o.fixo)}</span>`).join("")}</div></div>
      ${abrigos.length ? `<div><strong>Abrigos da cidade</strong><ul class="plano-lista">${abrigos.map((a) => `<li>${esc(a.nome)}${a.endereco ? `, ${esc(a.endereco)}` : ""}</li>`).join("")}</ul></div>` : ""}
      <div><strong>Mochila pronta</strong><ul class="plano-lista"><li>Documentos em saco plástico</li><li>Remédios e receitas</li><li>Carregador e bateria extra</li><li>Lanterna e pilhas</li><li>Roupa, agasalho e cobertor</li><li>Ração, coleira e remédios dos animais</li></ul></div>
    </div>`;
    $("#orientacoes").innerHTML = c.orientacoes_url
      ? `Orientações oficiais sobre o que fazer antes, durante e depois de uma enchente: <a href="${esc(c.orientacoes_url)}" target="_blank" rel="noopener">Defesa Civil estadual</a>.`
      : "";
  }

  // ------------------------------------------------------------ rodapé e compartilhar
  function renderRodape() {
    const c = D.config;
    const gerado = dataLocal(D.gerado_em);
    const partes = [
      `<p>Nível: telemetria da Agência Nacional de Águas (ANA), estação ${esc(c.estacao.codigo)}${c.estacao.copel ? `, com reserva no Monitoramento Hidrológico da COPEL (${esc(c.estacao.copel)})` : ""}.${
        (c.montante || []).filter((m) => m.estacao_copel || m.codigo).map((m) => ` Rio acima: ${esc(m.nome)} (${m.estacao_copel ? "COPEL" : `ANA ${esc(m.codigo)}`}).`).join("")
      } Chuva, previsão do tempo e umidade do solo: Open-Meteo. Vazão prevista: GloFAS (Copernicus), via Open-Meteo. Dados de telemetria não consistidos.</p>`,
      `<p>Página gerada em ${gerado.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}. Os dados são atualizados automaticamente a cada 30 minutos.</p>`,
      `<p>Este painel é informativo e não substitui os alertas oficiais. Em situação de risco, siga a Defesa Civil.</p>`,
    ];
    if (c.repositorio) partes.push(`<p>Código aberto e gratuito: <a href="${esc(c.repositorio)}">${esc(c.repositorio.replace(/^https?:\/\//, ""))}</a>. Use na sua cidade.</p>`);
    if (D.avisos?.length) partes.push(`<p>Avisos da última coleta: ${D.avisos.map(esc).join(" ")}</p>`);
    $("#rodape").innerHTML = partes.join("");
  }

  function textoBoletim() {
    const a = D.atual, c = D.config;
    const [tend] = textoTendencia(a.tendencia_cm_h);
    const amanha = D.previsao_dias[1];
    return [
      `${c.rio} em ${c.local}`,
      `${fmt(a.nivel)} m às ${hora(a.hora)} (${statusDe(a.nivel).nome}). ${tend}.`,
      amanha?.min != null ? `Amanhã: entre ${fmt(amanha.min)} e ${fmt(amanha.max)} m.` : "",
      "Emergência: Defesa Civil 199",
    ].filter(Boolean).join("\n");
  }

  async function compartilhar() {
    const texto = textoBoletim();
    const botao = $("#compartilhar");
    try {
      if (navigator.share) { await navigator.share({ title: D.config.nome_app, text: texto, url: location.href }); return; }
      await navigator.clipboard.writeText(`${texto}\n${location.href}`);
      botao.textContent = "Boletim copiado";
    } catch (_) {
      botao.textContent = "Não foi possível copiar";
    }
    setTimeout(() => { botao.textContent = "Compartilhar boletim"; }, 2500);
  }

  // ------------------------------------------------------------ boletim em imagem (WhatsApp)
  function escreverQuebrando(g, texto, x, y, largura, alturaLinha) {
    const palavras = texto.split(/\s+/);
    let linha = "";
    for (const p of palavras) {
      const teste = linha ? `${linha} ${p}` : p;
      if (g.measureText(teste).width > largura && linha) { g.fillText(linha, x, y); y += alturaLinha; linha = p; } else linha = teste;
    }
    if (linha) { g.fillText(linha, x, y); y += alturaLinha; }
    return y;
  }

  async function boletimImagem() {
    const botao = $("#boletim-imagem");
    const original = botao.textContent;
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const W = 1080, H = 1350;
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const g = cv.getContext("2d");
      const c = D.config, a = D.atual, st = statusDe(a.nivel);
      const cores = { normal: ["#2E7D4F", "#fff"], atencao: ["#F2C200", "#121A1E"], alerta: ["#E8710A", "#121A1E"], emergencia: ["#C62828", "#fff"], extremo: ["#5E2A84", "#fff"] };
      const [cor, corTexto] = cores[st.id] || cores.normal;
      const cond = (peso, px) => `${peso} ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      const corpo = (peso, px) => `${peso} ${px}px "Atkinson Hyperlegible", Arial, sans-serif`;
      g.fillStyle = "#F4F6F6"; g.fillRect(0, 0, W, H);
      g.fillStyle = "#121A1E"; g.fillRect(0, 0, W, 140);
      g.fillStyle = "#F4F6F6"; g.font = cond(800, 64); g.fillText(c.nome_app.toUpperCase(), 64, 94);
      g.fillStyle = "#45535A"; g.font = corpo(400, 32);
      g.fillText(`${c.rio}, ${c.local}`, 64, 205);
      g.fillText(`Leitura das ${horaCurta(a.hora)} de ${dataCurta(a.hora)}`, 64, 248);
      g.fillStyle = "#121A1E"; g.font = cond(800, 250);
      const numero = fmt(a.nivel);
      g.fillText(numero, 54, 500);
      const wNum = g.measureText(numero).width;
      g.font = cond(800, 96); g.fillStyle = "#45535A"; g.fillText("m", 54 + wNum + 14, 500);
      g.font = cond(800, 54);
      const nomeFaixa = st.nome.toUpperCase();
      const wFx = g.measureText(nomeFaixa).width;
      g.fillStyle = cor; g.fillRect(64, 540, wFx + 48, 80);
      g.fillStyle = corTexto; g.fillText(nomeFaixa, 88, 600);
      g.fillStyle = "#45535A"; g.font = cond(700, 44); g.fillText(textoTendencia(a.tendencia_cm_h)[0], 64 + wFx + 76, 596);
      const [tit, sub] = manchete();
      g.fillStyle = "#121A1E"; g.font = cond(800, 66);
      let yy = escreverQuebrando(g, tit, 64, 730, W - 128, 70);
      g.font = corpo(400, 36); g.fillStyle = "#121A1E";
      yy = escreverQuebrando(g, sub.replace(/<[^>]+>/g, ""), 64, yy + 14, W - 128, 48);
      const topoDias = Math.max(yy + 40, 1010);
      g.fillStyle = "#121A1E"; g.fillRect(64, topoDias, W - 128, 4);
      D.previsao_dias.slice(1, 4).forEach((d, i) => {
        const x0 = 64 + i * 320;
        g.fillStyle = "#45535A"; g.font = cond(700, 38);
        g.fillText(i === 0 ? "AMANHÃ" : SEMANA_CURTA[dataLocal(d.data).getDay()].toUpperCase(), x0, topoDias + 58);
        g.fillStyle = "#121A1E"; g.font = cond(800, 64); g.fillText(`${fmt(d.media)} m`, x0, topoDias + 124);
        g.fillStyle = "#45535A"; g.font = corpo(400, 26);
        if (d.min != null) g.fillText(`entre ${fmt(d.min, 1)} e ${fmt(d.max, 1)}`, x0, topoDias + 162);
      });
      g.fillStyle = "#45535A"; g.font = corpo(400, 28);
      g.fillText((c.url_site || location.href.split("#")[0]).replace(/^https?:\/\//, ""), 64, H - 140);
      g.fillStyle = "#C62828"; g.fillRect(0, H - 110, W, 110);
      g.fillStyle = "#fff"; g.font = cond(800, 50); g.fillText("EMERGÊNCIA: DEFESA CIVIL 199", 64, H - 38);
      const blob = await new Promise((ok) => cv.toBlob(ok, "image/png"));
      const arquivo = new File([blob], `boletim-${c.slug}.png`, { type: "image/png" });
      const texto = `${textoBoletim()}\n${c.url_site || location.href.split("#")[0]}`;
      if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
        await navigator.share({ files: [arquivo], text: texto });
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = arquivo.name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      botao.textContent = "Imagem baixada: é só mandar no WhatsApp";
    } catch (e) {
      if (e?.name === "AbortError") return;
      botao.textContent = "Não foi possível gerar a imagem";
    }
    setTimeout(() => { botao.textContent = original; }, 3000);
  }

  // ------------------------------------------------------------ navegação
  function renderTudo() {
    renderTopo();
    renderAgora();
    renderImpactos();
    renderRioAcima();
    mostrarGrafico(graficoAtivo);
    renderTempo();
    renderPorque();
    renderPlacar();
    renderHistorico();
    renderEmergencia();
    renderRodape();
  }

  function ligarEventos() {
    $$("#periodo-historico button").forEach((b) => b.addEventListener("click", () => {
      $$("#periodo-historico button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      diasHistorico = Number(b.dataset.dias);
      if (typeof Chart !== "undefined") graficoHistorico();
    }));
    $$("#alterna-grafico button").forEach((b) => b.addEventListener("click", () => mostrarGrafico(b.dataset.grafico)));
    $$("#camada-tempo button").forEach((b) => b.addEventListener("click", () => renderTempo(b.dataset.camada)));
    $("#mostrar-pontes").addEventListener("change", () => { if (typeof Chart !== "undefined") graficoHistorico(); });
    $("#compartilhar").addEventListener("click", compartilhar);
    $("#boletim-imagem").addEventListener("click", boletimImagem);
    $("#imprimir-plano").addEventListener("click", () => window.print());
    $("#local-select").addEventListener("change", (ev) => {
      try {
        if (ev.target.value) localStorage.setItem(chaveLocal(), ev.target.value);
        else localStorage.removeItem(chaveLocal());
      } catch (_) { /* navegador sem armazenamento: vale só nesta visita */ }
      renderLocal();
      renderRegua();
      renderPlano();
    });

    let espera;
    window.addEventListener("resize", () => { clearTimeout(espera); espera = setTimeout(renderRegua, 150); });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderTudo);

    // destaca no menu a seção que está na tela
    if ("IntersectionObserver" in window) {
      const links = $$(".atalhos a");
      const obs = new IntersectionObserver((itens) => {
        itens.forEach((it) => {
          if (it.isIntersecting) links.forEach((l) => l.classList.toggle("ativo", l.getAttribute("href") === `#${it.target.id}`));
        });
      }, { rootMargin: "-45% 0px -50% 0px" });
      $$("main > section").forEach((sec) => obs.observe(sec));
    }
  }

  function mostrarErro(msg) {
    const el = $("#erro");
    el.textContent = msg;
    el.hidden = false;
    $$("main > section").forEach((p) => (p.hidden = true));
  }

  async function iniciar() {
    try {
      D = await carregar();
    } catch (e) {
      mostrarErro(e.message || "Não foi possível carregar os dados.");
      return;
    }
    if (typeof Chart !== "undefined") Chart.register(linhasPlugin);
    ligarEventos();
    renderTudo();
    if (location.hash) $(location.hash)?.scrollIntoView();
  }


  iniciar();
})();
