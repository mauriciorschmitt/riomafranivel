"""Treina (ou retreina) o modelo de previsão de cada cidade.

Uso:
  python -m coletor.treinar --cidade mafra-rionegro
  python -m coletor.treinar --todas
  python -m coletor.treinar --cidade mafra-rionegro --historico   # também baixa as máximas anuais

Na primeira vez completa a base local com até `previsao.dias_treino` dias de
telemetria da ANA e de chuva do Open-Meteo (reanálise). Depois disso só
acrescenta o que falta. Rodar uma vez por semana é suficiente.
"""
from __future__ import annotations

import argparse
import datetime as dt
import statistics
import sys
from collections import defaultdict

from . import ana, base, modelo as mod, openmeteo
from .gerar import agora_local


def completar_telemetria(slug, codigo, arquivo, dias, agora, ajuste=0.0):
    caminho = base.pasta(slug) / arquivo
    leituras = base.ler_leituras(caminho)
    inicio_desejado = agora.date() - dt.timedelta(days=dias)
    primeira = leituras[0]["hora"].date() if leituras else agora.date()
    if primeira > inicio_desejado + dt.timedelta(days=7):
        print(f"  baixando telemetria {codigo} de {inicio_desejado} a {primeira}...")
        try:
            antigas = ana.telemetria(codigo, inicio_desejado, primeira, ajuste)
            leituras = base.mesclar_leituras(antigas, leituras, agora)
            base.salvar_leituras(caminho, leituras)
        except RuntimeError as erro:
            print(f"  aviso: {erro}")
    return leituras


def completar_chuva(slug, pontos, dias, hoje):
    caminho = base.pasta(slug) / "chuva_bacia.json"
    chuva = base.ler_json(caminho, {})
    inicio = hoje - dt.timedelta(days=dias)
    fim = hoje - dt.timedelta(days=6)  # a reanálise chega com alguns dias de atraso
    faltando = [
        inicio + dt.timedelta(days=i)
        for i in range((fim - inicio).days + 1)
        if (inicio + dt.timedelta(days=i)).isoformat() not in chuva
    ]
    if len(faltando) > 3:
        print(f"  baixando chuva histórica de {faltando[0]} a {faltando[-1]}...")
        try:
            historico = openmeteo.chuva_historica_bacia(pontos, faltando[0], faltando[-1])
            chuva.update({k: round(v, 1) for k, v in historico.items()})
            base.salvar_json(caminho, dict(sorted(chuva.items())))
        except RuntimeError as erro:
            print(f"  aviso: {erro}")
    return chuva


def media_diaria(leituras, offset=0.0):
    grupos = defaultdict(list)
    for l in leituras:
        if l["nivel_m"] is not None:
            grupos[l["hora"].date()].append(l["nivel_m"] + offset)
    # dias com poucas leituras distorcem a média
    return {d: statistics.fmean(v) for d, v in grupos.items() if len(v) >= 8}


def treinar_cidade(slug: str, baixar_historico: bool = False) -> dict:
    config = base.carregar_config(slug)
    agora = agora_local()
    cfg_prev = config.get("previsao", {})
    dias = int(cfg_prev.get("dias_treino", 730))
    print(f"[{slug}]")

    ajuste = float(config["estacao"].get("ajuste_fuso_horas", 0.0))
    leituras = completar_telemetria(slug, config["estacao"]["codigo"], "telemetria.csv", dias, agora, ajuste)
    chuva = completar_chuva(slug, config["bacia"]["pontos"], dias, agora.date())

    montante, atraso = None, 0
    cfg_m = next((m for m in config.get("montante", []) if m.get("codigo")), None)
    if cfg_m:
        lm = completar_telemetria(slug, cfg_m["codigo"], f"montante_{cfg_m['codigo']}.csv", dias, agora, ajuste)
        montante = media_diaria(lm, float(cfg_m.get("offset_m", 0.0)))
        atraso = round(float(cfg_m.get("atraso_horas", 0)) / 24)

    niveis = media_diaria(leituras, float(config["estacao"].get("offset_m", 0.0)))
    modelo = mod.treinar(niveis, chuva, montante, atraso, cfg_prev)
    base.salvar_json(base.pasta(slug) / "modelo.json", modelo)
    if modelo["tipo"] == "calibrado":
        erros = ", ".join(f"{r:.2f}" for r in modelo["rmse_horizonte"])
        print(f"  modelo calibrado com {modelo['n_dias']} dias; erro médio (m) por dia à frente: {erros}")
    else:
        print(f"  modelo heurístico: {modelo['motivo']}")

    codigo_hist = config["estacao"].get("codigo_convencional")
    if baixar_historico and codigo_hist:
        print(f"  baixando série histórica da estação {codigo_hist}...")
        try:
            diario = ana.serie_historica_cotas(codigo_hist)
            maximas = ana.maximas_anuais(diario)
            offset = float(config["estacao"].get("offset_convencional_m", 0.0))
            base.salvar_maximas(slug, {a: v + offset for a, v in maximas.items()})
            print(f"  {len(maximas)} anos de máximas salvos ({min(maximas)}–{max(maximas)})")
        except (RuntimeError, ValueError) as erro:
            print(f"  aviso: série histórica indisponível ({erro})")
    return modelo


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    grupo = parser.add_mutually_exclusive_group(required=True)
    grupo.add_argument("--cidade")
    grupo.add_argument("--todas", action="store_true")
    parser.add_argument("--historico", action="store_true", help="baixa também as máximas anuais da ANA")
    args = parser.parse_args(argv)
    for slug in base.listar_cidades() if args.todas else [args.cidade]:
        treinar_cidade(slug, args.historico)
    return 0


if __name__ == "__main__":
    sys.exit(main())
