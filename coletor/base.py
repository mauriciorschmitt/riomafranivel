"""Base persistente em arquivos CSV/JSON dentro do próprio repositório.

A telemetria da ANA só guarda algumas semanas online com boa disponibilidade,
então cada execução acrescenta as leituras novas em dados/<cidade>/. Com o
tempo isso vira o histórico usado para treinar o modelo.
"""
from __future__ import annotations

import csv
import datetime as dt
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PASTA_DADOS = RAIZ / "dados"
PASTA_CONFIG = RAIZ / "config" / "cidades"
PASTA_SITE = RAIZ / "docs"
DIAS_GUARDADOS = 1100  # ~3 anos


def chave_montante(m: dict) -> str | None:
    """Identificador da estação rio acima: código ANA ou "copel-<nome>"."""
    if m.get("codigo"):
        return str(m["codigo"])
    if m.get("estacao_copel"):
        import unicodedata
        nome = unicodedata.normalize("NFD", m["estacao_copel"]).encode("ascii", "ignore").decode().lower()
        return "copel-" + "-".join(nome.split())
    return None


def pasta(slug: str) -> Path:
    p = PASTA_DADOS / slug
    p.mkdir(parents=True, exist_ok=True)
    return p


def carregar_config(slug: str) -> dict:
    with open(PASTA_CONFIG / f"{slug}.json", encoding="utf-8") as f:
        return json.load(f)


def listar_cidades() -> list[str]:
    return sorted(p.stem for p in PASTA_CONFIG.glob("*.json") if not p.stem.startswith("_"))


def _float(v):
    return None if v in ("", None) else float(v)


NIVEL_MAXIMO_VALIDO_M = 40.0  # acima disso é código de erro (a ANA usa 7777,777, 9999 etc.)
DESVIO_PICO_M = 1.0  # leitura isolada que foge mais que isso das vizinhas é falha do sensor


def limpar_leituras(leituras: list[dict]) -> list[dict]:
    """Remove códigos de erro e picos isolados de falha do sensor.

    1. Descarta níveis negativos ou acima de 40 m (códigos como 7777,777).
    2. Descarta a leitura que foge mais de 1 m da mediana das 4 vizinhas
       (2 antes e 2 depois). Uma subida real dura várias leituras e passa;
       um pico de falha é uma leitura só e é removido.
    Chuva e vazão da leitura removida também são descartadas.
    """
    validas = [l for l in leituras if l["nivel_m"] is not None and 0 <= l["nivel_m"] <= NIVEL_MAXIMO_VALIDO_M]
    limpas = []
    for i, l in enumerate(validas):
        vizinhas = [v["nivel_m"] for v in validas[max(0, i - 2): i] + validas[i + 1: i + 3]]
        if len(vizinhas) >= 2:
            vizinhas.sort()
            meio = len(vizinhas) // 2
            mediana = vizinhas[meio] if len(vizinhas) % 2 else (vizinhas[meio - 1] + vizinhas[meio]) / 2
            if abs(l["nivel_m"] - mediana) > DESVIO_PICO_M:
                continue
        limpas.append(l)
    return limpas


def ler_leituras(caminho: Path) -> list[dict]:
    if not caminho.exists():
        return []
    with open(caminho, encoding="utf-8") as f:
        return limpar_leituras([
            {
                "hora": dt.datetime.fromisoformat(r["hora"]),
                "nivel_m": _float(r["nivel_m"]),
                "chuva_mm": _float(r.get("chuva_mm")),
                "vazao_m3s": _float(r.get("vazao_m3s")),
            }
            for r in csv.DictReader(f)
        ])


def mesclar_leituras(antigas: list[dict], novas: list[dict], agora: dt.datetime) -> list[dict]:
    todas = {l["hora"]: l for l in antigas}
    todas.update({l["hora"]: l for l in novas})
    limite = agora - dt.timedelta(days=DIAS_GUARDADOS)
    return limpar_leituras([todas[h] for h in sorted(todas) if limite <= h <= agora + dt.timedelta(hours=1)])


def salvar_leituras(caminho: Path, leituras: list[dict]) -> None:
    with open(caminho, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["hora", "nivel_m", "chuva_mm", "vazao_m3s"])
        for l in leituras:
            w.writerow([
                l["hora"].isoformat(timespec="minutes"),
                "" if l["nivel_m"] is None else round(l["nivel_m"], 3),
                "" if l.get("chuva_mm") is None else l["chuva_mm"],
                "" if l.get("vazao_m3s") is None else l["vazao_m3s"],
            ])


def ler_maximas(slug: str, config: dict) -> dict[int, float]:
    """Máximas anuais: CSV baixado da ANA + valores extras da configuração."""
    maximas: dict[int, float] = {}
    caminho = pasta(slug) / "maximas_anuais.csv"
    if caminho.exists():
        with open(caminho, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                maximas[int(r["ano"])] = float(r["cota_m"])
    for ano, cota in (config.get("maximas_anuais_extra") or {}).items():
        if str(ano).startswith("_"):
            continue
        maximas[int(ano)] = max(float(cota), maximas.get(int(ano), 0.0))
    return dict(sorted(maximas.items()))


def salvar_maximas(slug: str, maximas: dict[int, float]) -> None:
    with open(pasta(slug) / "maximas_anuais.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ano", "cota_m"])
        for ano, cota in sorted(maximas.items()):
            w.writerow([ano, round(cota, 3)])


def ler_json(caminho: Path, padrao=None):
    if not caminho.exists():
        return padrao
    with open(caminho, encoding="utf-8") as f:
        return json.load(f)


def salvar_json(caminho: Path, dados, compacto: bool = False) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        if compacto:
            json.dump(dados, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(dados, f, ensure_ascii=False, indent=2)


HORA_BOLETIM = 7  # a previsão guardada para o placar é a primeira do dia a partir das 7h


def guardar_previsao(slug: str, saida: dict, agora: dt.datetime) -> dict:
    """Guarda uma previsão por dia (a das 7h) para depois comparar com o que o rio fez."""
    caminho = pasta(slug) / "previsoes.json"
    arquivo = ler_json(caminho, {})
    hoje = agora.date().isoformat()
    if agora.hour >= HORA_BOLETIM and hoje not in arquivo and not saida.get("demo"):
        arquivo[hoje] = {
            "emitida": saida["gerado_em"],
            "nivel_atual": saida["atual"]["nivel"],
            "dias": [
                {k: d.get(k) for k in ("data", "media", "min", "max", "prob_inundacao")}
                for d in saida["previsao_dias"][1:]
            ],
        }
        limite = (agora.date() - dt.timedelta(days=400)).isoformat()
        arquivo = {k: v for k, v in sorted(arquivo.items()) if k >= limite}
        salvar_json(caminho, arquivo)
    return arquivo


def publicar(slug: str, saida: dict) -> Path:
    """Grava o JSON do painel e atualiza o índice de cidades do site."""
    destino = PASTA_SITE / "dados" / f"{slug}.json"
    salvar_json(destino, saida, compacto=True)
    indice_caminho = PASTA_SITE / "dados" / "indice.json"
    indice = ler_json(indice_caminho, {"cidades": []})
    outras = [c for c in indice["cidades"] if c["slug"] != slug]
    cfg = saida["config"]
    outras.append({"slug": slug, "nome": cfg["nome_app"], "local": cfg["local"]})
    salvar_json(indice_caminho, {"cidades": sorted(outras, key=lambda c: c["nome"])})
    return destino
