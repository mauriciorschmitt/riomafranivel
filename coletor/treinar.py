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

from . import ana, base, copel, modelo as mod, openmeteo
from .gerar import agora_local


MIN_DIAS_MONTANTE = 90


def completar_telemetria(slug, arquivo, dias, agora, buscar_periodo, rotulo):
    """Completa a base local para trás até `dias` atrás. `buscar_periodo(inicio, fim)` traz as leituras."""
    caminho = base.pasta(slug) / arquivo
    leituras = base.ler_leituras(caminho)
    inicio_desejado = agora - dt.timedelta(days=dias)
    primeira = leituras[0]["hora"] if leituras else agora
    if primeira > inicio_desejado + dt.timedelta(days=7):
        print(f"  baixando {rotulo} de {inicio_desejado:%d/%m/%Y} a {primeira:%d/%m/%Y}...")
        try:
            antigas = buscar_periodo(inicio_desejado, primeira)
            leituras = base.mesclar_leituras(antigas, leituras, agora)
            base.salvar_leituras(caminho, leituras)
            print(f"  {len(antigas)} leituras recebidas")
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


MIN_DIAS_ANO = 200  # ano com menos dias que isso não entra (a máxima pode ter caído num buraco)


def completar_maximas_telemetria(config, leituras_cache, ultimo_ano, agora, ajuste) -> dict[int, float]:
    """Completa as máximas anuais depois do fim da série consistida usando a telemetria.

    A série consistida da ANA sai com anos de atraso. Para os anos seguintes, usa a
    maior leitura horária da telemetria da mesma estação (já sem códigos de erro).
    Só anos completos e com pelo menos 200 dias de leituras.
    """
    codigo = config["estacao"]["codigo"]
    offset = float(config["estacao"].get("offset_m", 0.0))
    por_ano: dict[int, list[dict]] = {}
    for l in leituras_cache:
        por_ano.setdefault(l["hora"].year, []).append(l)
    resultado = {}
    for ano in range(ultimo_ano + 1, agora.year):
        leituras = por_ano.get(ano, [])
        dias = {l["hora"].date() for l in leituras}
        if len(dias) < MIN_DIAS_ANO:
            try:
                baixadas = ana.telemetria(codigo, dt.date(ano, 1, 1), dt.date(ano, 12, 31), ajuste)
                leituras = base.limpar_leituras(baixadas)
                dias = {l["hora"].date() for l in leituras}
            except RuntimeError as erro:
                print(f"  {ano}: telemetria indisponível ({erro})")
                continue
        if len(dias) < MIN_DIAS_ANO:
            print(f"  {ano}: só {len(dias)} dias de telemetria, fica de fora")
            continue
        maior = max(leituras, key=lambda l: l["nivel_m"])
        resultado[ano] = maior["nivel_m"] + offset
        print(f"  {ano}: {resultado[ano]:.2f} m em {maior['hora']:%d/%m} (telemetria, {len(dias)} dias)")
    return resultado


def treinar_cidade(slug: str, baixar_historico: bool = False) -> dict:
    config = base.carregar_config(slug)
    agora = agora_local()
    cfg_prev = config.get("previsao", {})
    dias = int(cfg_prev.get("dias_treino", 730))
    print(f"[{slug}]")

    ajuste = float(config["estacao"].get("ajuste_fuso_horas", 0.0))
    codigo = config["estacao"]["codigo"]
    leituras = completar_telemetria(
        slug, "telemetria.csv", dias, agora,
        lambda i, f: ana.telemetria(codigo, i.date(), f.date(), ajuste), f"telemetria ANA {codigo}",
    )
    chuva = completar_chuva(slug, config["bacia"]["pontos"], dias, agora.date())
    niveis = media_diaria(leituras, float(config["estacao"].get("offset_m", 0.0)))

    montante = None
    cfg_m = next((m for m in config.get("montante", []) if base.chave_montante(m)), None)
    if cfg_m:
        chave = base.chave_montante(cfg_m)
        if cfg_m.get("estacao_copel"):
            cliente = copel.Cliente()
            buscar = lambda i, f: cliente.historico(cfg_m["estacao_copel"], i, f)  # noqa: E731
        else:
            buscar = lambda i, f: ana.telemetria(cfg_m["codigo"], i.date(), f.date(), ajuste)  # noqa: E731
        lm = completar_telemetria(slug, f"montante_{chave}.csv", dias, agora, buscar, f"{cfg_m['nome']} (rio acima)")
        montante = media_diaria(lm, float(cfg_m.get("offset_m", 0.0)))
        comuns = len(set(montante) & set(niveis))
        if comuns < MIN_DIAS_MONTANTE:
            print(f"  {cfg_m['nome']}: só {comuns} dias junto com a estação principal; "
                  f"entra no modelo quando tiver {MIN_DIAS_MONTANTE} (a base cresce a cada coleta)")
            montante = None

    if montante:
        # testa quantos dias a cheia leva para chegar e fica com o que erra menos em 1 a 3 dias
        candidatos = {}
        for atraso in range(0, 4):
            m = mod.treinar(niveis, chuva, montante, atraso, cfg_prev)
            if m["tipo"] == "calibrado":
                candidatos[atraso] = m
                print(f"  rio acima com {atraso} dia(s) de atraso: erro 1-3 dias = "
                      f"{sum(m['rmse_horizonte'][:3]) / 3:.2f} m")
        sem = mod.treinar(niveis, chuva, None, 0, cfg_prev)
        melhor = min(candidatos, key=lambda a: sum(candidatos[a]["rmse_horizonte"][:3])) if candidatos else None
        if melhor is not None and sum(candidatos[melhor]["rmse_horizonte"][:3]) < sum(sem["rmse_horizonte"][:3]):
            modelo = {**candidatos[melhor], "usa_montante": True}
            print(f"  usando {cfg_m['nome']} com {melhor} dia(s) de atraso "
                  f"(sem ela: {sum(sem['rmse_horizonte'][:3]) / 3:.2f} m)")
        else:
            modelo = sem
            print(f"  {cfg_m['nome']} não melhorou a previsão; modelo segue só com chuva")
    else:
        modelo = mod.treinar(niveis, chuva, None, 0, cfg_prev)

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
            offset = float(config["estacao"].get("offset_convencional_m", 0.0))
            maximas = {a: v + offset for a, v in ana.maximas_anuais(diario).items()}
            fontes = {a: "ANA convencional" for a in maximas}
            print(f"  {len(maximas)} anos de máximas da série consistida ({min(maximas)}–{max(maximas)})")
            extra = completar_maximas_telemetria(config, leituras, max(maximas), agora, ajuste)
            for ano, cota in extra.items():
                maximas[ano], fontes[ano] = cota, "ANA telemetria"
            base.salvar_maximas(slug, maximas, fontes)
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
