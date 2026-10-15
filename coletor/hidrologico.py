"""Modelo hidrológico (GR4J) que transforma chuva em vazão e vazão em nível.

A regressão de modelo.py aprende bem o dia seguinte, mas subestima as cheias
que continuam subindo por vários dias depois da chuva: uma bacia de 3 mil km²
demora para escoar. O GR4J (Perrin, Michel e Andréassian, 2003) é um modelo
chuva-vazão de 4 parâmetros, muito usado em previsão de cheias com poucos
dados. Ele guarda a água do solo e da calha, então "sabe" que a água de ontem
ainda vai chegar.

Como é usado aqui:

1. calibra os 4 parâmetros do GR4J e um multiplicador da chuva com a vazão
   diária da ANA (que a estação já informa);
2. converte vazão em nível pela curva-chave tirada dos próprios dados;
3. na hora de prever, ajusta o reservatório do modelo para bater com o nível
   de agora (assimilação) e roda os próximos dias com a chuva prevista;
4. uma regressão por dia à frente corrige o que o GR4J costuma errar,
   combinando a previsão dele com o nível e a tendência de agora.

modelo.py junta essa previsão com a da regressão (`PESOS_HIDROLOGICO`).
Sem vazão na telemetria, nada disso é usado e a previsão fica só com a regressão.
"""
from __future__ import annotations

import datetime as dt
import math
import random

import numpy as np

UM = dt.timedelta(days=1)
HORIZONTE = 7
AQUECIMENTO_DIAS = 60
LIMITES = [(50.0, 2000.0), (-6.0, 3.0), (10.0, 600.0), (0.6, 8.0), (0.7, 1.8)]  # X1..X4 e fator da chuva
MIN_DIAS = 180


# ---------------------------------------------------------------- GR4J
def _sh1(t, x4):
    return 0.0 if t <= 0 else (t / x4) ** 2.5 if t < x4 else 1.0


def _sh2(t, x4):
    if t <= 0:
        return 0.0
    if t < x4:
        return 0.5 * (t / x4) ** 2.5
    return 1 - 0.5 * (2 - t / x4) ** 2.5 if t < 2 * x4 else 1.0


class Estado:
    """Reservatórios do GR4J (produção S, propagação R) e hidrogramas unitários."""

    def __init__(self, x):
        self.x = x
        self.S, self.R = 0.5 * x[0], 0.5 * x[2]
        n1, n2 = int(math.ceil(x[3])), int(math.ceil(2 * x[3]))
        self.uh1 = [_sh1(i, x[3]) - _sh1(i - 1, x[3]) for i in range(1, n1 + 1)]
        self.uh2 = [_sh2(i, x[3]) - _sh2(i - 1, x[3]) for i in range(1, n2 + 1)]
        self.f1, self.f2 = [0.0] * n1, [0.0] * n2

    def copia(self) -> "Estado":
        e = Estado.__new__(Estado)
        e.x, e.S, e.R, e.uh1, e.uh2 = self.x, self.S, self.R, self.uh1, self.uh2
        e.f1, e.f2 = list(self.f1), list(self.f2)
        return e

    def passo(self, chuva: float, etp: float) -> float:
        """Avança um dia. Chuva e evapotranspiração em mm; devolve a vazão em mm/dia."""
        x1, x2, x3, _ = self.x[:4]
        S = self.S
        if chuva >= etp:
            ws = min((chuva - etp) / x1, 13.0)
            ps = x1 * (1 - (S / x1) ** 2) * math.tanh(ws) / (1 + S / x1 * math.tanh(ws))
            S += ps
            pr = chuva - etp - ps
        else:
            ws = min((etp - chuva) / x1, 13.0)
            S -= S * (2 - S / x1) * math.tanh(ws) / (1 + (1 - S / x1) * math.tanh(ws))
            pr = 0.0
        perc = S * (1 - (1 + (4 / 9 * S / x1) ** 4) ** -0.25)
        self.S = S - perc
        pr += perc
        for i, u in enumerate(self.uh1):
            self.f1[i] += 0.9 * pr * u
        for i, u in enumerate(self.uh2):
            self.f2[i] += 0.1 * pr * u
        q9, q1 = self.f1.pop(0), self.f2.pop(0)
        self.f1.append(0.0)
        self.f2.append(0.0)
        troca = x2 * (self.R / x3) ** 3.5
        self.R = max(0.0, self.R + q9 + troca)
        qr = self.R * (1 - (1 + (self.R / x3) ** 4) ** -0.25)
        self.R -= qr
        return qr + max(0.0, q1 + troca)


def etp(data: dt.date) -> float:
    """Evapotranspiração potencial média do Sul do Brasil (mm/dia): ~4,6 no verão, ~1,4 no inverno."""
    return 3.0 + 1.6 * math.cos(2 * math.pi * (data.timetuple().tm_yday - 15) / 365.25)


def _assimilar(e: Estado, alvo_mm: float, chuva: float, evap: float) -> None:
    """Ajusta o reservatório de propagação para o passo seguinte dar a vazão observada."""
    lo, hi = 0.0, 3 * e.x[2]
    for _ in range(40):
        meio = (lo + hi) / 2
        t = e.copia()
        t.R = meio
        if t.passo(chuva, evap) < alvo_mm:
            lo = meio
        else:
            hi = meio
    e.R = (lo + hi) / 2


# ---------------------------------------------------------------- curva-chave
def curva_chave(niveis: dict, vazoes: dict) -> dict:
    """Nível médio do dia em função da vazão média do dia (m³/s), em degraus de 10 dias."""
    pares = sorted((vazoes[d], niveis[d]) for d in vazoes if d in niveis)
    q, h = [], []
    for i in range(0, len(pares), 10):
        bloco = pares[i:i + 10]
        q.append(round(float(np.median([p[0] for p in bloco])), 2))
        h.append(float(np.median([p[1] for p in bloco])))
    h = [round(v, 3) for v in np.maximum.accumulate(h)]
    return {"q": q, "h": h}


def nivel_de_vazao(curva: dict, q: float) -> float:
    qs, hs = curva["q"], curva["h"]
    if q <= qs[-1]:
        return float(np.interp(q, qs, hs))
    j = max(0, len(qs) - 6)  # acima do maior valor medido: segue a inclinação do trecho final
    inclinacao = (hs[-1] - hs[j]) / (qs[-1] - qs[j]) if qs[-1] > qs[j] else 0.0
    return hs[-1] + (q - qs[-1]) * inclinacao


def vazao_de_nivel(curva: dict, h: float) -> float:
    qs, hs = curva["q"], curva["h"]
    if h <= hs[-1]:
        return float(np.interp(h, hs, qs))
    j = max(0, len(hs) - 6)
    inclinacao = (qs[-1] - qs[j]) / (hs[-1] - hs[j]) if hs[-1] > hs[j] else 0.0
    return qs[-1] + (h - hs[-1]) * inclinacao


# ---------------------------------------------------------------- calibração
def _nse(obs, sim):
    return 1 - ((obs - sim) ** 2).sum() / ((obs - obs.mean()) ** 2).sum()


def _custo(x, datas, chuva, obs_mm):
    e = Estado(x)
    obs, sim = [], []
    for i, d in enumerate(datas):
        q = e.passo(chuva.get(d, 0.0) * x[4], etp(d))
        if i >= AQUECIMENTO_DIAS and d in obs_mm:
            obs.append(obs_mm[d])
            sim.append(q)
    obs, sim = np.array(obs), np.array(sim)
    # cheias pesam mais (NSE comum); a raiz evita desprezar o rio baixo
    return -(0.7 * _nse(obs, sim) + 0.3 * _nse(np.sqrt(obs), np.sqrt(sim)))


def _nelder_mead(f, x0, passo, iteracoes=250):
    n = len(x0)
    pts = [list(x0)] + [[x0[j] + (passo[j] if j == i else 0.0) for j in range(n)] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iteracoes):
        ordem = sorted(range(n + 1), key=lambda i: vals[i])
        pts, vals = [pts[i] for i in ordem], [vals[i] for i in ordem]
        c = [sum(p[j] for p in pts[:-1]) / n for j in range(n)]
        r = [2 * c[j] - pts[-1][j] for j in range(n)]
        fr = f(r)
        if fr < vals[0]:
            e = [3 * c[j] - 2 * pts[-1][j] for j in range(n)]
            fe = f(e)
            pts[-1], vals[-1] = (e, fe) if fe < fr else (r, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = r, fr
        else:
            k = [(c[j] + pts[-1][j]) / 2 for j in range(n)]
            fk = f(k)
            if fk < vals[-1]:
                pts[-1], vals[-1] = k, fk
            else:
                pts = [pts[0]] + [[(pts[0][j] + p[j]) / 2 for j in range(n)] for p in pts[1:]]
                vals = [vals[0]] + [f(p) for p in pts[1:]]
    i = min(range(n + 1), key=lambda i: vals[i])
    return pts[i], vals[i]


def calibrar(datas, chuva, obs_mm, semente=1, sorteios=300):
    """Sorteia parâmetros, refina os 3 melhores (Nelder-Mead) e devolve (parâmetros, NSE combinado)."""
    rng = random.Random(semente)

    def f(x):
        if any(not (a <= v <= b) for v, (a, b) in zip(x, LIMITES)):
            return 1e9
        return _custo(x, datas, chuva, obs_mm)

    amostras = sorted(([rng.uniform(a, b) for a, b in LIMITES] for _ in range(sorteios)), key=f)[:3]
    passo = [(b - a) * 0.1 for a, b in LIMITES]
    x, valor = min((_nelder_mead(f, a, passo) for a in amostras), key=lambda r: r[1])
    return [float(v) for v in x], -valor


# ---------------------------------------------------------------- previsão
def _rodar(h: dict, inicio: dt.date, d0: dt.date, chuva: dict) -> Estado:
    """Estado do GR4J no começo do dia d0 (antes do passo de d0)."""
    e = Estado(h["x"])
    d = inicio
    while d < d0:
        e.passo(chuva.get(d, 0.0) * h["x"][4], etp(d))
        d += UM
    return e


def _a_partir_de(h: dict, e: Estado, d0: dt.date, nivel_d0: float, chuva: dict) -> list[float]:
    """Previsão de nível (sem a correção) a partir do estado no começo de d0."""
    e = e.copia()
    fator = h["x"][4]
    alvo = vazao_de_nivel(h["curva"], nivel_d0) * 86.4 / h["area_km2"]
    _assimilar(e, alvo, chuva.get(d0, 0.0) * fator, etp(d0))
    e.passo(chuva.get(d0, 0.0) * fator, etp(d0))
    saida = []
    for k in range(1, HORIZONTE + 1):
        d = d0 + k * UM
        q = e.passo(chuva.get(d, 0.0) * fator, etp(d)) * h["area_km2"] / 86.4
        saida.append(nivel_de_vazao(h["curva"], q))
    return saida


def _vetor(d, k, niveis, chuva, bruta):
    """Variáveis da correção: o que o GR4J prevê, o nível e a tendência de agora e a chuva."""
    n = niveis[d]
    v1, v2 = n - niveis[d - UM], niveis[d - UM] - niveis[d - 2 * UM]
    futura = sum(chuva.get(d + i * UM, 0.0) for i in range(k + 1))
    dg = bruta[k - 1] - n
    return [dg, dg * n / 10, max(dg, 0.0), n, v1, v2, max(v1, 0.0), futura, futura * n / 10, n * n / 10]


def _aplicar(c, x):
    z = (np.array(x) - np.array(c["media"])) / np.array(c["desvio"])
    return float(c["intercepto"] + z @ np.array(c["coef"]))


def treinar(niveis: dict, vazoes: dict, chuva: dict, area_km2: float) -> dict | None:
    """Calibra o GR4J e a correção. `niveis` e `vazoes` (m³/s) são médias diárias {date: valor}."""
    from .modelo import _ajustar_ridge

    comuns = sorted(set(niveis) & set(vazoes))
    if len(comuns) < MIN_DIAS:
        return None
    inicio = min(comuns) - AQUECIMENTO_DIAS * UM  # aquece com a chuva anterior, se houver
    inicio = max(inicio, min(chuva)) if chuva else inicio
    fim = max(comuns)
    datas = [inicio + i * UM for i in range((fim - inicio).days + 1)]
    obs_mm = {d: vazoes[d] * 86.4 / area_km2 for d in comuns}
    x, nse = calibrar(datas, chuva, obs_mm)
    h = {"x": x, "nse": round(nse, 3), "area_km2": area_km2, "curva": curva_chave(niveis, vazoes),
         "inicio": inicio.isoformat()}

    # previsões do GR4J a partir de cada dia, para ensinar a correção
    validos = [d for d in sorted(niveis) if all(d - i * UM in niveis for i in range(3)) and d >= inicio]
    brutas = _brutas(h, validos, niveis, chuva)
    correcoes = []
    for k in range(1, HORIZONTE + 1):
        X, y = [], []
        for d in validos:
            if d + k * UM in niveis and d in brutas:
                X.append(_vetor(d, k, niveis, chuva, brutas[d]))
                y.append(niveis[d + k * UM] - niveis[d])
        correcoes.append(_ajustar_ridge(np.array(X, dtype=float), np.array(y, dtype=float), alfa=3.0))
    h["correcao"] = correcoes
    h["n_dias"] = len(validos)
    return h


def _brutas(h: dict, inicios: list, niveis: dict, chuva: dict) -> dict:
    """Previsões do GR4J (sem correção) a partir de cada dia de `inicios`, numa só passada."""
    inicio = dt.date.fromisoformat(h["inicio"])
    alvo = {d for d in inicios if d >= inicio}
    saida, e, d = {}, Estado(h["x"]), inicio
    while alvo and d <= max(alvo):
        if d in alvo:
            saida[d] = _a_partir_de(h, e, d, niveis[d], chuva)
        e.passo(chuva.get(d, 0.0) * h["x"][4], etp(d))
        d += UM
    return saida


def prever_varios(h: dict, inicios: list, niveis: dict, chuva: dict) -> dict:
    """Previsão corrigida a partir de cada dia de `inicios` (para o teste retroativo)."""
    saida = {}
    for d0, bruta in _brutas(h, inicios, niveis, chuva).items():
        saida[d0] = [niveis[d0] + _aplicar(h["correcao"][k - 1], _vetor(d0, k, niveis, chuva, bruta))
                     for k in range(1, HORIZONTE + 1)]
    return saida


def prever(h: dict, d0: dt.date, niveis: dict, chuvas: list[dict]) -> list[list[float]]:
    """Níveis previstos para os 7 dias seguintes, uma lista por versão da chuva.

    `niveis` precisa ter d0 (nível de agora) e os dois dias anteriores.
    """
    inicio = dt.date.fromisoformat(h["inicio"])
    estado = _rodar(h, inicio, d0, chuvas[0])  # o passado é o mesmo em todas as versões
    saida = []
    for c in chuvas:
        bruta = _a_partir_de(h, estado, d0, niveis[d0], c)
        saida.append([
            niveis[d0] + _aplicar(h["correcao"][k - 1], _vetor(d0, k, niveis, c, bruta))
            for k in range(1, HORIZONTE + 1)
        ])
    return saida
