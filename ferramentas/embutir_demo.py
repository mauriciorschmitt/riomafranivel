"""Gera um único arquivo HTML com CSS, JS e dados embutidos (docs/demo.html).

Útil para mandar o painel por e-mail ou abrir sem servidor.
Uso: python ferramentas/embutir_demo.py mafra-rionegro
"""
import json
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"


def main(slug):
    html = (DOCS / "index.html").read_text(encoding="utf-8")
    css = (DOCS / "estilo.css").read_text(encoding="utf-8")
    js = (DOCS / "app.js").read_text(encoding="utf-8")
    dados = json.loads((DOCS / "dados" / f"{slug}.json").read_text(encoding="utf-8"))
    html = html.replace('<link rel="stylesheet" href="estilo.css">', f"<style>\n{css}\n</style>")
    bloco = json.dumps(dados, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace('<script src="app.js"></script>', f"<script>window.__DADOS__={bloco};</script>\n<script>\n{js}\n</script>")
    destino = DOCS / "demo.html"
    destino.write_text(html, encoding="utf-8")
    print(f"gerado {destino} ({destino.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "mafra-rionegro")
