"""Procura estações telemétricas da ANA por nome, município ou rio.

Uso:
  python ferramentas/buscar_estacoes.py blumenau
  python ferramentas/buscar_estacoes.py "rio do sul" --uf SC

Mostra código, nome, rio, município e coordenadas: é o que vai em
config/cidades/<cidade>.json ("estacao" e "montante").
"""
import argparse
import sys
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from coletor.ana import _get  # noqa: E402


def normalizar(texto):
    texto = unicodedata.normalize("NFD", str(texto or "")).encode("ascii", "ignore").decode()
    return texto.lower()


def estacoes():
    xml = _get("ListaEstacoesTelemetricas", {"statusEstacoes": "0", "origem": "0"})
    for el in ET.fromstring(xml).iter():
        campos = {f.tag.split("}")[-1]: (f.text or "").strip() for f in el}
        if "CodEstacao" in campos:
            yield campos


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("texto", help="parte do nome da estação, do município ou do rio")
    p.add_argument("--uf", default="SC", help="sigla do estado (padrão: SC; use '' para todos)")
    a = p.parse_args()
    alvo, uf = normalizar(a.texto), normalizar(a.uf)
    achadas = 0
    for e in estacoes():
        tudo = normalizar(" ".join(e.values()))
        if alvo in tudo and (not uf or uf in normalizar(e.get("Municipio-UF", "") + " " + e.get("UF", ""))):
            achadas += 1
            print(
                f"{e.get('CodEstacao')}  {e.get('NomeEstacao', '?')}  |  rio: {e.get('NomeRio', '?')}  |  "
                f"{e.get('Municipio-UF', '?')}  |  lat {e.get('Latitude', '?')}, lon {e.get('Longitude', '?')}"
            )
    if not achadas:
        print("Nada encontrado. Tente só uma parte do nome, ou procure no mapa: https://www.snirh.gov.br/hidrotelemetria/")


if __name__ == "__main__":
    main()
