/* Régua Viva: funcionamento sem internet.
   Estratégia "rede primeiro": sempre tenta buscar a versão mais nova (dados,
   página, estilo e código). Só quando não há internet usa a última cópia guardada.
   Assim o app nunca mostra dado velho quando há sinal, e mostra o último boletim
   quando não há. */
const CACHE = "regua-viva-v1";
const BASE = ["./", "./index.html", "./manifest.webmanifest", "./icones/icone-192.png"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // o mapa do tempo e as fontes não funcionam sem internet de qualquer jeito: deixa passar
  if (url.hostname.endsWith("windy.com")) return;
  ev.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && (resp.ok || resp.type === "opaque")) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return resp;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: url.pathname.endsWith(".css") || url.pathname.endsWith(".js") })
          .then((r) => r || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
