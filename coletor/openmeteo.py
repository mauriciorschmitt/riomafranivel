"""Chuva, umidade do solo e vazão prevista via Open-Meteo (gratuito, sem chave).

* /v1/forecast: previsão de 8 dias + 7 dias passados (chuva, temperatura,
  probabilidade, código do tempo e umidade do solo).
* archive-api: chuva diária histórica (reanálise ERA5), usada para treinar o
  modelo de previsão junto com o nível da ANA.
* flood-api: vazão diária prevista pelo GloFAS (Copernicus/ECMWF).

A chuva da bacia é a média ponderada dos pontos configurados para a cidade.
"""
from __future__ import annotations

import datetime as dt
import time

import requests

PREVISAO = "https://api.open-meteo.com/v1/forecast"
ARQUIVO = "https://archive-api.open-meteo.com/v1/archive"
CHEIAS = "https://flood-api.open-meteo.com/v1/flood"
CONJUNTO = "https://ensemble-api.open-meteo.com/v1/ensemble"
MODELO_CONJUNTO = "ecmwf_ifs025"  # previsão por conjunto do ECMWF: 51 versões da chuva
FUSO = "America/Sao_Paulo"
TIMEOUT = 60


def _get(url: str, params: dict, tentativas: int = 3) -> dict:
    erro = None
    for tentativa in range(tentativas):
        try:
            r = requests.get(url, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            erro = e
            time.sleep(2 * (tentativa + 1))
    raise RuntimeError(f"Open-Meteo falhou: {erro}")


def previsao_ponto(lat: float, lon: float) -> dict:
    return _get(
        PREVISAO,
        {
            "latitude": lat,
            "longitude": lon,
            "timezone": FUSO,
            "past_days": 7,
            "forecast_days": 8,
            "daily": ",".join(
                [
                    "precipitation_sum",
                    "precipitation_probability_max",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "weather_code",
                ]
            ),
            "hourly": "precipitation,soil_moisture_9_to_27cm",
        },
    )


def chuva_historica_ponto(lat: float, lon: float, inicio: dt.date, fim: dt.date) -> dict[str, float]:
    dados = _get(
        ARQUIVO,
        {
            "latitude": lat,
            "longitude": lon,
            "timezone": FUSO,
            "start_date": inicio.isoformat(),
            "end_date": fim.isoformat(),
            "daily": "precipitation_sum",
        },
    )
    datas = dados["daily"]["time"]
    valores = dados["daily"]["precipitation_sum"]
    return {d: v for d, v in zip(datas, valores) if v is not None}


def vazao_glofas(lat: float, lon: float) -> dict[str, float]:
    dados = _get(
        CHEIAS,
        {
            "latitude": lat,
            "longitude": lon,
            "daily": "river_discharge",
            "past_days": 30,
            "forecast_days": 30,
        },
    )
    return {
        d: v
        for d, v in zip(dados["daily"]["time"], dados["daily"]["river_discharge"])
        if v is not None
    }


def _media_ponderada(series: list[tuple[float, dict[str, float]]]) -> dict[str, float]:
    soma: dict[str, float] = {}
    pesos: dict[str, float] = {}
    for peso, serie in series:
        for chave, valor in serie.items():
            if valor is None:
                continue
            soma[chave] = soma.get(chave, 0.0) + peso * valor
            pesos[chave] = pesos.get(chave, 0.0) + peso
    return {k: soma[k] / pesos[k] for k in sorted(soma)}


def previsao_bacia(pontos: list[dict]) -> dict:
    """Consolida a previsão de todos os pontos da bacia.

    Devolve:
      diario: {data: {"chuva_mm", "prob", "tmax", "tmin", "codigo"}} (média da bacia;
              temperatura e código do tempo vêm do primeiro ponto, que é a cidade)
      chuva_por_ponto: {nome: {data: mm}}
      chuva_horaria_por_ponto: {nome: {hora_iso: mm}}
      solo: {hora_iso: m³/m³} média da bacia
    """
    respostas = [(p, previsao_ponto(p["lat"], p["lon"])) for p in pontos]
    cidade = respostas[0][1]["daily"]

    chuva_series, prob_series, solo_series = [], [], []
    chuva_por_ponto, chuva_horaria_por_ponto = {}, {}
    for ponto, resp in respostas:
        peso = float(ponto.get("peso", 1.0))
        d, h = resp["daily"], resp["hourly"]
        chuva = dict(zip(d["time"], d["precipitation_sum"]))
        chuva_series.append((peso, chuva))
        prob_series.append((peso, dict(zip(d["time"], d["precipitation_probability_max"]))))
        solo_series.append((peso, dict(zip(h["time"], h["soil_moisture_9_to_27cm"]))))
        chuva_por_ponto[ponto["nome"]] = {k: v for k, v in chuva.items() if v is not None}
        chuva_horaria_por_ponto[ponto["nome"]] = {
            k: v for k, v in zip(h["time"], h["precipitation"]) if v is not None
        }

    chuva = _media_ponderada(chuva_series)
    prob = _media_ponderada(prob_series)
    diario = {}
    for i, data in enumerate(cidade["time"]):
        diario[data] = {
            "chuva_mm": round(chuva.get(data, 0.0), 1),
            "prob": None if data not in prob else round(prob[data]),
            "tmax": cidade["temperature_2m_max"][i],
            "tmin": cidade["temperature_2m_min"][i],
            "codigo": cidade["weather_code"][i],
        }
    return {
        "diario": diario,
        "chuva_por_ponto": chuva_por_ponto,
        "chuva_horaria_por_ponto": chuva_horaria_por_ponto,
        "solo": _media_ponderada(solo_series),
    }


def chuva_historica_bacia(pontos: list[dict], inicio: dt.date, fim: dt.date) -> dict[str, float]:
    series = [
        (float(p.get("peso", 1.0)), chuva_historica_ponto(p["lat"], p["lon"], inicio, fim))
        for p in pontos
    ]
    return _media_ponderada(series)


def _membros_diarios(resposta: dict) -> list[dict[str, float]]:
    """Separa cada versão (membro) da previsão de chuva e soma por dia.

    O nome das colunas varia (precipitation, precipitation_member01...), então
    toda coluna que começa com "precipitation" vira um membro.
    """
    horas = resposta["hourly"]["time"]
    membros = []
    for chave, valores in resposta["hourly"].items():
        if not chave.startswith("precipitation"):
            continue
        dia: dict[str, float] = {}
        for h, v in zip(horas, valores):
            if v is not None:
                dia[h[:10]] = dia.get(h[:10], 0.0) + v
        if dia:
            membros.append(dia)
    return membros


def chuva_conjunto(pontos: list[dict]) -> list[dict[str, float]]:
    """Versões da previsão de chuva da bacia (média ponderada dos pontos), por dia.

    Devolve uma lista de cenários {data: mm}. Serve para a chance de inundação
    levar em conta que a chuva prevista pode não se confirmar.
    """
    por_ponto = []
    for p in pontos:
        resposta = _get(
            CONJUNTO,
            {
                "latitude": p["lat"],
                "longitude": p["lon"],
                "timezone": FUSO,
                "hourly": "precipitation",
                "models": MODELO_CONJUNTO,
                "forecast_days": 8,
            },
        )
        por_ponto.append((float(p.get("peso", 1.0)), _membros_diarios(resposta)))
    n = min(len(m) for _, m in por_ponto)
    if n == 0:
        return []
    cenarios = []
    for i in range(n):
        cenarios.append(_media_ponderada([(peso, membros[i]) for peso, membros in por_ponto]))
    return cenarios
