"""Transforma os dados brutos (ANA + Open-Meteo) no JSON que o painel lê.

Não faz nenhuma requisição de rede: recebe tudo pronto. Assim o mesmo código
roda com dados reais (gerar.py) e com dados sintéticos (demo.py e testes).
"""
from __future__ import annotations

import datetime as dt
import statistics
from collections import defaultdict

from . import base, estatistica, modelo as mod


# ---------------------------------------------------------------- utilidades
def faixas(config: dict) -> list[dict]:
    """Faixas de alerta ordenadas da mais baixa para a mais alta."""
    return sorted(config["cotas"]["faixas"], key=lambda f: f["cota"])


def status_para(nivel: float, config: dict) -> dict:
    atual = {"id": "normal", "nome": "Normal", "cota": None}
    for faixa in faixas(config):
        if nivel >= faixa["cota"]:
            atual = faixa
    return {"id": atual["id"], "nome": atual["nome"]}


def _aplicar_offset(leituras: list[dict], offset: float) -> list[dict]:
    saida = []
    for l in leituras:
        if l.get("nivel_m") is None:
            continue
        saida.append({**l, "nivel": l["nivel_m"] + offset})
    return saida


def _tendencia(leituras: list[dict], agora: dt.datetime, horas: float = 3.0) -> float | None:
    """Inclinação (m/h) por mínimos quadrados nas últimas `horas`."""
    janela = [l for l in leituras if l["hora"] >= agora - dt.timedelta(hours=horas)]
    if len(janela) < 3:
        return None
    t = [(l["hora"] - janela[0]["hora"]).total_seconds() / 3600 for l in janela]
    h = [l["nivel"] for l in janela]
    mt, mh = statistics.fmean(t), statistics.fmean(h)
    den = sum((x - mt) ** 2 for x in t)
    if den == 0:
        return None
    return sum((x - mt) * (y - mh) for x, y in zip(t, h)) / den


def _horario(leituras: list[dict], desde: dt.datetime) -> list[list]:
    grupos: dict[dt.datetime, list[float]] = defaultdict(list)
    for l in leituras:
        if l["hora"] >= desde:
            grupos[l["hora"].replace(minute=0, second=0, microsecond=0)].append(l["nivel"])
    return [[h.isoformat(timespec="minutes"), round(statistics.fmean(v), 3)] for h, v in sorted(grupos.items())]


def _diario(leituras: list[dict], funcao=statistics.fmean) -> dict[dt.date, float]:
    grupos: dict[dt.date, list[float]] = defaultdict(list)
    for l in leituras:
        grupos[l["hora"].date()].append(l["nivel"])
    return {d: funcao(v) for d, v in sorted(grupos.items())}


def _soma_janela(horaria: dict[str, float], agora: dt.datetime, horas: int) -> float:
    inicio = agora - dt.timedelta(hours=horas)
    total = 0.0
    for chave, valor in horaria.items():
        hora = dt.datetime.fromisoformat(chave)
        if inicio < hora <= agora:
            total += valor
    return round(total, 1)


def _valor_mais_proximo(serie: dict[str, float], agora: dt.datetime):
    melhor, distancia = None, None
    for chave, valor in serie.items():
        d = abs((dt.datetime.fromisoformat(chave) - agora).total_seconds())
        if distancia is None or d < distancia:
            melhor, distancia = valor, d
    return melhor


def _classificar(valor, limites, rotulos):
    for limite, rotulo in zip(limites, rotulos):
        if valor < limite:
            return rotulo
    return rotulos[-1]


# ---------------------------------------------------------------- principal
MIN_COMPARACOES_CHUVA = 15


def comparar_chuva(previsoes: dict, chuva_obs: dict, hoje: dt.date, desde: str = "") -> dict:
    """Chuva prevista (1 a 3 dias antes) x chuva que caiu, das previsões guardadas às 7h."""
    prevista = caiu = 0.0
    n = 0
    for emitida, prev in previsoes.items():
        if emitida < desde:
            continue
        for d in prev.get("dias", [])[:3]:
            data = d.get("data")
            if d.get("chuva_mm") is None or data is None or data >= hoje.isoformat() or data not in chuva_obs:
                continue
            prevista += d["chuva_mm"]
            caiu += chuva_obs[data] or 0.0
            n += 1
    fator = None
    if n >= MIN_COMPARACOES_CHUVA and prevista > 5:
        fator = round(min(1.5, max(0.5, caiu / prevista)), 2)
    return {"n": n, "prevista_mm": round(prevista, 1), "caiu_mm": round(caiu, 1), "fator": fator}


def placar(previsoes: dict, medias_diarias: dict, hoje: dt.date, desde: str = "") -> dict:
    """Compara as previsões guardadas (uma por dia) com a média observada de cada dia.

    `desde`: só conta previsões feitas a partir dessa data (a versão atual do modelo),
    para o placar não misturar versões antigas com a de agora.
    """
    previsoes = {k: v for k, v in previsoes.items() if k >= desde}
    horizontes = []
    pares_1d, pares_3d = {}, {}
    for k in range(7):
        erros, palpite, dentro = [], [], []
        for emitida, prev in previsoes.items():
            if k >= len(prev["dias"]):
                continue
            d = prev["dias"][k]
            alvo = dt.date.fromisoformat(d["data"])
            if alvo >= hoje or alvo not in medias_diarias or d.get("media") is None:
                continue
            obs = medias_diarias[alvo]
            erros.append(abs(d["media"] - obs))
            palpite.append(abs(prev["nivel_atual"] - obs))
            if d.get("min") is not None and d.get("max") is not None:
                dentro.append(d["min"] <= obs <= d["max"])
            if k == 0:
                pares_1d[alvo] = (obs, d["media"])
            if k == 2:
                pares_3d[alvo] = d["media"]
        horizontes.append({
            "dias": k + 1,
            "n": len(erros),
            "erro_medio": round(statistics.fmean(erros), 3) if erros else None,
            "erro_palpite": round(statistics.fmean(palpite), 3) if palpite else None,
            "na_faixa": round(sum(dentro) / len(dentro), 3) if dentro else None,
        })
    serie = [
        [d.isoformat(), round(obs, 2), round(prev1, 2), None if d not in pares_3d else round(pares_3d[d], 2)]
        for d, (obs, prev1) in sorted(pares_1d.items())
    ][-60:]
    return {
        "desde": min(previsoes) if previsoes else None,
        "n_previsoes": len(previsoes),
        "horizontes": horizontes,
        "serie": serie,
    }


def processar(config: dict, bruto: dict, modelo: dict, maximas_anuais: dict[int, float]) -> dict:
    agora: dt.datetime = bruto["agora"]
    hoje = agora.date()
    offset = float(config["estacao"].get("offset_m", 0.0))
    leituras = _aplicar_offset(bruto["telemetria"], offset)
    if not leituras:
        raise ValueError("Nenhuma leitura de nível válida na telemetria.")

    ultima = leituras[-1]
    idade_min = (agora - ultima["hora"]).total_seconds() / 60
    tendencia = _tendencia(leituras, ultima["hora"])
    cota_inundacao = config["cotas"].get("inundacao")

    # séries
    horaria_30d = _horario(leituras, agora - dt.timedelta(days=30))
    medias_diarias = _diario(leituras)
    maximas_diarias = _diario(leituras, max)
    ultimos_365 = {d: v for d, v in maximas_diarias.items() if d >= hoje - dt.timedelta(days=365)}

    # chuva da bacia: histórico + dias passados da previsão + previsão
    previsao = bruto["previsao"]
    chuva_bacia: dict[str, float] = dict(bruto.get("chuva_historica") or {})
    for data, dia in previsao["diario"].items():
        if data >= (hoje - dt.timedelta(days=5)).isoformat() or data not in chuva_bacia:
            chuva_bacia[data] = dia["chuva_mm"]

    # versões da chuva: a chuva mostrada e usada nos próximos dias é a mediana delas,
    # que muda pouco de uma rodada para outra (a previsão "principal" oscila bastante)
    conjunto = bruto.get("chuva_conjunto") or []
    desde = str(config.get("previsao", {}).get("placar_desde") or "")
    correcao = comparar_chuva(bruto.get("previsoes") or {}, bruto.get("chuva_historica") or {}, hoje, desde)
    if correcao["fator"] and conjunto:
        # a previsão de chuva costuma errar sempre para o mesmo lado aqui: desconta isso
        conjunto = [{d: round(v * correcao["fator"], 1) for d, v in c.items()} for c in conjunto]
    chuva_mediana: dict[str, float] = {}
    if len(conjunto) >= mod.MIN_CENARIOS:
        futuras = sorted({d for c in conjunto for d in c if d > hoje.isoformat()})
        chuva_mediana = {d: round(statistics.median(c.get(d, 0.0) for c in conjunto), 1) for d in futuras}
        chuva_bacia.update(chuva_mediana)

    # montante (rio acima)
    montante_cfg = next((m for m in config.get("montante", []) if base.chave_montante(m)), None)
    montante_diario, montante_info = {}, None
    chave = base.chave_montante(montante_cfg) if montante_cfg else None
    if chave and bruto.get("montante", {}).get(chave):
        lm = _aplicar_offset(bruto["montante"][chave], float(montante_cfg.get("offset_m", 0.0)))
        if lm:
            montante_diario = _diario(lm)
            ult = lm[-1]
            antes = [l for l in lm if l["hora"] <= ult["hora"] - dt.timedelta(hours=24)]
            variacao = ult["nivel"] - antes[-1]["nivel"] if antes else None
            atraso_modelo = modelo.get("atraso_montante_dias") if modelo.get("usa_montante") else None
            montante_info = {
                "nome": montante_cfg["nome"],
                "fonte": "COPEL" if montante_cfg.get("estacao_copel") else "ANA",
                "nivel": round(ult["nivel"], 2),
                "hora": ult["hora"].isoformat(timespec="minutes"),
                "variacao_24h": None if variacao is None else round(variacao, 2),
                "atraso_horas": atraso_modelo * 24 if atraso_modelo is not None else montante_cfg.get("atraso_horas"),
                "no_modelo": bool(modelo.get("usa_montante")),
            }

    # previsão de nível
    cfg_prev = config.get("previsao", {})
    diaria = mod.prever(
        modelo, hoje, ultima["nivel"], medias_diarias, chuva_bacia, montante_diario,
        cota_inundacao=cota_inundacao, fator_incerteza=float(cfg_prev.get("fator_incerteza", 1.3)),
        crescimento_diario=float(cfg_prev.get("crescimento_incerteza_dia", 0.15)),
        fator_empirico=float(cfg_prev.get("fator_incerteza_empirico", 1.0)),
        cotas_extras=sorted(
            {float(x["cota"]) for x in config.get("regua", []) if "cota" in x}
            | {float(x["cota"]) for x in config.get("locais", []) if "cota" in x}
            | {float(f["cota"]) for f in config["cotas"]["faixas"]}
        ),
        cenarios_chuva=bruto.get("chuva_conjunto"),
    )
    horaria = mod.projecao_horaria(ultima["hora"], ultima["nivel"], tendencia or 0.0, diaria, horas=48)

    dias_previsao = []
    for i in range(8):
        data = (hoje + dt.timedelta(days=i)).isoformat()
        tempo = previsao["diario"].get(data, {})
        item = {"data": data, **{k: tempo.get(k) for k in ("chuva_mm", "prob", "tmax", "tmin", "codigo")}}
        if data in chuva_mediana:
            item["chuva_principal_mm"] = item["chuva_mm"]
            item["chuva_mm"] = chuva_mediana[data]
            # chance de chuva = em quantas versões chove pelo menos 1 mm (coerente com a quantidade)
            item["prob"] = round(100 * sum(1 for c in conjunto if (c.get(data) or 0) >= 1.0) / len(conjunto))
        if i == 0:
            item.update({"media": round(ultima["nivel"], 2), "atual": True})
            # o que o site previu ONTEM (às 7h) para hoje: mostra se a previsão acertou
            ontem_emitida = (hoje - dt.timedelta(days=1)).isoformat()
            anterior = (bruto.get("previsoes") or {}).get(ontem_emitida)
            prevista = next((x for x in (anterior or {}).get("dias", []) if x.get("data") == data), None)
            if prevista and prevista.get("media") is not None:
                item["previsto_ontem"] = {
                    "media": prevista["media"], "min": prevista.get("min"), "max": prevista.get("max"),
                    "emitida": anterior.get("emitida"),
                }
        else:
            item.update({k: v for k, v in diaria[i - 1].items() if k != "data"})
        dias_previsao.append(item)

    # chuva por ponto (24 h e 72 h)
    chuva_pontos = [
        {
            "nome": nome,
            "h24": _soma_janela(serie, agora, 24),
            "h72": _soma_janela(serie, agora, 72),
        }
        for nome, serie in previsao["chuva_horaria_por_ponto"].items()
    ]
    datas_chuva = [(hoje + dt.timedelta(days=i)).isoformat() for i in range(-30, 8)]
    chuva_diaria = [[d, round(chuva_bacia.get(d, 0.0), 1), d > hoje.isoformat()] for d in datas_chuva]
    chuva_7d = round(sum(chuva_bacia.get((hoje + dt.timedelta(days=i)).isoformat(), 0.0) or 0 for i in range(1, 8)), 1)

    # fatores de risco
    limites_chuva = cfg_prev.get("limites_chuva_7d", [40, 80, 150])
    solo = _valor_mais_proximo(previsao.get("solo") or {}, agora)
    limites_solo = cfg_prev.get("limites_solo", [0.30, 0.38, 0.45])
    fatores = {
        "chuva_7d": {
            "mm": chuva_7d,
            "nivel": _classificar(chuva_7d, limites_chuva, ["baixo", "moderado", "alto", "muito alto"]),
        },
        "solo": None if solo is None else {
            "umidade": round(solo, 3),
            "nivel": _classificar(solo, limites_solo, ["seco", "úmido", "muito úmido", "encharcado"]),
        },
        "montante": montante_info,
        "glofas": None,
    }
    glofas = bruto.get("glofas") or {}
    futuro = {d: v for d, v in glofas.items() if d >= hoje.isoformat()}
    if futuro:
        pico_data = max(futuro, key=futuro.get)
        fatores["glofas"] = {
            "pico_m3s": round(futuro[pico_data], 1),
            "data": pico_data,
            "hoje_m3s": round(futuro.get(hoje.isoformat(), next(iter(futuro.values()))), 1),
        }

    # indicadores
    ult30 = [l for l in leituras if l["hora"] >= agora - dt.timedelta(days=30)] or leituras[-96:]
    pico30 = max(ult30, key=lambda l: l["nivel"])
    minimo30 = min(ult30, key=lambda l: l["nivel"])
    vazao = next((l["vazao_m3s"] for l in reversed(leituras) if l.get("vazao_m3s")), None)
    fonte_vazao = "ANA" if vazao else ("GloFAS" if fatores["glofas"] else None)
    if vazao is None and fatores["glofas"]:
        vazao = fatores["glofas"]["hoje_m3s"]
    acima = [l["hora"] for l in leituras if cota_inundacao is not None and l["nivel"] >= cota_inundacao]
    if acima:
        dias_sem = (agora - acima[-1]).days
        dias_sem_texto = None
    else:
        dias_sem = (agora - leituras[0]["hora"]).days
        dias_sem_texto = "mais de"

    extremos = estatistica.analise_extremos(maximas_anuais, cota_inundacao)

    chuva_ana_24h = None
    if any(l.get("chuva_mm") is not None for l in leituras[-100:]):
        chuva_ana_24h = round(
            sum(l["chuva_mm"] or 0 for l in leituras if l["hora"] > agora - dt.timedelta(hours=24)), 1
        )

    return {
        "versao": 1,
        "gerado_em": agora.isoformat(timespec="minutes"),
        "demo": bool(bruto.get("demo")),
        "config": config,
        "atual": {
            "nivel": round(ultima["nivel"], 2),
            "hora": ultima["hora"].isoformat(timespec="minutes"),
            "idade_min": round(idade_min),
            "tendencia_cm_h": None if tendencia is None else round(tendencia * 100, 1),
            "status": status_para(ultima["nivel"], config),
            "chuva_pontos": chuva_pontos,
            "chuva_estacao_24h": chuva_ana_24h,
        },
        "serie_horaria": horaria_30d,
        "serie_diaria_max": [[d.isoformat(), round(v, 2)] for d, v in ultimos_365.items()],
        "serie_diaria_media": [
            [d.isoformat(), round(v, 2)] for d, v in medias_diarias.items() if d >= hoje - dt.timedelta(days=30)
        ],
        "placar": {**placar(bruto.get("previsoes") or {}, medias_diarias, hoje, desde), "versao_desde": desde or None, "chuva": correcao},
        "cenarios_chuva": diaria[0].get("cenarios") if diaria else None,
        "chuva_diaria": chuva_diaria,
        "previsao_horaria": horaria,
        "previsao_dias": dias_previsao,
        "fatores": fatores,
        "indicadores": {
            "vazao_m3s": None if vazao is None else round(vazao, 1),
            "fonte_vazao": fonte_vazao,
            "pico_30d": {"nivel": round(pico30["nivel"], 2), "hora": pico30["hora"].isoformat(timespec="minutes")},
            "minimo_30d": {"nivel": round(minimo30["nivel"], 2), "hora": minimo30["hora"].isoformat(timespec="minutes")},
            "media_30d": round(statistics.fmean(l["nivel"] for l in ult30), 2),
            "dias_sem_inundacao": dias_sem,
            "dias_sem_inundacao_prefixo": dias_sem_texto,
        },
        "extremos": extremos,
        "modelo": {
            k: modelo.get(k)
            for k in ("tipo", "n_dias", "periodo", "treinado_em", "rmse_horizonte", "motivo", "validacao")
            if modelo.get(k) is not None
        },
    }
