/* Régua Viva: funcionamento sem internet.

   O que fica guardado no aparelho, já na primeira visita (na instalação):
   a página, o estilo, o código, o Chart.js, os ícones e o último boletim de
   cada cidade. Assim quem abriu o site uma vez consegue ver o último boletim
   mesmo sem sinal, que é justamente o que acontece numa enchente.

   Estratégias:
   * página e dados (dados/*.json): rede primeiro, com tempo-limite. Com sinal
     fraco, depois de alguns segundos mostra a cópia guardada em vez de ficar
     esperando. A resposta guardada vai marcada (cabeçalho x-regua-guardado)
     para o painel avisar que é um boletim antigo;
   * estilo e código com versão no endereço (?v=...) e o Chart.js: cópia
     guardada primeiro (o endereço muda quando o arquivo muda);
   * fontes do Google: cópia guardada, atualizada em segundo plano.

   VERSAO é trocada pelo coletor (base.carimbar_versao) sempre que a página, o
   estilo ou o código mudam. Isso instala um service worker novo, que guarda
   os arquivos novos e apaga os caches antigos. */
const VERSAO = "c7506cb3";
const CACHE_APP = `regua-viva-app-${VERSAO}`;
const CACHE_DADOS = "regua-viva-dados";
const CACHE_FONTES = "regua-viva-fontes";
const CACHES = [CACHE_APP, CACHE_DADOS, CACHE_FONTES];
const ESPERA_REDE_MS = 4000;

const FIXOS = ["./", "./manifest.webmanifest", "./icones/icone-192.png", "./icones/icone-512.png"];

// arquivos que a página carrega (estilo, código, Chart.js), lidos do próprio index.html
async function arquivosDaPagina(html) {
  const enderecos = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  return enderecos.filter((e) => /\.(js|css)(\?|$)/.test(e) && !e.includes("fonts.googleapis.com"));
}

async function guardarBoletins(cache) {
  const r = await fetch("dados/indice.json", { cache: "no-cache" });
  if (!r.ok) return;
  await cache.put("dados/indice.json", r.clone());
  const { cidades = [] } = await r.json();
  await Promise.allSettled(cidades.map(async (c) => {
    const url = `dados/${encodeURIComponent(c.slug)}.json`;
    const resp = await fetch(url, { cache: "no-cache" });
    if (resp.ok) await cache.put(url, resp);
  }));
}

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const app = await caches.open(CACHE_APP);
    const pagina = await fetch("./", { cache: "no-cache" });
    if (!pagina.ok) throw new Error("página indisponível");
    const html = await pagina.clone().text();
    await app.put("./", pagina);
    await app.addAll(FIXOS.filter((f) => f !== "./"));
    // o Chart.js vem de outro site; se ele estiver fora do ar, o resto continua
    await Promise.allSettled((await arquivosDaPagina(html)).map((u) => app.add(new Request(u, { mode: "cors" }))));
    await guardarBoletins(await caches.open(CACHE_DADOS)).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes.filter((n) => n.startsWith("regua-viva") && !CACHES.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function comTempoLimite(promessa, ms) {
  return new Promise((ok, falha) => {
    const t = setTimeout(() => falha(new Error("tempo esgotado")), ms);
    promessa.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); falha(e); });
  });
}

async function marcarGuardado(resp) {
  const cabecalhos = new Headers(resp.headers);
  cabecalhos.set("x-regua-guardado", "1");
  return new Response(await resp.blob(), { status: resp.status, statusText: resp.statusText, headers: cabecalhos });
}

// rede primeiro; sem rede (ou rede lenta demais), a cópia guardada
async function redePrimeiro(ev, nomeCache, chave) {
  const cache = await caches.open(nomeCache);
  const daRede = fetch(ev.request).then((resp) => {
    if (resp.ok) ev.waitUntil(cache.put(chave, resp.clone()));
    return resp;
  });
  try {
    return await comTempoLimite(daRede, ESPERA_REDE_MS);
  } catch (_) {
    const guardada = await cache.match(chave);
    if (guardada) {
      ev.waitUntil(daRede.catch(() => {})); // se a rede responder depois, a cópia é atualizada
      return marcarGuardado(guardada);
    }
    return daRede; // nada guardado: espera a rede de qualquer jeito
  }
}

// cópia guardada primeiro (arquivos que mudam de endereço quando mudam de conteúdo)
async function guardadoPrimeiro(ev, nomeCache) {
  const cache = await caches.open(nomeCache);
  const guardada = await cache.match(ev.request);
  if (guardada) return guardada;
  const resp = await fetch(ev.request);
  if (resp.ok) ev.waitUntil(cache.put(ev.request, resp.clone()));
  return resp;
}

// cópia guardada na hora, atualizada em segundo plano (fontes)
async function guardadoEAtualiza(ev, nomeCache) {
  const cache = await caches.open(nomeCache);
  const guardada = await cache.match(ev.request);
  const daRede = fetch(ev.request).then((resp) => {
    if (resp.ok) ev.waitUntil(cache.put(ev.request, resp.clone()));
    return resp;
  });
  if (guardada) {
    ev.waitUntil(daRede.catch(() => {}));
    return guardada;
  }
  return daRede;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const local = url.origin === self.location.origin;

  if (req.mode === "navigate" && local) {
    ev.respondWith(redePrimeiro(ev, CACHE_APP, "./"));
  } else if (local && /\/dados\/[^/]+\.json$/.test(url.pathname)) {
    ev.respondWith(redePrimeiro(ev, CACHE_DADOS, `dados/${url.pathname.split("/").pop()}`));
  } else if ((local && url.searchParams.has("v")) || url.hostname === "cdn.jsdelivr.net") {
    ev.respondWith(guardadoPrimeiro(ev, CACHE_APP));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    ev.respondWith(guardadoEAtualiza(ev, CACHE_FONTES));
  } else if (local) {
    ev.respondWith(guardadoPrimeiro(ev, CACHE_APP).catch(() => caches.match(req)));
  }
  // o resto (mapa do tempo, links externos) vai direto para a rede
});
