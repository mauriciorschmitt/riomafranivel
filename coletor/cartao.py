"""Gera a imagem do boletim, a mesma do botão "Mandar boletim no WhatsApp" do site.

O desenho fica num lugar só (docs/app.js). Aqui o site é aberto num navegador sem
tela (Playwright + Chromium), que chama window.ReguaViva.cartaoBoletim() e devolve
o PNG. Usado pelos alertas do Telegram. Sem o Playwright instalado, devolve None e
o alerta sai só em texto.

No GitHub Actions o navegador só é instalado quando há alerta para mandar.
"""
from __future__ import annotations

import base64
import functools
import http.server
import os
import threading

from . import base


class _Silencioso(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def imagem_boletim(slug: str, espera_ms: int = 60000) -> bytes | None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("     aviso: Playwright não instalado; o alerta vai só em texto")
        return None
    servidor = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Silencioso, directory=str(base.PASTA_SITE)))
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            # REGUA_NAVEGADOR=msedge usa o Edge já instalado (para testar no Windows)
            navegador = p.chromium.launch(channel=os.environ.get("REGUA_NAVEGADOR") or None)
            pagina = navegador.new_context(service_workers="block").new_page()
            pagina.goto(f"http://127.0.0.1:{servidor.server_address[1]}/?cidade={slug}", timeout=espera_ms)
            pagina.wait_for_function("window.ReguaViva && window.ReguaViva.pronto()", timeout=espera_ms)
            dados = pagina.evaluate("() => window.ReguaViva.cartaoBoletim()")
            navegador.close()
        return base64.b64decode(dados.split(",", 1)[1])
    except Exception as erro:  # qualquer falha aqui só tira a imagem do alerta
        print(f"     aviso: não foi possível gerar a imagem do boletim ({type(erro).__name__}: {erro})")
        return None
    finally:
        servidor.shutdown()
