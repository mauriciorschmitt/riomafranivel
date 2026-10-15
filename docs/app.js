/* Monitor de cheias: painel estático que lê dados/<cidade>.json */
(() => {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n, casas = 2) =>
    n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const pct = (p) => (p == null ? "–" : p < 0.01 && p > 0 ? "<1%" : `${Math.round(p * 100)}%`);
  // Os horários do boletim são de Brasília (sem fuso no texto). Tudo é lido e mostrado nesse
  // fuso, para quem estiver com o celular em outro (viagem, outro estado) ver o mesmo horário.
  const FUSO = "America/Sao_Paulo";
  const dataLocal = (s) => new Date(s.length <= 10 ? `${s}T12:00-03:00` : /([zZ]|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}-03:00`);
  const SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const SEMANA_CURTA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const diaSemana = (s) => { const [a, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(a, m - 1, d)).getUTCDay(); };
  const hojeISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(new Date());
  const somarDias = (iso, n) => { const [a, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
  // "hoje", "amanhã" ou "na sexta", pela data de verdade (não pela posição na lista)
  const naDia = (s) => {
    const dia = s.slice(0, 10), hoje = hojeISO();
    if (dia === hoje) return "hoje";
    if (dia === somarDias(hoje, 1)) return "amanhã";
    const d = diaSemana(s);
    return `${d === 0 || d === 6 ? "no" : "na"} ${SEMANA[d]}`;
  };
  const nomeDia = (s) => {
    const dia = s.slice(0, 10), hoje = hojeISO();
    return dia === hoje ? "Hoje" : dia === somarDias(hoje, 1) ? "Amanhã" : SEMANA_CURTA[diaSemana(s)];
  };
  const dataCurta = (s) => dataLocal(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: FUSO });
  const dataLonga = (s) => dataLocal(s).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: FUSO });
  const hora = (s) => s.slice(11, 16);
  const css = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();

  let D = null;
  let slugAtual = null;
  let guardado = false; // true quando o boletim veio da cópia guardada no aparelho (sem internet)
  const graficos = {};

  // ------------------------------------------------------------ dados
  async function buscarBoletim(slug) {
    const r = await fetch(`dados/${encodeURIComponent(slug)}.json`, { cache: "no-cache" });
    if (!r.ok) throw new Error(`Não encontrei os dados de "${slug}". Confira o nome da cidade no endereço.`);
    guardado = r.headers.get("x-regua-guardado") === "1";
    return r.json();
  }

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
    slugAtual = slug;
    try {
      return await buscarBoletim(slug);
    } catch (e) {
      if (e instanceof TypeError) throw new Error("Sem internet, e este aparelho ainda não tem um boletim guardado. Abra o site uma vez com internet para ele ficar disponível sem sinal.");
      throw e;
    }
  }

  // com o app aberto: busca o boletim novo de tempos em tempos e quando a internet volta
  const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;
  async function atualizarBoletim() {
    if (!slugAtual || window.__DADOS__) return;
    try {
      const novo = await buscarBoletim(slugAtual);
      if (novo.gerado_em !== D.gerado_em) {
        D = novo;
        renderTudo();
      }
    } catch (_) { /* sem rede: fica com o que já está na tela */ }
    renderTopo();
    atualizarAvisoOffline();
  }

  function atualizarAvisoOffline() {
    const aviso = $("#offline-aviso");
    const semRede = navigator.onLine === false || guardado;
    aviso.hidden = !semRede;
    if (!semRede || !D) return;
    const minutos = minutosDesde(D.atual.hora);
    const ha = minutos < 90 ? `${minutos} min` : minutos < 2880 ? `${Math.round(minutos / 60)} horas` : `${Math.round(minutos / 1440)} dias`;
    aviso.textContent = `Sem internet ou sinal fraco: mostrando o boletim das ${horaCurta(D.atual.hora)} de ${dataCurta(D.atual.hora)} (há ${ha}), guardado neste aparelho. Em risco, ligue 199.`;
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

    const el = $("#boletim-hora");
    let texto = `Atualizado às ${horaCurta(D.atual.hora)} de ${SEMANA[diaSemana(D.atual.hora)]} (${dataCurta(D.atual.hora)}).`;
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
    return t < 0 ? [`Baixando ${fmt(Math.abs(t), 1)} cm por hora`, "desce"] : [`Subindo ${fmt(t, 1)} cm por hora`, "sobe"];
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
    if (amanha?.min != null) partes.push(`Previsão para amanhã: entre ${fmt(amanha.min)} e ${fmt(amanha.max)} m${textoPico(amanha)}.`);
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

  // o pico só vale a menção quando passa da média do dia de forma visível
  const textoPico = (d) => (d?.pico != null && d.pico - d.media >= 0.1 ? `, com pico perto de ${fmt(d.pico)} m` : "");

  function estadoRio() {
    const t = D.atual.tendencia_cm_h;
    if (t == null || Math.abs(t) < 0.5) return "estável";
    const v = Math.abs(t);
    return (t < 0 ? "baixando" : "subindo") + (v >= 3 ? " rápido" : v < 1.5 ? " devagar" : "");
  }

  // ------------------------------------------------------------ risco
  // Uma só régua para todas as frases (manchete, próximos dias, "onde eu moro" e previsão),
  // para o site não dizer "sem risco" num lugar e "pode chegar" em outro. As chances são de
  // o PICO do dia passar da cota, e só valem até 3 dias à frente (depois, só tendência).
  const CHANCE_MINIMA = 0.05;   // abaixo disso: não deve chegar
  const CHANCE_RELEVANTE = 0.2; // a partir disso: pode chegar
  const CHANCE_PROVAVEL = 0.5;  // a partir disso: deve chegar
  const DIAS_COM_CHANCE = 3;
  const chanceDe = (d, cota) => d?.prob_cotas?.[Number(cota).toFixed(2)] ?? (cota === inundacao() ? d?.prob_inundacao : null) ?? null;
  function maiorChance(cota, dias = D.previsao_dias.slice(1, 1 + DIAS_COM_CHANCE)) {
    return dias.reduce((m, d) => { const p = chanceDe(d, cota) ?? 0; return p > m.p ? { p, d } : m; }, { p: 0, d: dias[0] });
  }
  // "Deve chegar a X: chance de 60%.", "Pode chegar a X: chance de 25%.", "Chance pequena (8%) de chegar a X."
  function fraseChance(p, acao, alvo) {
    if (p >= CHANCE_PROVAVEL) return `Deve ${acao} ${alvo}: chance de ${pct(p)}.`;
    if (p >= CHANCE_RELEVANTE) return `Pode ${acao} ${alvo}: chance de ${pct(p)}.`;
    if (p >= CHANCE_MINIMA) return `Chance pequena (${pct(p)}) de ${acao} ${alvo}.`;
    return null;
  }

  function manchete() {
    const c = D.config, n = D.atual.nivel, cota = inundacao();
    const estado = estadoRio();
    const acima = cota != null && n >= cota;
    const titulo = acima ? `O ${c.rio} está acima da cota de inundação e ${estado}.` : `O ${c.rio} está ${estado}.`;
    const dias = D.previsao_dias.slice(1);
    const { p: pPerto, d: perto } = maiorChance(cota);
    const distantes = dias.slice(DIAS_COM_CHANCE);
    const inicioAlerta = faixas()[0]?.cota ?? Infinity;
    const perto3 = pPerto >= CHANCE_MINIMA ? "Risco baixo de inundação" : "Sem risco de inundação";
    let sub;
    if (acima) sub = "Quem mora em área de risco deve seguir as orientações da Defesa Civil: <strong>199</strong>.";
    else if (pPerto >= CHANCE_RELEVANTE) sub = `<strong>${pPerto >= CHANCE_PROVAVEL ? "Deve" : "Pode"} passar da cota de inundação (${fmt(cota)} m) ${naDia(perto.data)}</strong>: chance de ${pct(pPerto)}, contando com a chuva prevista.`;
    else if (distantes.some((d) => d.media >= inicioAlerta)) {
      const alto = distantes.reduce((a, b) => (b.media > a.media ? b : a));
      sub = `${perto3} nos próximos 3 dias. <strong>Tendência de subida ${naDia(alto.data)}</strong>, se a chuva prevista se confirmar. A previsão fica mais segura mais perto da data.`;
    } else if (pPerto >= CHANCE_MINIMA) sub = "Risco baixo de inundação nos próximos 3 dias.";
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
    const distancia = (m) => (m < 1 ? `${Math.round(m * 100)} cm` : `${fmt(m)} m`);
    const falta = cota != null && a.nivel < cota ? ` Faltam ${distancia(cota - a.nivel)} para a cota de inundação (${fmt(cota)} m).` : "";
    $("#tendencia").textContent = `${tend}.${falta}`;
    renderSpark();

    const tbody = $("#chuva-tabela tbody");
    tbody.innerHTML = a.chuva_pontos.map((p) => `<tr><td>${esc(p.nome)}</td><td>${fmt(p.h24, 1)} mm</td><td>${fmt(p.h72, 1)} mm</td></tr>`).join("");
    $("#chuva-tabela").hidden = !a.chuva_pontos.length;

    const canal = (D.config.alertas || {}).telegram_canal;
    const link = $("#link-alertas");
    if (canal) { link.href = `https://t.me/${canal.replace(/^@/, "")}`; link.hidden = false; }

    renderFazer(st);
    renderMarcos();
    montarLocais();
    renderLocal();
  }

  // o que fazer, conforme a faixa; a cidade pode trocar os textos em config "o_que_fazer"
  const FAZER_PADRAO = {
    normal: "Rio normal. Bom momento para fazer o plano da família, na aba Emergência.",
    atencao: "Acompanhe o nível do rio e confira se a mochila de emergência está pronta.",
    alerta: "Deixe a mochila pronta, tire do chão o que pode molhar e combine com a família para onde ir.",
    emergencia: "Se a água chegar perto da sua casa, saia. Leve a mochila e vá para um abrigo ou casa combinada. Defesa Civil: 199.",
    extremo: "Saia das áreas de risco agora. Se precisar de ajuda, ligue 199 ou 193.",
  };
  function renderFazer(st) {
    const el = $("#fazer");
    el.dataset.status = st.id;
    $("#fazer-texto").textContent = (D.config.o_que_fazer || {})[st.id] || FAZER_PADRAO[st.id] || FAZER_PADRAO.normal;
  }

  // os dois próximos marcos da régua acima do nível de agora
  function renderMarcos() {
    const n = D.atual.nivel;
    const proximos = [...(D.config.regua || [])].filter((m) => m.cota != null && m.cota > n).sort((a, b) => a.cota - b.cota).slice(0, 2);
    $("#marcos").hidden = !proximos.length;
    const falta = (m) => (m < 1 ? `${Math.round(m * 100)} cm` : `${fmt(m)} m`);
    $("#marcos-lista").innerHTML = proximos.map((m) =>
      `<li><b>${fmt(m.cota)} m</b><span>${esc(m.titulo)}<small>faltam ${falta(m.cota - n)}${m.texto ? `. ${esc(m.texto)}` : ""}</small></span></li>`).join("");
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
    // pela altura: o que alaga primeiro vem primeiro
    const locais = [...listaLocais()].sort((a, b) => a.cota - b.cota || a.nome.localeCompare(b.nome, "pt-BR"));
    sel.innerHTML = `<option value="">Escolha sua rua, bairro ou ponte</option>` +
      locais.map((x) => `<option value="${esc(x.nome)}">${fmt(x.cota)} m · ${esc(x.nome)}</option>`).join("");
    const e = localEscolhido();
    if (e) sel.value = e.nome;
  }
  function renderMinhaRua(e) {
    const el = $("#minha-rua");
    el.hidden = !e;
    if (!e) return;
    const n = D.atual.nivel;
    const falta = e.cota - n;
    el.classList.toggle("perigo", falta <= 0.5);
    el.textContent = falta <= 0
      ? `${e.nome}: a água já passou do nível que chega lá (${fmt(e.cota)} m). Siga a Defesa Civil: 199.`
      : `${e.nome}: faltam ${falta < 1 ? `${Math.round(falta * 100)} cm` : `${fmt(falta)} m`} para a água chegar lá (${fmt(e.cota)} m).`;
  }

  function renderLocal() {
    const e = localEscolhido();
    renderMinhaRua(e);
    const el = $("#local-resultado");
    el.classList.remove("perigo");
    if (!e) {
      el.textContent = "Veja se a água pode chegar lá. A escolha fica salva só neste celular.";
      return;
    }
    const n = D.atual.nivel;
    if (n >= e.cota) {
      el.classList.add("perigo");
      el.innerHTML = `<strong>${esc(e.nome)}: o rio já passou de ${fmt(e.cota)} m, o nível em que a água chega lá.</strong> Siga as orientações da Defesa Civil: 199.`;
      return;
    }
    const dias = D.previsao_dias.slice(1);
    const { p: pPerto, d: perto } = maiorChance(e.cota);
    const tendenciaChega = dias.slice(DIAS_COM_CHANCE).some((d) => d.media >= e.cota);
    let previsao;
    if (pPerto >= CHANCE_MINIMA) previsao = ` ${fraseChance(pPerto, "chegar lá", naDia(perto.data))}`;
    else if (tendenciaChega) previsao = ` Nos próximos 3 dias, não. Depois, pela tendência, <strong>pode chegar lá se a chuva prevista se confirmar</strong>; a previsão fica mais segura mais perto da data.`;
    else previsao = " Pela previsão, a água não chega lá nos próximos 7 dias.";
    el.innerHTML = `<strong>${esc(e.nome)}</strong>: a água chega lá com ${fmt(e.cota)} m. O rio está <strong>${fmt(e.cota - n)} m abaixo</strong> disso.${previsao}`;
    if (pPerto >= CHANCE_RELEVANTE) el.classList.add("perigo");
  }

  // ------------------------------------------------------------ régua
  function renderRegua() {
    if ($("#historico")?.hidden) return; // desenhada quando a aba "Régua e histórico" abre
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
      { label: "Faixa mais provável (metade dos casos)", data: mins, borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: css("--agua-fundo"), borderColor: agua },
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
    const rotulos = [...obs.map((p) => p[0]), ...prev.map((p) => p.hora)].map((s) => `${SEMANA_CURTA[diaSemana(s)]} ${hora(s)}`);
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
    const LIMITE = 3; // dias com faixa; depois disso é só tendência
    const maxs = [...vazio(np), agora, ...futuros.map((d, i) => (i < LIMITE ? d.max : null))];
    const mins = [...vazio(np), agora, ...futuros.map((d, i) => (i < LIMITE ? d.min : null))];
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
          {
            type: "line", label: "Nível previsto", data: previsto, borderColor: agua, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 3, tension: 0.35,
            // depois de 3 dias a linha fica clara: é tendência, não previsão com faixa
            segment: { borderColor: (c) => (c.p0DataIndex >= np + LIMITE ? css("--tinta-fraca") : undefined), borderWidth: (c) => (c.p0DataIndex >= np + LIMITE ? 1.5 : undefined) },
            pointBackgroundColor: (c) => (c.dataIndex > np + LIMITE ? css("--tinta-fraca") : agua),
            pointBorderColor: (c) => (c.dataIndex > np + LIMITE ? css("--tinta-fraca") : agua),
          },
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
    const cotaInund = inundacao();
    let texto;
    const { p: pRisco, d: riscoPerto } = maiorChance(cotaInund);
    const picoPerto = Math.max(...futuros.slice(0, DIAS_COM_CHANCE).map((d) => d.pico_max ?? d.max ?? d.media));
    if (pRisco >= CHANCE_RELEVANTE) {
      texto = `Atenção: há ${pct(pRisco)} de chance de o rio passar de ${fmt(cotaInund)} m ${naDia(riscoPerto.data)} (${dataCurta(riscoPerto.data)}), contando com a chuva prevista.`;
    } else if (futuros.slice(DIAS_COM_CHANCE).some((d) => d.media >= (faixas()[0]?.cota ?? Infinity))) {
      const alto = futuros.slice(DIAS_COM_CHANCE).reduce((a, b) => (b.media > a.media ? b : a));
      texto = `Nos próximos 3 dias, ${pRisco >= CHANCE_MINIMA ? "risco baixo" : "sem risco"} de inundação. Depois, a tendência é de subida para perto de ${fmt(Math.round(alto.media * 2) / 2, 1)} m ${naDia(alto.data)}, se a chuva prevista se confirmar. A linha clara do gráfico é só tendência: a previsão de chuva desses dias ainda muda bastante.`;
    } else if (pico.media > agora + 0.15) {
      texto = `Com a chuva prevista, o rio deve voltar a subir e chegar perto de ${fmt(pico.media)} m ${naDia(pico.data)} (${dataCurta(pico.data)}), abaixo da cota de inundação.`;
    } else {
      texto = `Sem subida importante prevista para os próximos 7 dias. Nos próximos 3 dias, o mais provável é o rio ficar abaixo de ${fmt(picoPerto)} m${pRisco >= CHANCE_MINIMA ? `; risco baixo de inundação (chance de até ${pct(pRisco)})` : ""}.`;
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
      .map((m) => ({ m, p: probs[Number(m.cota).toFixed(2)] ?? ((d.pico ?? d.media) >= m.cota ? 1 : 0) }))
      // perto: só o que já merece alerta (a mesma régua da manchete); longe: só o que é provável (tendência)
      .filter((o) => o.p >= (distante ? 0.4 : CHANCE_RELEVANTE));
    let texto = `<span class="nivel">${fmt(d.media)} m</span>`;
    let risco = "normal";
    const alvo = possiveis.at(-1);
    if (distante) {
      // só tendência: direção e valor aproximado da linha central, sem porcentagem
      const anterior = D.previsao_dias[i - 1]?.media ?? n;
      const dif = d.media - anterior;
      const direcao = dif > 0.15 ? "deve subir" : dif < -0.15 ? "deve baixar" : "deve ficar estável";
      const perto = Math.round(d.media * 2) / 2;
      const marco = marcos.filter((m) => m.cota >= inicioAlerta && m.cota <= d.media + 0.1).at(-1);
      texto = `<span class="nivel">~${fmt(perto, 1)} m</span>Tendência: ${direcao}${marco ? `, perto de <strong>${esc(marco.titulo)}</strong> (${fmt(marco.cota)} m)` : ""}${dif > 0.15 ? ", se a chuva prevista se confirmar" : ""}.`;
      return { risco: marco ? "atencao" : "normal", texto };
    } else if (alvo) {
      texto += fraseChance(alvo.p, "chegar a", `<strong>${fmt(alvo.m.cota)} m</strong> (${esc(alvo.m.titulo.charAt(0).toLowerCase() + alvo.m.titulo.slice(1))})`);
      // cor de alarme só quando a chance é relevante; possibilidade pequena fica só em negrito
      const st = statusDe(alvo.m.cota).id;
      risco = alvo.p < CHANCE_RELEVANTE ? "baixo" : st === "normal" ? "atencao" : st;
    } else {
      const atual = marcos.filter((m) => m.cota <= n).at(-1);
      texto += atual && (d.pico_max ?? d.max) < atual.cota
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
    // a escala considera só o que aparece: faixa até 3 dias, linha central depois
    const ontem = dias[0]?.previsto_ontem;
    const valores = [n, ...(ontem ? [ontem.min, ontem.max, ontem.media] : []),
      ...dias.flatMap((d, i) => (i >= 4 ? [d.media] : i === 0 ? [] : [d.min ?? d.media, d.pico_max ?? d.max ?? d.media, d.media]))].filter((v) => v != null);
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
      const nome = nomeDia(d.data);
      let { risco, texto } = impactoDoDia(d, i, marcos);
      const po = i === 0 ? d.previsto_ontem : null;
      if (po) {
        const dentro = po.min != null && po.max != null && n >= po.min && n <= po.max;
        const conferencia = dentro
          ? `<span class="confere ok">A previsão de ontem acertou (${fmt(po.min, 1)} a ${fmt(po.max, 1)} m).</span>`
          : `<span class="confere">Ontem a previsão para hoje era ${fmt(po.media, 1)} m.</span>`;
        texto += conferencia;
      }
      const icone = iconeTempo(d.codigo).split("</svg>")[0] + "</svg>";
      const distante = i >= 4;
      const ate = d.pico_max ?? d.max; // até onde o rio deve ir no dia (pico), não só a média
      const faixa = po && po.min != null
        ? `<span class="faixa-prov" style="left:${x(po.min)};width:calc(${x(po.max)} - ${x(po.min)})"></span>`
        : i === 0 || distante || d.min == null ? "" : `<span class="faixa-prov" style="left:${x(d.min)};width:calc(${x(ate)} - ${x(d.min)})"></span>`;
      const rotulo = po ? `Agora: ${fmt(n)} metros. Previsto ontem: ${fmt(po.media)} metros, entre ${fmt(po.min)} e ${fmt(po.max)}` : i === 0 ? `Agora: ${fmt(n)} metros` : distante ? `Tendência: perto de ${fmt(d.media, 1)} metros` : `Deve ficar entre ${fmt(d.min, 1)} e ${fmt(ate, 1)} metros`;
      const entre = i === 0 || distante || d.min == null ? "" : `<small class="entre">Deve ficar entre ${fmt(d.min, 1)} e ${fmt(ate, 1)} m ao longo do dia.</small>`;
      return `<li class="impacto${i === 0 ? " hoje" : ""}" data-risco="${risco}">
        <div class="impacto-dia">${nome}<small>${dataCurta(d.data)}</small></div>
        <div class="impacto-chuva">${icone}<span>${d.chuva_mm != null ? `${fmt(d.chuva_mm, 0)} mm` : "–"}<small>${palavraChuva(d.chuva_mm, d.prob)}</small></span></div>
        <div class="alcance${distante ? " so-tendencia" : ""}" role="img" aria-label="${rotulo}" style="background:${fundo}">${faixa}<span class="media" style="left:${x(po ? po.media : i === 0 ? n : d.media)}"></span>${po ? `<span class="agora-ponto" style="left:${x(n)}" title="Agora: ${fmt(n)} m"></span>` : ""}</div>
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
      const mudou = v == null ? "ainda não tem 24 horas de leituras" : Math.abs(v) < 0.05 ? "ficou estável nas últimas 24 horas" : `${v > 0 ? "subiu" : "baixou"} ${fmt(Math.abs(v))} m em 24 horas`;
      partes.push(`Rio acima, em ${esc(f.montante.nome)}, o nível ${mudou}.`);
    }
    partes.push("O modelo junta tudo isso com o nível de agora e a velocidade com que o rio vem mudando.");
    $("#porque").innerHTML = partes.join(" ");

    const m = D.modelo;
    $("#nota-modelo").innerHTML = m.tipo === "calibrado"
      ? `<strong>Como a previsão é feita.</strong> Um modelo estatístico aprendeu, com ${m.n_dias} dias de dados desta estação, como o rio responde à chuva na bacia, e é retreinado toda semana. ${
          D.cenarios_chuva
            ? `Ele roda uma vez para cada uma das ${D.cenarios_chuva} versões da previsão de chuva do centro europeu (ECMWF). A linha central é a mediana dessas rodadas, por isso muda pouco de uma atualização para outra; a chuva mostrada também é a mediana das versões.`
            : "Nesta atualização a previsão de chuva por conjunto não estava disponível, então a linha e as chances usam só a previsão principal, que oscila mais."
        } A faixa é a "mais provável": o rio deve ficar dentro dela em cerca de metade dos casos. Números e chances aparecem só até 3 dias; depois disso o site mostra só a tendência, porque a previsão de chuva ainda muda muito. É uma estimativa, não uma certeza: siga sempre a Defesa Civil.`
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
  let mapaLiberado = false; // o mapa gasta bastante internet: só carrega quando a pessoa pede
  function renderTempo(camada = camadaTempo, liberar = false) {
    camadaTempo = camada;
    if (liberar) mapaLiberado = true;
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
    quadro.hidden = !mapaLiberado;
    $("#mapa-abrir").hidden = mapaLiberado;
    if (mapaLiberado && quadro.getAttribute("src") !== url) quadro.setAttribute("src", url);
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

  // quando sai a primeira previsão guardada: hoje (antes das 7h) ou o próximo dia válido
  function proximaGuarda(desde) {
    const hoje = hojeISO();
    const horaAgora = Number(new Intl.DateTimeFormat("en-GB", { timeZone: FUSO, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
    let dia = horaAgora < 7 ? hoje : somarDias(hoje, 1);
    if (desde && desde > dia) dia = desde;
    return naDia(dia);
  }

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
    if (p?.versao_desde) partes.push(`<p class="placar-teste"><strong>Placar ao vivo da versão atual</strong>, com previsões feitas desde ${dataCurta(p.versao_desde)}. Versões anteriores não entram na conta.</p>`);
    const c = p?.chuva;
    if (c?.n) {
      partes.push(`<p class="placar-teste"><strong>Chuva prevista x chuva que caiu:</strong> nas ${c.n} comparações (previsões de 1 a 3 dias), o previsto somou ${fmt(c.prevista_mm, 0)} mm e caíram ${fmt(c.caiu_mm, 0)} mm. ${
        c.fator ? `Como a previsão de chuva costuma errar para o mesmo lado aqui, ela é multiplicada por ${fmt(c.fator)} antes de entrar no modelo.` : "Com 15 comparações, o site passa a corrigir sozinho esse erro da chuva prevista."}</p>`);
    }
    const h = (p?.horizontes || []).filter((x) => x.n > 0);
    if (!h.length) {
      partes.push(`<p class="placar-vazio">O placar ao vivo ainda está vazio: a primeira previsão ${p?.desde ? `foi guardada em ${dataCurta(p.desde)}` : `será guardada ${proximaGuarda(p?.versao_desde)} às 7h`} e é conferida no dia seguinte. Com algumas semanas dá para tirar conclusões; com a próxima cheia, dá para ver como ela se sai quando mais importa.</p>`);
      el.innerHTML = partes.join("");
      return;
    }
    partes.push(`<table class="tabela"><thead><tr><th scope="col">Previsão feita com</th><th scope="col">Erro médio</th><th scope="col">Palpite "igual a hoje"</th><th scope="col">Caiu dentro da faixa</th><th scope="col">Dias conferidos</th></tr></thead><tbody>${
      h.map((x) => `<tr><td>${x.dias === 1 ? "1 dia" : `${x.dias} dias`} de antecedência</td>
        <td class="${x.erro_medio <= x.erro_palpite ? "melhor" : "pior"}">${cm(x.erro_medio)}</td>
        <td>${cm(x.erro_palpite)}</td>
        <td>${x.na_faixa == null ? "–" : pct(x.na_faixa)} <small>(esperado: perto de 50%)</small></td>
        <td>${x.n}</td></tr>`).join("")
    }</tbody></table>`);
    partes.push(`<p class="explica">Em verde, quando a previsão errou menos que o palpite. A faixa é a "mais provável": o rio deve cair dentro dela em cerca de metade dos dias. Bem menos que isso, ela está estreita demais; quase sempre, está larga demais.</p>`);
    const fat = p.fatores_faixa || [];
    if (fat.some((f) => Math.abs(f - 1) >= 0.05)) {
      partes.push(`<p class="explica">Ajuste automático: com base nesse placar, a faixa de hoje está ${fat[0] >= 1 ? "alargada" : "estreitada"} (${fmt(fat[0])}× para amanhã, ${fmt(fat[2])}× para 3 dias), para voltar a acertar perto de metade das vezes.</p>`);
    }
    const hp = h.find((x) => x.erro_pico != null);
    if (hp) partes.push(`<p class="explica">Pico do dia (a maior leitura, que é o que alaga a rua): previsto com ${hp.dias === 1 ? "1 dia" : `${hp.dias} dias`} de antecedência, errou em média ${cm(hp.erro_pico)} em ${hp.n_pico} dias.</p>`);
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

  function tabelaFrequencia() {
    const e = D.extremos;
    if (!e) { $("#bloco-extremos").hidden = true; return; }
    const cotaInund = inundacao();
    $("#extremos-fonte").textContent = `Calculado com a maior cheia de cada ano, de ${e.periodo[0]} a ${e.periodo[1]}. "Uma vez a cada 10 anos" é uma média: pode acontecer em dois anos seguidos.`;
    const quando = { 2: "Um ano sim, um ano não", 10: "Uma vez a cada 10 anos", 100: "Uma vez a cada 100 anos" };
    $("#tabela-retorno tbody").innerHTML = e.tabela.filter((l) => quando[l.anos]).map((l) =>
      `<tr class="${cotaInund != null && l.cota >= cotaInund ? "acima-inundacao" : ""}"><td>${fmt(l.cota)} m</td><td>${quando[l.anos]}</td></tr>`).join("");
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
    if (typeof Chart !== "undefined") graficoHistorico();
    tabelaFrequencia();
    const e = D.extremos, cota = inundacao();
    $("#chance-anual").innerHTML = e?.chance_anual_inundacao != null
      ? `<b>${pct(e.chance_anual_inundacao)}</b> de chance de o rio passar de ${fmt(cota)} m em um ano qualquer.`
      : "";
    renderCheias();
  }

  // ------------------------------------------------------------ emergência
  function renderEmergencia() {
    const ct = D.config.contatos || {};
    // com +55 o número funciona em qualquer celular, de qualquer DDD; os curtos (199, 193) ficam como estão
    const tel = (n) => {
      const digitos = n.replace(/\D/g, "");
      if (n.trim().startsWith("+")) return `tel:+${digitos}`;
      return digitos.length < 10 ? `tel:${digitos}` : `tel:+55${digitos.replace(/^0+/, "")}`;
    };
    const orgaos = (ct.orgaos || []).filter((o) => o.nome && (o.fixo || o.plantao));
    $("#bloco-orgaos").hidden = !orgaos.length;
    $("#orgaos").innerHTML = orgaos.map((o) => `<li><h4>${esc(o.nome)}</h4><p>${esc(o.descricao || "")}</p><div class="acoes">
        ${o.plantao ? `<a class="botao botao-forte" href="${tel(o.plantao)}">Plantão ${esc(o.plantao)}</a>` : ""}
        ${o.fixo ? `<a class="botao" href="${tel(o.fixo)}">Fixo ${esc(o.fixo)}</a>` : ""}
      </div></li>`).join("");
    const abrigos = (ct.abrigos || []).filter((a) => a.nome);
    const mapas = ct.mapas_abrigos || {};
    $("#bloco-abrigos").hidden = !abrigos.length;
    const porCidade = {};
    abrigos.forEach((a) => (porCidade[a.cidade || ""] ||= []).push(a));
    const ordemTexto = (n) => (n === 1 ? "Abre primeiro" : `${n}º a abrir`);
    $("#abrigos").innerHTML = Object.entries(porCidade).map(([cid, lista]) => {
      // quem tem ordem de abertura vem primeiro, na ordem; os outros depois
      lista.sort((a, b) => (a.ordem ?? 99) - (b.ordem ?? 99));
      const mapaCidade = mapas[cid] ? `<a class="botao botao-pequeno" href="${esc(mapas[cid])}" target="_blank" rel="noopener">Ver os abrigos no mapa</a>` : "";
      return `<div>${cid ? `<h4>${esc(cid)}</h4>` : ""}<ul>${lista.map((a) => `<li>
          ${a.ordem ? `<span class="abrigo-ordem">${ordemTexto(a.ordem)}</span>` : ""}
          <strong>${esc(a.nome)}</strong>
          <span>${esc([a.endereco, a.capacidade ? `Capacidade para ${Number(a.capacidade).toLocaleString("pt-BR")} pessoas` : "", a.obs].filter(Boolean).join(". "))}</span>
          ${a.mapa ? `<a class="botao botao-pequeno" href="${esc(a.mapa)}" target="_blank" rel="noopener">Como chegar</a>` : ""}
        </li>`).join("")}</ul>${mapaCidade}</div>`;
    }).join("");
    // não redesenha o plano enquanto a pessoa está escrevendo nele (o boletim se atualiza sozinho)
    if (!document.activeElement?.closest("#plano-conteudo")) renderPlano();
  }

  // ------------------------------------------------------------ plano da família (preenchível)
  const MOCHILA = ["Documentos em saco plástico", "Remédios e receitas", "Carregador e bateria extra", "Lanterna e pilhas",
    "Roupa, agasalho e cobertor", "Água e comida para 2 dias", "Ração, coleira e remédios dos animais"];
  const CAMPOS_PLANO = ["familia", "lugar", "sair", "abrigo", "encontro", "busca", "animais", "telefones"];
  const chavePlano = () => `regua-viva:${D.config.slug}:plano`;
  function lerPlano() {
    try { return JSON.parse(localStorage.getItem(chavePlano()) || "{}"); } catch (_) { return {}; }
  }
  function salvarPlano() {
    const plano = { mochila: $$("#plano-conteudo [data-mochila]").filter((c) => c.checked).map((c) => c.dataset.mochila) };
    CAMPOS_PLANO.forEach((id) => { const el = $(`#plano-${id}`); if (el) plano[id] = el.value.trim(); });
    try { localStorage.setItem(chavePlano(), JSON.stringify(plano)); } catch (_) { /* sem armazenamento: só não fica salvo */ }
    atualizarPlanoVivo(plano);
    return plano;
  }
  const siteDaCidade = () => D.config.url_site || location.href.split("#")[0].split("?")[0];
  // "6,5" ou "6.5 m" vira "6,50 m"; o que não for número fica como a pessoa escreveu
  function alturaSair(valor) {
    const n = parseFloat(String(valor || "").replace(",", ".").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 && n < 40 ? `${fmt(n)} m` : (valor || "").trim();
  }

  // partes do plano que mudam enquanto a pessoa preenche (sem redesenhar o formulário)
  function atualizarPlanoVivo(plano) {
    const local = listaLocais().find((x) => x.nome === plano.lugar);
    const info = $("#plano-lugar-info");
    if (info) info.textContent = local ? `A água chega lá com ${fmt(local.cota)} m. Agora o rio está em ${fmt(D.atual.nivel)} m.` : "";
    const sugestoes = $("#plano-sugestoes");
    if (sugestoes) {
      const opcoes = local ? [1, 0.5].map((antes) => local.cota - antes).filter((v) => v > 0) : [];
      // só redesenha se mudou: senão um toque na sugestão (que salva o campo anterior) perde o botão
      const chave = opcoes.map((v) => fmt(v)).join("|");
      if (sugestoes.dataset.chave !== chave) {
        sugestoes.dataset.chave = chave;
        sugestoes.innerHTML = opcoes.map((v) => `<button type="button" class="chip" data-sair="${fmt(v)}">${fmt(v)} m</button>`).join("");
      }
      sugestoes.hidden = !opcoes.length;
    }
    const prontos = (plano.mochila || []).length;
    const progresso = $("#plano-mochila-progresso");
    if (progresso) progresso.textContent = prontos === MOCHILA.length ? "Tudo pronto." : `${prontos} de ${MOCHILA.length} prontos`;
  }

  function renderPlano() {
    const c = D.config;
    const ct = c.contatos || {};
    const orgaos = (ct.orgaos || []).filter((o) => o.nome && (o.plantao || o.fixo));
    const abrigos = (ct.abrigos || []).filter((a) => a.nome);
    const plano = lerPlano();
    if (!plano.lugar) plano.lugar = localEscolhido()?.nome || "";
    const locais = [...listaLocais()].sort((a, b) => a.cota - b.cota);
    const v = (id) => esc(plano[id] || "");
    const texto = (id, dica = "", extra = "") => `<input id="plano-${id}" type="text" value="${v(id)}" placeholder="${esc(dica)}" autocomplete="off"${extra}>`;
    const passo = (n, titulo, corpo) => `<section class="plano-passo"><span class="passo-num" aria-hidden="true">${n}</span><div class="passo-corpo"><h4>${titulo}</h4>${corpo}</div></section>`;
    $("#plano-conteudo").innerHTML = `<div class="plano-form">
      <div class="plano-cabeca">
        <h4>Plano da família para cheias</h4>
        <label for="plano-familia" class="sr">Nome da família</label>
        ${texto("familia", "Nome da família (ex.: Família Souza)")}
      </div>
      ${passo(1, "Nossa casa", `
        <label for="plano-lugar" class="sr">Rua ou bairro</label>
        <select id="plano-lugar"><option value="">Escolha a rua ou bairro</option>${
          locais.map((x) => `<option value="${esc(x.nome)}"${x.nome === plano.lugar ? " selected" : ""}>${esc(x.nome)} (${fmt(x.cota)} m)</option>`).join("")}</select>
        <p class="plano-info" id="plano-lugar-info"></p>`)}
      ${passo(2, "Saímos de casa com o rio em", `
        <div class="plano-sair"><label for="plano-sair" class="sr">Altura do rio</label>${`<input id="plano-sair" type="text" inputmode="decimal" value="${esc((plano.sair || "").replace(/\s*m$/, ""))}" placeholder="6,50" autocomplete="off">`}<span>m</span></div>
        <div class="chips" id="plano-sugestoes" hidden></div>
        <p class="plano-ajuda">Combine uma altura antes da água chegar na casa: dá tempo de sair com calma.</p>`)}
      ${passo(3, "Para onde vamos", `
        <label for="plano-abrigo">Abrigo ou casa de parente</label>${texto("abrigo", "Ex.: casa da tia Maria", ' list="plano-abrigos"')}
        <datalist id="plano-abrigos">${abrigos.map((a) => `<option value="${esc(a.nome)}${a.cidade ? ` (${esc(a.cidade)})` : ""}">`).join("")}</datalist>
        <label for="plano-encontro">Se a família se separar, nos encontramos em</label>${texto("encontro", "Ex.: em frente à igreja matriz")}`)}
      ${passo(4, "Quem faz o quê", `
        <label for="plano-busca">Quem busca crianças e idosos</label>${texto("busca", "Ex.: João busca a vó Ana")}
        <label for="plano-animais">Para onde vão os animais</label>${texto("animais", "Ex.: o Totó vai junto, com coleira")}`)}
      ${passo(5, "Telefones da família", `
        <label for="plano-telefones" class="sr">Telefones</label>
        <textarea id="plano-telefones" rows="3" placeholder="Um por linha: nome e número">${v("telefones")}</textarea>`)}
      ${passo(6, "Mochila de emergência", `
        <p class="plano-ajuda">Marque o que já está separado. <strong id="plano-mochila-progresso"></strong></p>
        <div class="mochila">${MOCHILA.map((m) => `<label class="mochila-item"><input type="checkbox" data-mochila="${esc(m)}"${(plano.mochila || []).includes(m) ? " checked" : ""}><span>${esc(m)}</span></label>`).join("")}</div>`)}
      <div class="plano-referencia">
        <div><strong>Telefones de emergência</strong><div class="plano-telefones"><span>Defesa Civil 199</span><span>Bombeiros 193</span><span>SAMU 192</span><span>Polícia 190</span>${
          orgaos.map((o) => `<span>${esc(o.nome)}: ${esc(o.plantao || o.fixo)}</span>`).join("")}</div></div>
        ${abrigos.length ? `<div><strong>Abrigos da cidade</strong><ul class="plano-lista">${[...abrigos].sort((a, b) => (a.cidade || "").localeCompare(b.cidade || "") || (a.ordem ?? 99) - (b.ordem ?? 99)).map((a) => `<li>${esc(a.nome)}${a.endereco ? `, ${esc(a.endereco)}` : ""}${a.cidade ? ` (${esc(a.cidade)})` : ""}${a.ordem ? `: ${a.ordem === 1 ? "abre primeiro" : `${a.ordem}º a abrir`}` : ""}</li>`).join("")}</ul></div>` : ""}
        <p>Nível do rio e previsão: ${esc(siteDaCidade())}</p>
      </div>
    </div>`;
    atualizarPlanoVivo(plano);

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
      `<p>Página gerada em ${gerado.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: FUSO })}. Os dados são atualizados automaticamente a cada 30 minutos.</p>`,
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
      amanha?.min != null ? `Amanhã: deve ficar entre ${fmt(amanha.min, 1)} e ${fmt(amanha.pico_max ?? amanha.max, 1)} m.` : "",
      "Emergência: Defesa Civil 199",
    ].filter(Boolean).join("\n");
  }

  // ------------------------------------------------------------ imagens (boletim e plano)
  // Desenhadas no próprio aparelho, com 1080 px de largura (o tamanho do Instagram e do
  // WhatsApp) e o dobro de pixels, para o texto ficar nítido. O alerta do Telegram usa a
  // mesma imagem do boletim, gerada pelo coletor num navegador sem tela (window.ReguaViva).
  const CORES_FAIXA = {
    normal: ["#2E7D4F", "#FFFFFF"], atencao: ["#F2C200", "#121A1E"], alerta: ["#E8710A", "#121A1E"],
    emergencia: ["#C62828", "#FFFFFF"], extremo: ["#5E2A84", "#FFFFFF"],
  };
  const IMG = { largura: 1080, margem: 64, escala: 2, papel: "#F4F6F6", tinta: "#121A1E", suave: "#45535A", agua: "#1C6E8C", vermelho: "#C62828" };
  const fonteCond = (peso, px) => `${peso} ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  const fonteTexto = (peso, px) => `${peso} ${px}px "Atkinson Hyperlegible", Arial, sans-serif`;

  async function fontesProntas() {
    try {
      await Promise.all([fonteCond(800, 100), fonteCond(700, 40), fonteTexto(400, 30), fonteTexto(700, 30)].map((f) => document.fonts.load(f)));
      await document.fonts.ready;
    } catch (_) { /* sem as fontes da web, usa as do aparelho */ }
  }

  function novaTela(altura) {
    const cv = document.createElement("canvas");
    cv.width = IMG.largura * IMG.escala;
    cv.height = altura * IMG.escala;
    const g = cv.getContext("2d");
    g.scale(IMG.escala, IMG.escala);
    return { cv, g };
  }

  // escreve quebrando as linhas; para no limite de linhas (com reticências) e devolve o y seguinte
  function escrever(g, texto, x, y, largura, alturaLinha, maxLinhas = 99) {
    const linhas = [];
    for (const paragrafo of String(texto).split("\n")) {
      let linha = "";
      for (const p of paragrafo.split(/\s+/).filter(Boolean)) {
        const teste = linha ? `${linha} ${p}` : p;
        if (g.measureText(teste).width > largura && linha) { linhas.push(linha); linha = p; } else linha = teste;
      }
      linhas.push(linha);
    }
    if (linhas.length > maxLinhas) {
      linhas.length = maxLinhas;
      linhas[maxLinhas - 1] = linhas[maxLinhas - 1].replace(/\s*\S*$/, "") + "…";
    }
    for (const l of linhas) { g.fillText(l, x, y); y += alturaLinha; }
    return y;
  }

  const paraPng = (cv) => new Promise((ok) => cv.toBlob(ok, "image/png"));
  const canalAlertas = () => ((D.config.alertas || {}).telegram_canal || "").replace(/^@/, "");

  // celular: abre a tela de compartilhar (WhatsApp, Instagram...); computador: baixa a imagem
  async function compartilharImagem(blob, nomeArquivo, legenda, botao) {
    const arquivo = new File([blob], nomeArquivo, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      await navigator.share({ files: [arquivo], text: legenda });
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = nomeArquivo;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    botao.textContent = "Imagem salva: é só mandar no WhatsApp ou postar no Instagram";
  }

  // ---- boletim: 1080 x 1350 (retrato do Instagram)
  async function desenharBoletim() {
    await fontesProntas();
    const W = IMG.largura, H = 1350, M = IMG.margem;
    const { cv, g } = novaTela(H);
    const c = D.config, a = D.atual, st = statusDe(a.nivel);
    const [cor, corTexto] = CORES_FAIXA[st.id] || CORES_FAIXA.normal;
    g.fillStyle = IMG.papel; g.fillRect(0, 0, W, H);

    // cabeçalho
    g.fillStyle = IMG.tinta; g.fillRect(0, 0, W, 128);
    g.fillStyle = IMG.papel; g.font = fonteCond(800, 60); g.fillText(c.nome_app.toUpperCase(), M, 86);
    g.textAlign = "right"; g.font = fonteTexto(400, 26); g.fillStyle = "#A9B6BB";
    g.fillText(c.rio, W - M, 56); g.fillText(c.local, W - M, 92);
    g.textAlign = "left";

    // bloco da faixa: o número grande na cor do alerta
    const yB = 128, hB = 350;
    g.fillStyle = cor; g.fillRect(0, yB, W, hB);
    g.fillStyle = corTexto;
    g.font = fonteTexto(700, 30);
    g.fillText(`Atualizado às ${horaCurta(a.hora)} de ${SEMANA[diaSemana(a.hora)]} (${dataCurta(a.hora)})`, M, yB + 62);
    g.font = fonteCond(800, 212);
    const numero = fmt(a.nivel);
    g.fillText(numero, M - 6, yB + 246);
    const wNum = g.measureText(numero).width;
    g.font = fonteCond(800, 84); g.fillText("m", M + wNum + 6, yB + 246);
    g.font = fonteCond(800, 58);
    const nomeFaixa = st.nome.toUpperCase();
    g.fillText(nomeFaixa, M, yB + 318);
    const wFaixa = g.measureText(nomeFaixa).width;
    g.font = fonteCond(700, 40); g.fillText(textoTendencia(a.tendencia_cm_h)[0], M + wFaixa + 28, yB + 316);

    // manchete, risco e próximo marco
    const yDias = 958;
    let y = yB + hB + 70;
    const [tit, sub] = manchete();
    g.fillStyle = IMG.tinta; g.font = fonteCond(800, 62);
    y = escrever(g, tit, M, y, W - 2 * M, 64, 2);
    g.font = fonteTexto(400, 33); g.fillStyle = "#26323A";
    y = escrever(g, sub.replace(/<[^>]+>/g, ""), M, y + 6, W - 2 * M, 44, 2);
    const prox = [...(c.regua || [])].filter((m) => m.cota != null && m.cota > a.nivel).sort((p, q) => p.cota - q.cota)[0];
    if (prox && y < yDias - 70) {
      const falta = prox.cota - a.nivel;
      g.font = fonteTexto(700, 28); g.fillStyle = IMG.agua;
      y = escrever(g, `Próximo marco: ${fmt(prox.cota)} m, ${prox.titulo.charAt(0).toLowerCase()}${prox.titulo.slice(1)} (faltam ${falta < 1 ? `${Math.round(falta * 100)} cm` : `${fmt(falta)} m`}).`, M, y + 10, W - 2 * M, 38, 2);
    }
    // o que fazer agora, com a barra na cor da faixa (o recado mais útil para quem recebe a imagem)
    const fazer = (c.o_que_fazer || {})[st.id] || FAZER_PADRAO[st.id];
    if (fazer && y < yDias - 130) {
      const yF = y + 18;
      g.fillStyle = IMG.tinta; g.font = fonteCond(800, 34); g.fillText("O QUE FAZER AGORA", M + 30, yF + 30);
      g.font = fonteTexto(400, 29);
      const yFim = escrever(g, fazer, M + 30, yF + 70, W - 2 * M - 30, 39, Math.max(1, Math.floor((yDias - 36 - (yF + 70)) / 39) + 1));
      g.fillStyle = cor; g.fillRect(M, yF, 10, yFim - yF - 22);
    }

    // próximos 3 dias
    g.fillStyle = IMG.tinta; g.fillRect(M, yDias, W - 2 * M, 4);
    g.font = fonteTexto(700, 24); g.fillStyle = IMG.suave;
    g.fillText("PRÓXIMOS DIAS · PREVISÃO EM TESTE", M, yDias + 40);
    const colW = (W - 2 * M) / 3;
    D.previsao_dias.slice(1, 4).forEach((d, i) => {
      const x0 = M + i * colW;
      const ate = d.pico_max ?? d.max ?? d.media;
      g.fillStyle = (CORES_FAIXA[statusDe(ate).id] || CORES_FAIXA.normal)[0];
      g.fillRect(x0, yDias + 60, colW - 28, 10);
      g.fillStyle = IMG.suave; g.font = fonteCond(700, 36); g.fillText(nomeDia(d.data).toUpperCase(), x0, yDias + 110);
      g.fillStyle = IMG.tinta; g.font = fonteCond(800, 68); g.fillText(`${fmt(d.media, 1)} m`, x0, yDias + 176);
      if (d.min != null) { g.fillStyle = IMG.suave; g.font = fonteTexto(400, 24); g.fillText(`entre ${fmt(d.min, 1)} e ${fmt(ate, 1)} m`, x0, yDias + 212); }
    });

    // rodapé: site, canal de alertas e o 199
    g.fillStyle = IMG.tinta; g.font = fonteTexto(700, 26);
    g.fillText(siteDaCidade().replace(/^https?:\/\//, "").replace(/\/$/, ""), M, H - 132);
    if (canalAlertas()) { g.textAlign = "right"; g.fillText(`Alertas: t.me/${canalAlertas()}`, W - M, H - 132); g.textAlign = "left"; }
    g.fillStyle = IMG.vermelho; g.fillRect(0, H - 104, W, 104);
    g.fillStyle = "#FFFFFF"; g.font = fonteCond(800, 50); g.fillText("EMERGÊNCIA: DEFESA CIVIL 199", M, H - 36);
    return cv;
  }

  async function boletimImagem() {
    const botao = $("#boletim-imagem");
    const original = botao.textContent;
    try {
      const blob = await paraPng(await desenharBoletim());
      await compartilharImagem(blob, `boletim-${D.config.slug}.png`, `${textoBoletim()}\n${siteDaCidade()}`, botao);
    } catch (e) {
      if (e?.name === "AbortError") return;
      botao.textContent = "Não foi possível gerar a imagem";
    }
    setTimeout(() => { botao.textContent = original; }, 3500);
  }

  // ---- plano da família: 1080 de largura, altura conforme o que foi preenchido
  function desenharPlanoEm(g, plano, desenhar) {
    const W = IMG.largura, M = IMG.margem, c = D.config;
    const local = listaLocais().find((x) => x.nome === plano.lugar);
    const pintar = (fn) => { if (desenhar) fn(); };
    pintar(() => { g.fillStyle = IMG.papel; g.fillRect(0, 0, W, 6000); });
    // cabeçalho
    pintar(() => {
      g.fillStyle = IMG.tinta; g.fillRect(0, 0, W, 220);
      g.fillStyle = IMG.papel; g.font = fonteCond(800, 66); g.fillText("PLANO DA FAMÍLIA PARA CHEIAS", M, 98);
      g.font = fonteTexto(700, 34); g.fillStyle = "#A9B6BB";
      g.fillText(plano.familia || `${c.rio}, ${c.local}`, M, 160);
      if (plano.familia) { g.font = fonteTexto(400, 26); g.fillText(`${c.rio}, ${c.local}`, M, 198); }
    });
    let y = 220;
    let numero = 0;
    const passo = (titulo, linhas, destaque) => {
      if (!linhas.filter(Boolean).length && !destaque) return;
      numero += 1;
      const topo = y + 36;
      g.font = fonteTexto(400, 32);
      let yy = topo + 92;
      if (destaque) yy += 60;
      const corpoInicio = yy;
      // mede o texto (ou escreve)
      g.fillStyle = IMG.tinta;
      // na passada de medida, g é uma tela de rascunho: escrever nela só serve para contar as linhas
      for (const l of linhas.filter(Boolean)) yy = escrever(g, l, M + 108, yy, W - 2 * M - 108, 42);
      pintar(() => {
        g.fillStyle = IMG.agua; g.fillRect(M, topo, 80, 80);
        g.fillStyle = "#FFFFFF"; g.font = fonteCond(800, 64); g.textAlign = "center"; g.fillText(String(numero), M + 40, topo + 62); g.textAlign = "left";
        g.fillStyle = IMG.tinta; g.font = fonteCond(800, 46); g.fillText(titulo.toUpperCase(), M + 108, topo + 54);
        if (destaque) { g.font = fonteCond(800, 96); g.fillText(destaque, M + 108, corpoInicio - 8); }
      });
      y = Math.max(yy, topo + 100) + 8;
      pintar(() => { g.fillStyle = "#CDD4D7"; g.fillRect(M, y + 18, W - 2 * M, 2); });
      y += 20;
    };
    passo("Nossa casa", [local ? `${local.nome}: a água chega lá com ${fmt(local.cota)} m.` : plano.lugar]);
    passo("Saímos de casa com o rio em", [], alturaSair(plano.sair));
    passo("Para onde vamos", [plano.abrigo && `Vamos para: ${plano.abrigo}`, plano.encontro && `Se a família se separar: ${plano.encontro}`]);
    passo("Quem faz o quê", [plano.busca && `Busca crianças e idosos: ${plano.busca}`, plano.animais && `Animais vão para: ${plano.animais}`]);
    passo("Telefones da família", [plano.telefones]);
    const prontos = new Set(plano.mochila || []);
    passo("Mochila de emergência", MOCHILA.map((m) => `${prontos.has(m) ? "✔" : "☐"}  ${m}`));
    // rodapé: telefones de emergência e o link da previsão
    y += 24;
    const orgaos = ((c.contatos || {}).orgaos || []).filter((o) => o.nome && (o.plantao || o.fixo));
    pintar(() => {
      g.fillStyle = IMG.tinta; g.font = fonteTexto(700, 28);
      g.fillText("Defesa Civil 199 · Bombeiros 193 · SAMU 192 · Polícia 190", M, y + 30);
      g.font = fonteTexto(400, 26); g.fillStyle = IMG.suave;
      orgaos.forEach((o, i) => g.fillText(`${o.nome}: ${o.plantao || o.fixo}`, M, y + 72 + i * 36));
    });
    y += 72 + orgaos.length * 36 + 10;
    pintar(() => {
      g.fillStyle = IMG.agua; g.fillRect(0, y, W, 120);
      g.fillStyle = "#FFFFFF"; g.font = fonteTexto(700, 28); g.fillText("Nível do rio e previsão:", M, y + 48);
      g.font = fonteTexto(400, 28); g.fillText(siteDaCidade().replace(/^https?:\/\//, ""), M, y + 90);
    });
    return y + 120;
  }

  async function desenharPlano(plano) {
    await fontesProntas();
    const medida = document.createElement("canvas").getContext("2d");
    const altura = Math.ceil(desenharPlanoEm(medida, plano, false));
    const { cv, g } = novaTela(altura);
    desenharPlanoEm(g, plano, true);
    return cv;
  }

  async function mandarPlano() {
    const botao = $("#plano-whatsapp");
    const original = botao.textContent;
    const plano = salvarPlano();
    try {
      const blob = await paraPng(await desenharPlano(plano));
      const legenda = `Plano da família para cheias${plano.familia ? ` (${plano.familia})` : ""}. Nível do rio e previsão: ${siteDaCidade()}`;
      await compartilharImagem(blob, "plano-da-familia.png", legenda, botao);
    } catch (e) {
      if (e?.name === "AbortError") return;
      botao.textContent = "Não foi possível gerar a imagem";
    }
    setTimeout(() => { botao.textContent = original; }, 3500);
  }

  // para o coletor gerar a mesma imagem do boletim e mandar no alerta do Telegram
  window.ReguaViva = {
    pronto: () => D != null,
    cartaoBoletim: async () => (await desenharBoletim()).toDataURL("image/png"),
  };

  // ------------------------------------------------------------ navegação
  // ------------------------------------------------------------ abas
  const ABAS = ["agora", "previsao", "historico", "emergencia"];
  const APELIDOS = { boletim: "agora", proximos: "previsao" }; // endereços antigos
  let abaAtual = "agora";

  function renderAba(nome) {
    if (nome === "agora") renderImpactos();
    if (nome === "previsao") { renderRioAcima(); mostrarGrafico(graficoAtivo); renderTempo(); renderPlacar(); }
    if (nome === "historico") { renderRegua(); renderHistorico(); }
    if (nome === "emergencia") renderPlano();
  }

  function abrirAba(nome, rolar = true) {
    nome = APELIDOS[nome] || nome;
    if (!ABAS.includes(nome)) nome = "agora";
    abaAtual = nome;
    ABAS.forEach((a) => { $(`#${a}`).hidden = a !== nome; });
    $$(".atalhos a[data-aba]").forEach((l) => {
      const ativa = l.dataset.aba === nome;
      l.classList.toggle("ativo", ativa);
      l.setAttribute("aria-selected", ativa);
      if (ativa) l.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    renderAba(nome);
    if (location.hash !== `#${nome}`) history.replaceState(null, "", `#${nome}`);
    if (rolar) window.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });
  }

  function renderTudo() {
    renderTopo();
    renderAgora();
    renderPorque();
    renderEmergencia();
    renderRodape();
    renderAba(abaAtual);
  }

  function ligarEventos() {
    $$("#periodo-historico button").forEach((b) => b.addEventListener("click", () => {
      $$("#periodo-historico button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      diasHistorico = Number(b.dataset.dias);
      if (typeof Chart !== "undefined") graficoHistorico();
    }));
    $$("#alterna-grafico button").forEach((b) => b.addEventListener("click", () => mostrarGrafico(b.dataset.grafico)));
    $$("#camada-tempo button").forEach((b) => b.addEventListener("click", () => renderTempo(b.dataset.camada, true)));
    $("#mapa-abrir").addEventListener("click", () => renderTempo(camadaTempo, true));
    $("#mostrar-pontes").addEventListener("change", () => { if (typeof Chart !== "undefined") graficoHistorico(); });
    $("#boletim-imagem").addEventListener("click", boletimImagem);
    $("#imprimir-plano").addEventListener("click", () => { salvarPlano(); window.print(); });
    $("#plano-whatsapp").addEventListener("click", mandarPlano);
    $("#plano-conteudo").addEventListener("input", salvarPlano);
    $("#plano-conteudo").addEventListener("change", salvarPlano);
    // sugestões de altura para sair de casa (1 m e 50 cm antes da água chegar)
    $("#plano-conteudo").addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-sair]");
      if (!chip) return;
      $("#plano-sair").value = chip.dataset.sair;
      salvarPlano();
    });
    $("#plano-limpar").addEventListener("click", () => {
      if (!confirm("Apagar o plano preenchido neste celular?")) return;
      try { localStorage.removeItem(chavePlano()); } catch (_) { /* nada guardado */ }
      renderPlano();
    });
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
    window.addEventListener("resize", () => {
      clearTimeout(espera);
      espera = setTimeout(() => { if (abaAtual === "historico") renderRegua(); if (abaAtual === "agora") renderImpactos(); }, 150);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderTudo);

    // abas: clique no menu e endereço (#agora, #previsao...) na barra
    $$(".atalhos a[data-aba]").forEach((l) => l.addEventListener("click", (ev) => { ev.preventDefault(); abrirAba(l.dataset.aba); }));
    window.addEventListener("hashchange", () => abrirAba(location.hash.slice(1), false));
    $$('a[href="#agora"]').forEach((l) => l.addEventListener("click", (ev) => { ev.preventDefault(); abrirAba("agora"); }));
  }

  function mostrarErro(msg) {
    const el = $("#erro");
    el.textContent = msg;
    el.hidden = false;
    $$("main > section").forEach((p) => (p.hidden = true));
  }

  // ------------------------------------------------------------ app instalável
  function prepararApp() {
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(() => { /* sem app, o site continua funcionando */ });
    }
    window.addEventListener("online", atualizarBoletim);
    window.addEventListener("offline", atualizarAvisoOffline);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") atualizarBoletim(); });
    setInterval(atualizarBoletim, INTERVALO_ATUALIZACAO_MS);
    setInterval(() => { if (D) { renderTopo(); atualizarAvisoOffline(); } }, 60 * 1000); // idade da leitura

    const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    if (instalado) return;
    const botao = $("#instalar");
    let pedido = null;
    // Android e computador: o navegador avisa quando dá para instalar
    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      pedido = ev;
      botao.hidden = false;
    });
    botao.addEventListener("click", async () => {
      if (pedido) {
        pedido.prompt();
        await pedido.userChoice.catch(() => null);
        pedido = null;
        botao.hidden = true;
      } else {
        $("#dica-instalar").hidden = false;
      }
    });
    // iPhone: não há aviso automático; o botão mostra como fazer
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (iphone) botao.hidden = false;
    window.addEventListener("appinstalled", () => { botao.hidden = true; $("#dica-instalar").hidden = true; });
  }

  async function iniciar() {
    prepararApp();
    try {
      D = await carregar();
    } catch (e) {
      mostrarErro(e.message || "Não foi possível carregar os dados.");
      return;
    }
    if (typeof Chart !== "undefined") Chart.register(linhasPlugin);
    ligarEventos();
    abaAtual = APELIDOS[location.hash.slice(1)] || (ABAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "agora");
    renderTudo();
    abrirAba(abaAtual, false);
    atualizarAvisoOffline();
  }


  iniciar();
})();
