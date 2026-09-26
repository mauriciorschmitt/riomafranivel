"""Análise de extremos: distribuição de Gumbel ajustada às máximas anuais.

Método dos momentos (o mesmo dos manuais de hidrologia):
  beta = s * sqrt(6) / pi
  mu   = média - 0,5772 * beta
Cota para tempo de retorno T:  x_T = mu - beta * ln(-ln(1 - 1/T))
Chance anual de superar x:     P = 1 - exp(-exp(-(x - mu) / beta))
"""
from __future__ import annotations

import math
import statistics

EULER = 0.5772156649
TEMPOS_RETORNO = [
    (2, "Cheia comum"),
    (5, "Cheia forte"),
    (10, "Cheia de 10 anos"),
    (25, "Grande cheia"),
    (50, "Cheia muito rara"),
    (100, "Cheia centenária"),
]


def ajustar_gumbel(maximas: list[float]) -> dict | None:
    if len(maximas) < 10:
        return None
    media = statistics.fmean(maximas)
    desvio = statistics.stdev(maximas)
    beta = desvio * math.sqrt(6) / math.pi
    return {"mu": media - EULER * beta, "beta": beta}


def cota_retorno(parametros: dict, anos: float) -> float:
    return parametros["mu"] - parametros["beta"] * math.log(-math.log(1 - 1 / anos))


def chance_anual(parametros: dict, cota: float) -> float:
    return 1 - math.exp(-math.exp(-(cota - parametros["mu"]) / parametros["beta"]))


def analise_extremos(maximas_por_ano: dict[int, float], cota_inundacao: float | None) -> dict | None:
    valores = list(maximas_por_ano.values())
    parametros = ajustar_gumbel(valores)
    if parametros is None:
        return None
    anos = sorted(maximas_por_ano)
    resultado = {
        "mu": round(parametros["mu"], 3),
        "beta": round(parametros["beta"], 3),
        "n_anos": len(valores),
        "periodo": [anos[0], anos[-1]],
        "tabela": [
            {"anos": t, "nome": nome, "cota": round(cota_retorno(parametros, t), 2), "chance": round(1 / t, 3)}
            for t, nome in TEMPOS_RETORNO
        ],
        "curva": [
            {"anos": t, "cota": round(cota_retorno(parametros, t), 2)}
            for t in [1.1, 1.5, 2, 3, 5, 7, 10, 15, 20, 25, 35, 50, 75, 100]
        ],
        "maximas": [{"ano": a, "cota": round(maximas_por_ano[a], 2)} for a in anos],
    }
    if cota_inundacao is not None:
        resultado["chance_anual_inundacao"] = round(chance_anual(parametros, cota_inundacao), 3)
    return resultado
