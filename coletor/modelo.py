"""Previsão de nível do rio a partir de chuva, inércia do rio e rio acima.

A ideia é propositalmente simples e auditável: uma regressão linear (ridge)
que prevê quanto o rio sobe ou desce de um dia para o outro. Ela é aplicada
dia a dia, usando a chuva prevista, para montar os próximos 7 dias.

Variáveis de cada dia d (prevendo h[d+1] - h[d]):
  nível atual, variação do último dia, chuva do dia seguinte, chuva de hoje e
  dos dois dias anteriores, índice de chuva antecedente (proxy de solo
  encharcado), chuva × solo encharcado, e variação do nível rio acima
  (deslocada pelo tempo de viagem da onda de cheia, se houver estação).

A incerteza vem de um teste retroativo: o modelo é rodado a partir de cada dia
do período de validação e o erro de cada horizonte (1 a 7 dias) vira o desvio
das faixas. Esse teste usa a chuva que de fato caiu; como a chuva prevista
também erra, as faixas são multiplicadas por um fator de segurança.

Sem histórico suficiente, cai para um modelo heurístico com coeficientes
padrão configuráveis, e o painel avisa que a previsão não está calibrada.
"""
from __future__ import annotations

import datetime as dt
import math

import numpy as np

HORIZONTE = 7
K_API = 0.85  # decaimento diário do índice de chuva antecedente
NOMES = [
    "nivel",
    "variacao_1d",
    "chuva_amanha",
    "chuva_hoje",
    "chuva_ontem",
    "chuva_anteontem",
    "chuva_antecedente",
    "chuva_x_solo",
    "montante_variacao",
    "chuva_3d",
    "chuva_3d_quadrado",
    "chuva_3d_x_solo",
    "nivel_x_chuva_3d",
    "nivel_quadrado",
]
MIN_DIAS_TREINO = 120
MIN_ANALOGOS = 30


def _d(data) -> dt.date:
    return data if isinstance(data, dt.date) else dt.date.fromisoformat(str(data)[:10])


def indice_antecedente(chuva: dict[dt.date, float], datas: list[dt.date]) -> dict[dt.date, float]:
    api, valor = {}, 0.0
    for data in datas:
        valor = K_API * valor + chuva.get(data, 0.0)
        api[data] = valor
    return api


def _vetor(d, h, chuva, api, montante, atraso):
    um = dt.timedelta(days=1)
    p = lambda x: chuva.get(x, 0.0)  # noqa: E731
    variacao_montante = 0.0
    if montante:
        a = d + um - dt.timedelta(days=atraso)
        b = a - um
        if a in montante and b in montante:
            variacao_montante = montante[a] - montante[b]
    api_ontem = api.get(d - um, 0.0)
    chuva_3d = p(d + um) + p(d) + p(d - um)
    return [
        h[d],
        h[d] - h[d - um],
        p(d + um),
        p(d),
        p(d - um),
        p(d - 2 * um),
        api_ontem,
        p(d + um) * api_ontem / 100.0,
        variacao_montante,
        # termos não lineares: a resposta a chuva forte e com o rio alto não é proporcional
        chuva_3d,
        chuva_3d**2 / 100.0,
        chuva_3d * api_ontem / 1000.0,
        h[d] * chuva_3d / 10.0,
        h[d] ** 2 / 10.0,
    ]


def montar_matriz(niveis, chuva, montante=None, atraso=0):
    """Monta X, y a partir de séries diárias {date: valor}."""
    niveis = {_d(k): v for k, v in niveis.items() if v is not None}
    chuva = {_d(k): v for k, v in chuva.items() if v is not None}
    montante = {_d(k): v for k, v in (montante or {}).items() if v is not None}
    datas = sorted(niveis)
    if not datas:
        return np.zeros((0, len(NOMES))), np.zeros(0), []
    todas = [datas[0] + dt.timedelta(days=i) for i in range((datas[-1] - datas[0]).days + 1)]
    api = indice_antecedente(chuva, todas)
    um = dt.timedelta(days=1)
    X, y, usadas = [], [], []
    for d in datas:
        if d - um in niveis and d + um in niveis and (d + um) in chuva and d in chuva:
            X.append(_vetor(d, niveis, chuva, api, montante, atraso))
            y.append(niveis[d + um] - niveis[d])
            usadas.append(d)
    return np.array(X, dtype=float), np.array(y, dtype=float), usadas


def _ajustar_ridge(X, y, alfa=1.0):
    media = X.mean(axis=0)
    desvio = X.std(axis=0)
    desvio[desvio == 0] = 1.0
    Z = (X - media) / desvio
    A = Z.T @ Z + alfa * np.eye(Z.shape[1])
    coef = np.linalg.solve(A, Z.T @ (y - y.mean()))
    return {"media": media.tolist(), "desvio": desvio.tolist(), "coef": coef.tolist(), "intercepto": float(y.mean())}


def _prever_delta(modelo, x):
    if modelo["tipo"] == "heuristico":
        p = modelo["parametros"]
        nivel, _, amanha, hoje, ontem, _, api, _, mont = x[:9]
        saturacao = min(1.5, 0.6 + api / 100.0)
        return (
            -p["recessao"] * max(0.0, nivel - p["nivel_base"])
            + saturacao * (p["resposta_amanha"] * amanha + p["resposta_hoje"] * hoje + p["resposta_ontem"] * ontem)
            + 0.5 * mont
        )
    z = (np.array(x) - np.array(modelo["media"])) / np.array(modelo["desvio"])
    return float(modelo["intercepto"] + z @ np.array(modelo["coef"]))


def simular(modelo, inicio: dt.date, niveis, chuva, montante=None, atraso=0, dias=HORIZONTE):
    """Roda o modelo dia a dia a partir de `inicio` e devolve os níveis previstos."""
    niveis = dict(niveis)
    todas = sorted(set(list(chuva)) | {inicio + dt.timedelta(days=i) for i in range(-30, dias + 1)})
    um = dt.timedelta(days=1)
    piso = modelo.get("nivel_minimo", 0.0)
    previstos = []
    for k in range(dias):
        d = inicio + k * um
        api = indice_antecedente(chuva, [x for x in todas if x <= d])
        x = _vetor(d, niveis, chuva, api, montante or {}, atraso)
        proximo = max(piso, niveis[d] + _prever_delta(modelo, x))
        niveis[d + um] = proximo
        previstos.append(proximo)
    return previstos


def chuva_acumulada(chuva, inicio, k):
    """Chuva de `inicio` até o dia alvo (k+1 dias à frente), usada para achar situações parecidas."""
    return sum(chuva.get(inicio + dt.timedelta(days=j), 0.0) for j in range(k + 2))


def teste_retroativo(modelo, niveis, chuva, montante, atraso, inicios):
    """Roda o modelo a partir de cada dia e devolve, por horizonte, pares (chuva acumulada, erro).

    erro = previsto - observado (negativo quando o rio subiu mais que o previsto).
    """
    pares = [[] for _ in range(HORIZONTE)]
    for s in inicios:
        base = {d: v for d, v in niveis.items() if d <= s}
        if s - dt.timedelta(days=1) not in base:
            continue
        previstos = simular(modelo, s, base, chuva, montante, atraso)
        for k, valor in enumerate(previstos):
            alvo = s + dt.timedelta(days=k + 1)
            if alvo in niveis:
                pares[k].append((chuva_acumulada(chuva, s, k), valor - niveis[alvo]))
    return pares


def erro_por_horizonte(modelo, niveis, chuva, montante, atraso, inicios):
    pares = teste_retroativo(modelo, niveis, chuva, montante, atraso, inicios)
    return [float(np.sqrt(np.mean([e * e for _, e in p]))) if p else None for p in pares]


def treinar(niveis, chuva, montante=None, atraso=0, config_modelo=None) -> dict:
    """Treina com 80% do período, valida nos 20% finais e reajusta com tudo."""
    config_modelo = config_modelo or {}
    niveis = {_d(k): v for k, v in niveis.items() if v is not None}
    chuva = {_d(k): v for k, v in chuva.items() if v is not None}
    montante = {_d(k): v for k, v in (montante or {}).items() if v is not None}
    X, y, datas = montar_matriz(niveis, chuva, montante, atraso)
    if len(y) < MIN_DIAS_TREINO:
        return modelo_heuristico(config_modelo, motivo=f"apenas {len(y)} dias com nível e chuva (mínimo {MIN_DIAS_TREINO})")

    corte = int(len(y) * 0.8)
    parcial = {"tipo": "calibrado", **_ajustar_ridge(X[:corte], y[:corte]), "nivel_minimo": float(min(niveis.values()))}
    pares = teste_retroativo(parcial, niveis, chuva, montante, atraso, datas[corte:-1])
    if any(len(p) < MIN_ANALOGOS for p in pares):
        pares = teste_retroativo(parcial, niveis, chuva, montante, atraso, datas[:-1])
    rmse = [float(np.sqrt(np.mean([e * e for _, e in p]))) if p else None for p in pares]

    # comparação justa: o mesmo período, com o palpite "o rio fica como está hoje"
    inicios_validacao = datas[corte:-1]
    palpite = [[] for _ in range(HORIZONTE)]
    for s0 in inicios_validacao:
        for k in range(HORIZONTE):
            alvo = s0 + dt.timedelta(days=k + 1)
            if alvo in niveis:
                palpite[k].append(abs(niveis[s0] - niveis[alvo]))
    validacao = {
        "periodo": [inicios_validacao[0].isoformat(), inicios_validacao[-1].isoformat()] if inicios_validacao else None,
        "n_dias": len(inicios_validacao),
        "erro_medio": [round(float(np.mean([abs(e) for _, e in p])), 3) if p else None for p in pares],
        "erro_palpite": [round(float(np.mean(v)), 3) if v else None for v in palpite],
    }

    final = _ajustar_ridge(X, y)
    rmse = _monotono([r if r is not None else 0.3 * (k + 1) for k, r in enumerate(rmse)])
    return {
        "tipo": "calibrado",
        **final,
        "variaveis": NOMES,
        "nivel_minimo": float(min(niveis.values())),
        "rmse_horizonte": [round(r, 3) for r in rmse],
        "erros_validacao": [[[round(c, 1), round(e, 3)] for c, e in p] for p in pares],
        "validacao": validacao,
        "n_dias": int(len(y)),
        "periodo": [datas[0].isoformat(), datas[-1].isoformat()],
        "treinado_em": dt.datetime.now().isoformat(timespec="minutes"),
        "atraso_montante_dias": atraso,
    }


def _monotono(valores):
    saida, maior = [], 0.0
    for v in valores:
        maior = max(maior, v)
        saida.append(maior)
    return saida


def compativel(modelo: dict | None) -> bool:
    """Um modelo salvo por uma versão anterior (outras variáveis) não pode ser usado."""
    if not modelo:
        return False
    return modelo.get("tipo") == "heuristico" or modelo.get("variaveis") == NOMES


def modelo_heuristico(config_modelo: dict, motivo: str = "modelo ainda não treinado") -> dict:
    padrao = {
        "nivel_base": 2.0,
        "recessao": 0.15,
        "resposta_amanha": 0.015,
        "resposta_hoje": 0.035,
        "resposta_ontem": 0.02,
    }
    padrao.update(config_modelo.get("heuristico", {}))
    return {
        "tipo": "heuristico",
        "parametros": padrao,
        "nivel_minimo": 0.0,
        "rmse_horizonte": [round(0.35 * (k + 1) ** 0.8, 3) for k in range(HORIZONTE)],
        "motivo": motivo,
    }


def _normal_acima(limite, media, desvio):
    if desvio <= 0:
        return 1.0 if media >= limite else 0.0
    return 0.5 * math.erfc((limite - media) / (desvio * math.sqrt(2)))


def _faixa_empirica(pares, chuva_prevista):
    """Quantis do erro nas situações de validação com chuva mais parecida com a prevista."""
    ordenados = sorted(pares, key=lambda p: abs(math.log1p(p[0]) - math.log1p(chuva_prevista)))
    erros = np.array([e for _, e in ordenados[: max(MIN_ANALOGOS, len(ordenados) * 2 // 5)]])
    return erros


def prever(modelo, hoje: dt.date, nivel_atual: float, niveis_diarios, chuva, montante=None,
           cota_inundacao=None, fator_incerteza=1.3, crescimento_diario=0.15, fator_empirico=1.0,
           cotas_extras=None):
    """Previsão dos próximos 7 dias a partir do nível atual.

    Faixa de 80% (do 10º ao 90º percentil):
    * modelo calibrado: vem dos erros reais do teste retroativo, escolhendo as
      situações com chuva acumulada mais parecida com a prevista. A faixa sai
      assimétrica, como os erros reais (o modelo tende a subestimar subidas
      depois de chuva forte, então a faixa se abre mais para cima).
    * modelo heurístico: curva normal com desvio genérico, que cresce
      `crescimento_diario` a cada dia à frente.
    As larguras nunca diminuem com o horizonte.
    """
    niveis = {_d(k): v for k, v in niveis_diarios.items() if v is not None}
    niveis[hoje] = nivel_atual
    ontem = hoje - dt.timedelta(days=1)
    niveis.setdefault(ontem, nivel_atual)
    chuva = {_d(k): v for k, v in chuva.items() if v is not None}
    montante = {_d(k): v for k, v in (montante or {}).items() if v is not None}
    atraso = modelo.get("atraso_montante_dias", 0)
    medias = simular(modelo, hoje, niveis, chuva, montante, atraso)
    piso = modelo.get("nivel_minimo", 0.0)
    validacao = modelo.get("erros_validacao") or []
    empirico = len(validacao) == HORIZONTE and all(len(p) >= MIN_ANALOGOS for p in validacao)

    saida, abaixo_max, acima_max = [], 0.0, 0.0
    for k, media in enumerate(medias):
        item = {"data": (hoje + dt.timedelta(days=k + 1)).isoformat(), "media": round(media, 2)}
        if empirico:
            erros = _faixa_empirica(validacao[k], chuva_acumulada(chuva, hoje, k)) * fator_empirico
            abaixo = max(0.0, float(np.quantile(erros, 0.9)))   # observado = previsto - erro
            acima = max(0.0, -float(np.quantile(erros, 0.1)))
            prob = float(np.mean(media - erros >= cota_inundacao)) if cota_inundacao is not None else None
            desvio = float(np.sqrt(np.mean(erros**2)))
            chance = lambda c: float(np.mean(media - erros >= c))  # noqa: E731
        else:
            desvio = modelo["rmse_horizonte"][k] * fator_incerteza * (1 + crescimento_diario * k)
            abaixo = acima = 1.28 * desvio
            prob = _normal_acima(cota_inundacao, media, desvio) if cota_inundacao is not None else None
            chance = lambda c, m=media, d=desvio: _normal_acima(c, m, d)  # noqa: E731
        abaixo_max, acima_max = max(abaixo_max, abaixo), max(acima_max, acima)
        item.update({
            "min": round(max(piso, media - abaixo_max), 2),
            "max": round(media + acima_max, 2),
            "desvio": round(desvio, 3),
        })
        if prob is not None:
            item["prob_inundacao"] = round(prob, 3)
        if cotas_extras:
            # chance de passar de cada marco da régua / local cadastrado, para a linha do tempo
            item["prob_cotas"] = {f"{c:.2f}": round(chance(c), 3) for c in cotas_extras}
        saida.append(item)
    return saida


def projecao_horaria(agora: dt.datetime, nivel_atual: float, tendencia_m_h: float, diaria: list[dict], horas=48):
    """Curva suave hora a hora ligando o nível atual às previsões diárias.

    Usa interpolação de Hermite: começa com a tendência observada nas últimas
    horas e chega ao valor previsto para amanhã (24 h) e depois de amanhã (48 h).
    """
    pontos = [(0.0, nivel_atual, (0.0, 0.0))] + [
        (24.0 * (i + 1), d["media"], (d["media"] - d["min"], d["max"] - d["media"]))
        for i, d in enumerate(diaria[: max(2, horas // 24)])
    ]
    niveis = [p[1] for p in pontos]
    inclinacoes = [max(-0.2, min(0.2, tendencia_m_h))]
    for i in range(1, len(pontos)):
        seguinte = niveis[min(i + 1, len(niveis) - 1)]
        anterior = niveis[i - 1]
        passo = 24.0 * (2 if i + 1 < len(niveis) else 1)
        inclinacoes.append((seguinte - anterior) / passo)

    saida = []
    for hora in range(1, horas + 1):
        i = min(int((hora - 1) // 24), len(pontos) - 2)
        t0, h0, s0d = pontos[i]
        t1, h1, s1d = pontos[i + 1]
        u = (hora - t0) / (t1 - t0)
        largura = t1 - t0
        h00, h10 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u
        h01, h11 = -2 * u**3 + 3 * u**2, u**3 - u**2
        valor = h00 * h0 + h10 * largura * inclinacoes[i] + h01 * h1 + h11 * largura * inclinacoes[i + 1]
        if i > 0:
            abaixo = s0d[0] + (s1d[0] - s0d[0]) * u
            acima = s0d[1] + (s1d[1] - s0d[1]) * u
        else:
            abaixo, acima = s1d[0] * math.sqrt(u), s1d[1] * math.sqrt(u)
        saida.append(
            {
                "hora": (agora + dt.timedelta(hours=hora)).isoformat(timespec="minutes"),
                "media": round(valor, 2),
                "min": round(max(0.0, valor - abaixo), 2),
                "max": round(valor + acima, 2),
            }
        )
    return saida
