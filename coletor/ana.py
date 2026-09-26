"""Leitura dos serviços públicos da ANA (sem cadastro, sem chave).

Dois endpoints do web service ServiceANA.asmx são usados:

* DadosHidrometeorologicos: telemetria das últimas semanas, leituras a cada
  15 minutos (nível em cm, chuva em mm, vazão em m³/s quando existir).
* HidroSerieHistorica: série histórica consistida das estações convencionais
  (cotas diárias desde o início da operação). Serve para a análise de extremos.

O XML devolvido tem nomes de tags inconsistentes entre versões do serviço
(inclusive um "Hidrometereologicos" com erro de grafia), então o parser não
depende do nome do elemento: qualquer elemento que tenha um filho DataHora é
tratado como um registro.
"""
from __future__ import annotations

import datetime as dt
import time
import xml.etree.ElementTree as ET
from typing import Iterator

import requests

BASE = "https://telemetriaws1.ana.gov.br/ServiceANA.asmx"
TIMEOUT = 60
JANELA_DIAS = 30  # o serviço fica instável com intervalos muito longos


def _texto_para_float(valor: str | None) -> float | None:
    if valor is None:
        return None
    valor = valor.strip().replace(",", ".")
    if not valor:
        return None
    try:
        return float(valor)
    except ValueError:
        return None


def _data(valor: str) -> dt.datetime | None:
    valor = (valor or "").strip()
    for formato in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y %H:%M:%S", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(valor[:19], formato)
        except ValueError:
            continue
    return None


def registros_xml(xml_texto: str) -> Iterator[dict[str, str]]:
    """Percorre o XML e devolve cada registro como {tag: texto}."""
    raiz = ET.fromstring(xml_texto)
    for elemento in raiz.iter():
        filhos = {f.tag.split("}")[-1]: (f.text or "").strip() for f in elemento}
        if "DataHora" in filhos:
            yield filhos


def interpretar_telemetria(xml_texto: str) -> list[dict]:
    """Converte a resposta de DadosHidrometeorologicos em leituras.

    Cada leitura: {"hora": datetime, "nivel_m": float|None, "chuva_mm": float|None,
    "vazao_m3s": float|None}. O nível da ANA vem em centímetros.
    """
    leituras = []
    for r in registros_xml(xml_texto):
        hora = _data(r.get("DataHora", ""))
        if hora is None:
            continue
        nivel_cm = _texto_para_float(r.get("Nivel"))
        leituras.append(
            {
                "hora": hora,
                "nivel_m": None if nivel_cm is None else nivel_cm / 100.0,
                "chuva_mm": _texto_para_float(r.get("Chuva")),
                "vazao_m3s": _texto_para_float(r.get("Vazao")),
            }
        )
    return leituras


def _get(metodo: str, params: dict, tentativas: int = 3) -> str:
    ultimo_erro = None
    for tentativa in range(tentativas):
        try:
            resposta = requests.get(f"{BASE}/{metodo}", params=params, timeout=TIMEOUT)
            resposta.raise_for_status()
            return resposta.text
        except requests.RequestException as erro:  # rede da ANA oscila bastante
            ultimo_erro = erro
            time.sleep(2 * (tentativa + 1))
    raise RuntimeError(f"ANA {metodo} falhou após {tentativas} tentativas: {ultimo_erro}")


def telemetria(codigo: str, inicio: dt.date, fim: dt.date, ajuste_horas: float = 0.0) -> list[dict]:
    """Baixa a telemetria entre duas datas, em janelas de 30 dias.

    `ajuste_horas` corrige o fuso, caso a estação informe a hora em UTC
    (use -3 nesse caso; confira comparando com o site HidroTelemetria).
    """
    leituras: dict[dt.datetime, dict] = {}
    cursor = inicio
    while cursor <= fim:
        fim_janela = min(cursor + dt.timedelta(days=JANELA_DIAS - 1), fim)
        xml = _get(
            "DadosHidrometeorologicos",
            {
                "codEstacao": codigo,
                "dataInicio": cursor.strftime("%d/%m/%Y"),
                "dataFim": fim_janela.strftime("%d/%m/%Y"),
            },
        )
        for leitura in interpretar_telemetria(xml):
            leitura["hora"] += dt.timedelta(hours=ajuste_horas)
            leituras[leitura["hora"]] = leitura
        cursor = fim_janela + dt.timedelta(days=1)
    return [leituras[h] for h in sorted(leituras)]


def interpretar_serie_historica(xml_texto: str) -> dict[dt.date, float]:
    """Converte HidroSerieHistorica (tipoDados=1, cotas) em {data: cota_máxima_m}.

    Cada registro é um mês, com Cota01..Cota31. Quando o mesmo mês aparece como
    bruto (NivelConsistencia=1) e consistido (=2), o consistido prevalece.
    """
    por_mes: dict[tuple[int, int], tuple[int, dict]] = {}
    for r in registros_xml(xml_texto):
        mes = _data(r.get("DataHora", ""))
        if mes is None:
            continue
        consistencia = int(_texto_para_float(r.get("NivelConsistencia")) or 1)
        chave = (mes.year, mes.month)
        if chave not in por_mes or consistencia > por_mes[chave][0]:
            por_mes[chave] = (consistencia, r)

    diario: dict[dt.date, float] = {}
    for (ano, mes), (_, r) in por_mes.items():
        for dia in range(1, 32):
            cota = _texto_para_float(r.get(f"Cota{dia:02d}"))
            if cota is None:
                continue
            try:
                data = dt.date(ano, mes, dia)
            except ValueError:
                continue
            diario[data] = cota / 100.0
        maxima = _texto_para_float(r.get("Maxima"))
        if maxima is not None and not any(d.year == ano and d.month == mes for d in diario):
            diario[dt.date(ano, mes, 1)] = maxima / 100.0
    return dict(sorted(diario.items()))


def serie_historica_cotas(codigo: str, inicio: dt.date | None = None, fim: dt.date | None = None) -> dict[dt.date, float]:
    xml = _get(
        "HidroSerieHistorica",
        {
            "codEstacao": codigo,
            "dataInicio": inicio.strftime("%d/%m/%Y") if inicio else "",
            "dataFim": fim.strftime("%d/%m/%Y") if fim else "",
            "tipoDados": "1",
            "nivelConsistencia": "",
        },
    )
    return interpretar_serie_historica(xml)


def maximas_anuais(diario: dict[dt.date, float], min_dias_por_ano: int = 200) -> dict[int, float]:
    """Máxima de cada ano, descartando anos com poucos dados."""
    por_ano: dict[int, list[float]] = {}
    for data, cota in diario.items():
        por_ano.setdefault(data.year, []).append(cota)
    return {ano: max(v) for ano, v in sorted(por_ano.items()) if len(v) >= min_dias_por_ano}
