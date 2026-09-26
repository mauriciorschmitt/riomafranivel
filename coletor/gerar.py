"""Coleta os dados públicos, roda a previsão e publica o JSON do painel.

Uso:
  python -m coletor.gerar --cidade mafra-rionegro
  python -m coletor.gerar --todas
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import traceback
from zoneinfo import ZoneInfo

from . import alertas, ana, base, modelo as mod, openmeteo
from .processar import processar

FUSO = ZoneInfo("America/Sao_Paulo")
PREVISAO_VAZIA = {"diario": {}, "chuva_por_ponto": {}, "chuva_horaria_por_ponto": {}, "solo": {}}


def agora_local() -> dt.datetime:
    return dt.datetime.now(FUSO).replace(tzinfo=None, second=0, microsecond=0)


def atualizar_telemetria(slug: str, codigo: str, nome_arquivo: str, agora: dt.datetime, avisos: list, ajuste: float = 0.0) -> list[dict]:
    caminho = base.pasta(slug) / nome_arquivo
    antigas = base.ler_leituras(caminho)
    dias = 3 if antigas and antigas[-1]["hora"] > agora - dt.timedelta(days=2) else 60
    try:
        novas = ana.telemetria(codigo, agora.date() - dt.timedelta(days=dias), agora.date(), ajuste)
    except RuntimeError as erro:
        avisos.append(f"ANA {codigo}: {erro}. Usando dados guardados.")
        novas = []
    todas = base.mesclar_leituras(antigas, novas, agora)
    base.salvar_leituras(caminho, todas)
    return todas


def atualizar_chuva(slug: str, previsao: dict, hoje: dt.date) -> dict[str, float]:
    caminho = base.pasta(slug) / "chuva_bacia.json"
    chuva = base.ler_json(caminho, {})
    for data, dia in previsao["diario"].items():
        if data <= hoje.isoformat() and dia.get("chuva_mm") is not None:
            chuva[data] = dia["chuva_mm"]
    limite = (hoje - dt.timedelta(days=base.DIAS_GUARDADOS)).isoformat()
    chuva = {k: v for k, v in sorted(chuva.items()) if k >= limite}
    base.salvar_json(caminho, chuva)
    return chuva


def gerar_cidade(slug: str) -> dict:
    config = base.carregar_config(slug)
    agora = agora_local()
    avisos: list[str] = []

    ajuste = float(config["estacao"].get("ajuste_fuso_horas", 0.0))
    telemetria = atualizar_telemetria(slug, config["estacao"]["codigo"], "telemetria.csv", agora, avisos, ajuste)
    montante = {}
    for m in config.get("montante", []):
        if m.get("codigo"):
            montante[m["codigo"]] = atualizar_telemetria(slug, m["codigo"], f"montante_{m['codigo']}.csv", agora, avisos, ajuste)

    try:
        previsao = openmeteo.previsao_bacia(config["bacia"]["pontos"])
    except RuntimeError as erro:
        avisos.append(f"Open-Meteo: {erro}")
        previsao = PREVISAO_VAZIA
    chuva = atualizar_chuva(slug, previsao, agora.date())

    glofas = None
    try:
        glofas = openmeteo.vazao_glofas(config["estacao"]["lat"], config["estacao"]["lon"])
    except RuntimeError as erro:
        avisos.append(f"GloFAS: {erro}")

    modelo = base.ler_json(base.pasta(slug) / "modelo.json") or mod.modelo_heuristico(config.get("previsao", {}))
    bruto = {
        "agora": agora,
        "telemetria": telemetria,
        "montante": montante,
        "previsao": previsao,
        "chuva_historica": chuva,
        "glofas": glofas,
    }
    saida = processar(config, bruto, modelo, base.ler_maximas(slug, config))
    saida["avisos"] = avisos
    base.publicar(slug, saida)
    alertas.verificar(slug, saida)
    return saida


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    grupo = parser.add_mutually_exclusive_group(required=True)
    grupo.add_argument("--cidade")
    grupo.add_argument("--todas", action="store_true")
    args = parser.parse_args(argv)
    cidades = base.listar_cidades() if args.todas else [args.cidade]
    falhas = 0
    for slug in cidades:
        try:
            saida = gerar_cidade(slug)
            a = saida["atual"]
            print(f"[ok] {slug}: {a['nivel']:.2f} m ({a['status']['nome']}), modelo {saida['modelo']['tipo']}")
            for aviso in saida["avisos"]:
                print(f"     aviso: {aviso}")
        except Exception:  # uma cidade com problema não derruba as outras
            falhas += 1
            print(f"[erro] {slug}")
            traceback.print_exc()
    return 1 if falhas == len(cidades) else 0


if __name__ == "__main__":
    sys.exit(main())
