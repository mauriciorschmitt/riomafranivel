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
  const renderizadas = new Set();

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
  function renderTopo() {
    const c = D.config;
    document.title = `${c.nome_app}: nível do ${c.rio}`;
    $("#nome-app").textContent = c.nome_app;
    $("#local").textContent = `${c.rio}, em ${c.local}`;
    $("#demo-aviso").hidden = !D.demo;
    const minutos = Math.max(0, Math.round((Date.now() - dataLocal(D.atual.hora).getTime()) / 60000));
    const idade = minutos < 60 ? `há ${minutos} min` : minutos < 2880 ? `há ${Math.round(minutos / 60)} h` : `há ${Math.round(minutos / 1440)} dias`;
    const el = $("#atualizacao");
    if (D.demo) { el.textContent = `Estação ANA ${c.estacao.codigo}, leitura das ${hora(D.atual.hora)} (dados fictícios)`; return; }
    el.textContent = `Estação ANA ${c.estacao.codigo}, leitura das ${hora(D.atual.hora)} (${idade})`;
    el.classList.toggle("velho", minutos > 120);
    if (minutos > 120) el.textContent += ". A estação pode estar sem transmitir.";
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

  function renderAgora() {
    const a = D.atual;
    const st = statusDe(a.nivel);
    const leitura = $("#leitura");
    leitura.dataset.status = st.id;
    $("#status").textContent = st.nome;
    $("#nivel-valor").textContent = fmt(a.nivel);
    const [txt, sentido] = textoTendencia(a.tendencia_cm_h);
    const tend = $("#tendencia");
    tend.textContent = txt;
    tend.dataset.sentido = sentido;
    $("#diagnostico").innerHTML = diagnostico();
    renderSpark();

    const tbody = $("#chuva-tabela tbody");
    tbody.innerHTML = a.chuva_pontos.map((p) => `<tr><td>${esc(p.nome)}</td><td>${fmt(p.h24, 1)} mm</td><td>${fmt(p.h72, 1)} mm</td></tr>`).join("");
    $("#chuva-tabela").hidden = !a.chuva_pontos.length;

    const canal = (D.config.alertas || {}).telegram_canal;
    const link = $("#link-alertas");
    if (canal) { link.href = `https://t.me/${canal.replace(/^@/, "")}`; link.hidden = false; }

    renderRegua();
    renderIndicadores();
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
  }

  // ------------------------------------------------------------ indicadores
  function renderIndicadores() {
    const ind = D.indicadores;
    const cotaInund = inundacao();
    const chuva72 = D.atual.chuva_pontos.length
      ? D.atual.chuva_pontos.reduce((s, p) => s + p.h72, 0) / D.atual.chuva_pontos.length : null;
    const itens = [
      ["Vazão", ind.vazao_m3s == null ? "–" : `${fmt(ind.vazao_m3s, 0)}<small>m³/s</small>`, ind.fonte_vazao ? `Estimativa ${ind.fonte_vazao}` : ""],
      ["Pico em 30 dias", `${fmt(ind.pico_30d.nivel)}<small>m</small>`, `Em ${dataCurta(ind.pico_30d.hora)}`],
      [`Chance de passar ${fmt(cotaInund)} m neste ano`, D.extremos?.chance_anual_inundacao != null ? pct(D.extremos.chance_anual_inundacao) : "–", D.extremos ? `Com base em ${D.extremos.n_anos} anos` : "Sem série histórica"],
      ["Chuva nas últimas 72 h", chuva72 == null ? "–" : `${fmt(chuva72, 1)}<small>mm</small>`, "Média da bacia"],
      ["Chuva prevista em 7 dias", `${fmt(D.fatores.chuva_7d.mm, 0)}<small>mm</small>`, "Média da bacia"],
      ["Sem inundação", `${ind.dias_sem_inundacao_prefixo ? "+" : ""}${ind.dias_sem_inundacao}<small>${ind.dias_sem_inundacao === 1 ? "dia" : "dias"}</small>`, `Abaixo de ${fmt(cotaInund)} m`],
    ];
    $("#indicadores").innerHTML = itens.map(([dt, dd, sub]) => `<div><dt>${esc(dt)}</dt><dd>${dd}<span class="sub">${esc(sub)}</span></dd></div>`).join("");
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
    const passados = D.serie_diaria_max.slice(-8, -1);
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
          { type: "line", label: "Nível máximo do dia", data: observado, borderColor: css("--tinta"), borderWidth: 2.5, pointRadius: 3, tension: 0.35 },
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
    if ((riscoMax.prob_inundacao ?? 0) >= 0.2) {
      texto = `Atenção: há ${pct(riscoMax.prob_inundacao)} de chance de o rio passar de ${fmt(cotaInund)} m ${naDia(riscoMax.data)} (${dataCurta(riscoMax.data)}).`;
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
    else { corpo = nuvem + raio; nome = codigo >= 96 ? "Temporal com granizo" : "Temporal"; }
    return `<svg viewBox="0 0 32 32" aria-hidden="true">${corpo}</svg><span>${nome}</span>`;
  }

  function statusRisco(p) {
    if (p == null) return "normal";
    return p < 0.05 ? "normal" : p < 0.2 ? "atencao" : p < 0.5 ? "alerta" : "emergencia";
  }

  function renderDias() {
    $("#dias").innerHTML = D.previsao_dias.map((d, i) => {
      const dt = dataLocal(d.data);
      const nome = i === 0 ? "Hoje" : i === 1 ? "Amanhã" : SEMANA_CURTA[dt.getDay()];
      const st = i === 0 ? statusDe(d.media).id : statusRisco(d.prob_inundacao);
      const nivel = i === 0
        ? `<b>${fmt(d.media)} m</b><span>agora</span>`
        : `<b>${fmt(d.media)} m</b><span>entre ${fmt(d.min, 1)} e ${fmt(d.max, 1)} m</span>`;
      const risco = i === 0 ? statusDe(d.media).nome : `Chance de inundação: ${pct(d.prob_inundacao)}`;
      return `<li class="dia${i === 0 ? " hoje" : ""}" data-status="${st}">
        <div><span class="dia-nome">${nome}</span> <span class="dia-data">${dataCurta(d.data)}</span></div>
        <div class="dia-tempo">${iconeTempo(d.codigo)}</div>
        <div class="dia-temp">${d.tmax != null ? `${Math.round(d.tmax)}° / ${Math.round(d.tmin)}°` : ""}</div>
        <div class="dia-chuva">${d.chuva_mm != null ? `${fmt(d.chuva_mm, 1)} mm` : "–"} ${d.prob != null ? `<small>${d.prob}% de chance</small>` : ""}</div>
        <div class="dia-nivel">${nivel}</div>
        <div class="dia-risco">${risco}</div>
      </li>`;
    }).join("");
  }

  function renderFatores() {
    const f = D.fatores;
    const mapaChuva = { baixo: "normal", moderado: "atencao", alto: "alerta", "muito alto": "emergencia" };
    const mapaSolo = { seco: "normal", "úmido": "normal", "muito úmido": "atencao", encharcado: "alerta" };
    const linhas = [];
    linhas.push({ t: "Chuva prevista para os próximos 7 dias", p: `${fmt(f.chuva_7d.mm, 1)} mm em média na bacia.`, selo: f.chuva_7d.nivel, st: mapaChuva[f.chuva_7d.nivel] });
    if (f.solo) {
      const explica = f.solo.nivel === "encharcado" || f.solo.nivel === "muito úmido"
        ? "Com o solo cheio de água, quase toda a chuva nova escorre direto para o rio."
        : "O solo ainda absorve parte da chuva antes de ela chegar ao rio.";
      linhas.push({ t: "Umidade do solo", p: `${fmt(f.solo.umidade * 100, 0)}% de água entre 9 e 27 cm de profundidade. ${explica}`, selo: f.solo.nivel, st: mapaSolo[f.solo.nivel] });
    }
    if (f.montante) {
      const v = f.montante.variacao_24h;
      const sel = v == null ? "sem dado" : v > 0.1 ? "subindo" : v < -0.1 ? "baixando" : "estável";
      linhas.push({
        t: `Rio acima (${f.montante.nome})`,
        p: `${fmt(f.montante.nivel)} m${v != null ? `, ${v >= 0 ? "+" : ""}${fmt(v)} m em 24 h` : ""}. A água leva cerca de ${f.montante.atraso_horas ?? "?"} h para chegar aqui.`,
        selo: sel, st: sel === "subindo" ? "alerta" : "normal",
      });
    }
    if (f.glofas) {
      linhas.push({
        t: "Vazão prevista pelo sistema europeu (GloFAS)",
        p: `Pico de ${fmt(f.glofas.pico_m3s, 0)} m³/s em ${dataCurta(f.glofas.data)}, nos próximos 30 dias. Modelo global de baixa resolução, usado só como referência.`,
        selo: "referência", st: "normal",
      });
    }
    $("#fatores").innerHTML = linhas.map((l) => `<li data-status="${l.st}"><h3>${esc(l.t)}</h3><p>${esc(l.p)}</p><span class="selo">${esc(l.selo)}</span></li>`).join("");

    const m = D.modelo;
    let nota;
    if (m.tipo === "calibrado") {
      const [ini, fim] = m.periodo;
      nota = `<strong>Como a previsão é feita.</strong> Um modelo estatístico aprendeu, com ${m.n_dias} dias de dados desta estação (${dataCurta(ini)}/${ini.slice(0, 4)} a ${dataCurta(fim)}/${fim.slice(0, 4)}), como o rio responde à chuva na bacia. Em teste, errou em média ${fmt(m.rmse_horizonte[0])} m na previsão para o dia seguinte. A faixa sombreada mostra onde o nível deve ficar em 8 de cada 10 casos; ela fica mais larga nos dias distantes porque a previsão de chuva também erra mais. É uma estimativa, não uma certeza: siga sempre os boletins da Defesa Civil.`;
    } else {
      nota = `<strong>Previsão ainda não calibrada para esta estação</strong> (${esc(m.motivo || "sem histórico suficiente")}). Os valores usam coeficientes genéricos e podem errar bastante. Siga sempre os boletins da Defesa Civil.`;
    }
    $("#nota-modelo").innerHTML = nota;
  }

  function renderPrevisao() {
    grafico48h();
    grafico7d();
    renderDias();
    renderFatores();
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
      <div><dt>Média</dt><dd>${fmt(media)} m</dd></div>`;

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
    const pontes = D.config.pontes || [];
    $("#cheias").innerHTML = lista.map((c) => `
      <li class="cheia">
        <div class="cheia-cota">${fmt(c.cota)}<small>metros</small></div>
        <h3>${esc(dataLonga(c.data))}</h3>
        <p>${esc(c.texto || "")}</p>
        ${pontes.length ? `<ul class="pontes" aria-label="Situação das pontes">${pontes.map((p) =>
          `<li class="${c.cota >= p.cota ? "coberta" : "livre"}">${esc(p.nome)}: ${c.cota >= p.cota ? "coberta" : "livre"}</li>`).join("")}</ul>` : ""}
      </li>`).join("");
  }

  function renderHistorico() {
    graficoHistorico();
    graficoGumbel();
    renderCheias();
  }

  // ------------------------------------------------------------ emergência
  function renderEmergencia() {
    const ct = D.config.contatos || {};
    const orgaos = (ct.orgaos || []).filter((o) => o.nome && (o.fixo || o.plantao));
    if (orgaos.length) {
      $("#bloco-orgaos").hidden = false;
      $("#orgaos").innerHTML = orgaos.map((o) => {
        const tel = (n) => `tel:${n.replace(/[^\d+]/g, "")}`;
        return `<li><h3>${esc(o.nome)}</h3><p>${esc(o.descricao || "")}</p><div class="acoes">
          ${o.fixo ? `<a class="botao" href="${tel(o.fixo)}">Fixo ${esc(o.fixo)}</a>` : ""}
          ${o.plantao ? `<a class="botao botao-urgente" href="${tel(o.plantao)}">Plantão ${esc(o.plantao)}</a>` : ""}
        </div></li>`;
      }).join("");
    }
    const abrigos = (ct.abrigos || []).filter((a) => a.nome);
    if (abrigos.length) {
      $("#bloco-abrigos").hidden = false;
      const porCidade = {};
      abrigos.forEach((a) => (porCidade[a.cidade || ""] ||= []).push(a));
      $("#abrigos").innerHTML = Object.entries(porCidade).map(([cid, lista]) => `
        <div>${cid ? `<h3>${esc(cid)}</h3>` : ""}<ul>${lista.map((a) => `<li><strong>${esc(a.nome)}</strong>
          <span>${esc([a.endereco, a.capacidade ? `até ${a.capacidade} pessoas` : "", a.obs].filter(Boolean).join(". "))}</span></li>`).join("")}</ul></div>`).join("");
    }
  }

  // ------------------------------------------------------------ rodapé e compartilhar
  function renderRodape() {
    const c = D.config;
    const gerado = dataLocal(D.gerado_em);
    const partes = [
      `<p>Nível: telemetria da Agência Nacional de Águas (ANA), estação ${esc(c.estacao.codigo)}. Chuva, previsão do tempo e umidade do solo: Open-Meteo. Vazão prevista: GloFAS (Copernicus), via Open-Meteo.</p>`,
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

  // ------------------------------------------------------------ abas
  const renderPorAba = { previsao: renderPrevisao, historico: renderHistorico, emergencia: renderEmergencia };
  function abrirAba(nome, focar = false) {
    $$(".abas [role=tab]").forEach((b) => {
      const ativa = b.id === `aba-${nome}`;
      b.setAttribute("aria-selected", ativa);
      b.tabIndex = ativa ? 0 : -1;
      if (ativa && focar) b.focus();
      $(`#${b.getAttribute("aria-controls")}`).hidden = !ativa;
    });
    if (renderPorAba[nome] && !renderizadas.has(nome)) { renderPorAba[nome](); renderizadas.add(nome); }
    if (nome === "agora") renderRegua();
    if (location.hash !== `#${nome}`) history.replaceState(null, "", `#${nome}`);
  }

  function ligarEventos() {
    const abas = $$(".abas [role=tab]");
    abas.forEach((b, i) => {
      b.addEventListener("click", () => abrirAba(b.id.replace("aba-", "")));
      b.addEventListener("keydown", (e) => {
        const passo = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!passo) return;
        e.preventDefault();
        abrirAba(abas[(i + passo + abas.length) % abas.length].id.replace("aba-", ""), true);
      });
    });
    $$(".segmentado button").forEach((b) => b.addEventListener("click", () => {
      $$(".segmentado button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      diasHistorico = Number(b.dataset.dias);
      graficoHistorico();
    }));
    $("#mostrar-pontes").addEventListener("change", graficoHistorico);
    $("#compartilhar").addEventListener("click", compartilhar);

    let espera;
    window.addEventListener("resize", () => {
      clearTimeout(espera);
      espera = setTimeout(() => { if (!$("#painel-agora").hidden) renderRegua(); }, 150);
    });
    // redesenha cores dos gráficos quando o tema muda
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      renderRegua();
      renderizadas.forEach((n) => renderPorAba[n]?.());
    });
  }

  function mostrarErro(msg) {
    const el = $("#erro");
    el.textContent = msg;
    el.hidden = false;
    $$(".painel").forEach((p) => (p.hidden = true));
  }

  async function iniciar() {
    try {
      D = await carregar();
    } catch (e) {
      mostrarErro(e.message || "Não foi possível carregar os dados.");
      return;
    }
    if (typeof Chart !== "undefined") Chart.register(linhasPlugin);
    else Object.keys(renderPorAba).forEach((k) => { if (k !== "emergencia") renderPorAba[k] = () => {}; });
    ligarEventos();
    renderTopo();
    renderAgora();
    renderRodape();
    const inicial = location.hash.replace("#", "");
    abrirAba(["agora", "previsao", "historico", "emergencia"].includes(inicial) ? inicial : "agora");
  }

  iniciar();
})();
