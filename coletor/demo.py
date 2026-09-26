"""Gera dados sintéticos plausíveis e publica o painel em modo demonstração.

Serve para ver e ajustar o site sem depender da ANA nem do Open-Meteo, e é
também o teste de ponta a ponta do processamento. O painel mostra uma faixa
avisando que os dados são fictícios.

Uso: python -m coletor.demo --cidade mafra-rionegro
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import random

from . import base, modelo as mod
from .processar import processar

DIAS = 420


def _chuva_diaria(rng: random.Random, n: int) -> list[float]:
    """Chuva diária com eventos agrupados, ~1.500 mm/ano (típico do planalto de SC)."""
    chuva, molhado = [], False
    for _ in range(n):
        molhado = rng.random() < (0.55 if molhado else 0.22)
        chuva.append(round(rng.gammavariate(0.8, 14.0), 1) if molhado else 0.0)
    return chuva


def _hidrograma(chuva: list[float], base_m: float = 1.6) -> list[float]:
    """Rio 'verdadeiro' da simulação: reservatório linear com solo que satura."""
    kernel = [(t**2) * math.exp(-t / 1.1) for t in range(12)]
    soma = sum(kernel)
    kernel = [k / soma for k in kernel]
    api, efetiva = 0.0, []
    for p in chuva:
        api = 0.85 * api + p
        efetiva.append(p * min(1.0, 0.25 + api / 120.0))
    nivel = []
    for i in range(len(chuva)):
        vazao = sum(kernel[k] * efetiva[i - k] for k in range(len(kernel)) if i - k >= 0)
        nivel.append(base_m + 1.55 * vazao**0.62)
    return nivel


def gerar_bruto(config: dict, agora: dt.datetime, semente: int = 7) -> tuple[dict, dict[int, float], dict]:
    rng = random.Random(semente)
    hoje = agora.date()
    n = DIAS + 8
    chuva = _chuva_diaria(rng, n)
    # últimas semanas com três frentes frias, para a demo mostrar algo interessante
    for dias_atras, mm in [(26, 55), (25, 38), (14, 62), (13, 30), (5, 34), (4, 16)]:
        chuva[DIAS - dias_atras] = mm
    for i in range(DIAS - 3, DIAS + 1):
        chuva[i] = 0.0
    for i, mm in zip(range(DIAS + 1, DIAS + 8), [0.0, 0.0, 6.2, 14.8, 11.5, 3.6, 0.0]):
        chuva[i] = mm
    niveis_dia = _hidrograma(chuva)
    datas = [hoje - dt.timedelta(days=DIAS - i) for i in range(n)]

    telemetria = []
    inicio = dt.datetime.combine(datas[0], dt.time())
    passos = int((agora - inicio).total_seconds() // 900)
    for k in range(passos + 1):
        hora = inicio + dt.timedelta(minutes=15 * k)
        x = (hora - inicio).total_seconds() / 86400
        i = min(int(x), n - 2)
        frac = x - i
        nivel = niveis_dia[i] + (niveis_dia[i + 1] - niveis_dia[i]) * (3 * frac**2 - 2 * frac**3)
        telemetria.append({
            "hora": hora,
            "nivel_m": round(nivel + rng.gauss(0, 0.004), 3),
            "chuva_mm": round(chuva[i] / 96, 2),
            "vazao_m3s": None,
        })

    pontos = config["bacia"]["pontos"]
    diario, horaria_por_ponto, solo = {}, {p["nome"]: {} for p in pontos}, {}
    codigos = {0: 3, 10: 61, 25: 95, 20: 95, 5: 80}
    for i in range(DIAS - 7, n):
        data = datas[i].isoformat()
        mm = chuva[i]
        diario[data] = {
            "chuva_mm": mm,
            "prob": min(99, int(15 + mm * 3.2)) if i > DIAS else None,
            "tmax": round(24 + 5 * math.sin(i / 3) + rng.uniform(-1, 1)),
            "tmin": round(13 + 3 * math.sin(i / 4) + rng.uniform(-1, 1)),
            "codigo": codigos.get(round(mm / 5) * 5, 3 if mm < 1 else 63),
        }
        for j, p in enumerate(pontos):
            fator = 0.8 + 0.15 * j
            for h in range(24):
                hora = dt.datetime.combine(datas[i], dt.time(h)).isoformat(timespec="minutes")
                horaria_por_ponto[p["nome"]][hora] = round(mm * fator / 24, 2)
    api = 0.0
    for i in range(n):
        api = 0.85 * api + chuva[i]
        if i >= DIAS - 7:
            for h in range(0, 24, 6):
                hora = dt.datetime.combine(datas[i], dt.time(h)).isoformat(timespec="minutes")
                solo[hora] = round(min(0.52, 0.26 + api / 600), 3)

    previsao = {"diario": diario, "chuva_por_ponto": {}, "chuva_horaria_por_ponto": horaria_por_ponto, "solo": solo}
    chuva_hist = {datas[i].isoformat(): chuva[i] for i in range(DIAS + 1)}
    glofas = {
        datas[i].isoformat(): round(18 * max(0.1, niveis_dia[i] - 1.2) ** 1.45, 1)
        for i in range(DIAS - 30, n)
    }
    maximas = {ano: round(6.9 - 1.66 * math.log(-math.log(rng.uniform(0.02, 0.98))), 2) for ano in range(1930, 2026)}
    for ano in rng.sample(range(1930, 2026), 58):
        maximas.pop(ano)

    telemetria = [l for l in telemetria if l["hora"] <= agora]
    bruto = {
        "agora": agora,
        "telemetria": telemetria,
        "montante": {},
        "previsao": previsao,
        "chuva_historica": chuva_hist,
        "glofas": glofas,
        "demo": True,
    }
    niveis_medios = {datas[i]: niveis_dia[i] for i in range(DIAS)}
    return bruto, maximas, {"niveis": niveis_medios, "chuva": chuva_hist}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cidade", required=True)
    args = parser.parse_args(argv)
    config = base.carregar_config(args.cidade)
    agora = dt.datetime.now().replace(second=0, microsecond=0)
    bruto, maximas, treino = gerar_bruto(config, agora)
    modelo = mod.treinar(treino["niveis"], treino["chuva"], config_modelo=config.get("previsao", {}))
    for ano, cota in (config.get("maximas_anuais_extra") or {}).items():
        if not str(ano).startswith("_"):
            maximas[int(ano)] = cota
    saida = processar(config, bruto, modelo, maximas)
    saida["avisos"] = []
    destino = base.publicar(args.cidade, saida)
    a = saida["atual"]
    print(f"demo publicada em {destino}: {a['nivel']:.2f} m, {a['status']['nome']}, modelo {modelo['tipo']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
