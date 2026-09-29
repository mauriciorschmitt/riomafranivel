"""Compara previsões registradas (nossas e de outros sistemas) com o que o rio fez.

Uso: python comparacao/comparar.py
Lê comparacao/previsoes_registradas.csv e a telemetria guardada em dados/<cidade>/,
e mostra, dia a dia, o nível médio observado e o erro de cada sistema.
"""
import csv
import statistics
import sys
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
from coletor import base  # noqa: E402

CIDADE = sys.argv[1] if len(sys.argv) > 1 else "mafra-rionegro"

leituras = base.ler_leituras(base.PASTA_DADOS / CIDADE / "telemetria.csv")
por_dia = defaultdict(list)
for l in leituras:
    por_dia[l["hora"].date().isoformat()].append(l["nivel_m"])
observado = {d: statistics.fmean(v) for d, v in por_dia.items() if len(v) >= 8}
pico = {d: max(v) for d, v in por_dia.items() if len(v) >= 8}

linhas = list(csv.DictReader(open(RAIZ / "comparacao" / "previsoes_registradas.csv", encoding="utf-8")))
# cada "rodada" é um sistema numa data de emissão: permite comparar como cada um foi corrigindo
rotulo = lambda l: f"{l['sistema']} {l['emitida'][8:10]}/{l['emitida'][5:7]}"  # noqa: E731
sistemas = sorted({rotulo(l) for l in linhas}, key=lambda r: (r.split()[0], r.split()[1][3:5], r.split()[1][:2]))
datas = sorted({l["data"] for l in linhas})
prev = {(rotulo(l), l["data"]): float(l["previsto_m"]) for l in linhas}
faixa = {(rotulo(l), l["data"]): (l["min_m"], l["max_m"]) for l in linhas}

print(f"{'dia':10} {'observado':>10} {'máx. do dia':>11} " + " ".join(f"{s:>22}" for s in sistemas))
erros = defaultdict(list)
for d in datas:
    obs = observado.get(d)
    txt_obs = "a ver" if obs is None else f"{obs:.2f}"
    txt_pico = "a ver" if d not in pico else f"{pico[d]:.2f}"
    linha = f"{d:10} {txt_obs:>10} {txt_pico:>11} "
    for s in sistemas:
        p = prev.get((s, d))
        if p is None:
            linha += f"{'–':>22} "
            continue
        if obs is None:
            linha += f"{p:>14.2f} (a ver) "
            continue
        erros[s].append(abs(p - obs))
        mn, mx = faixa[(s, d)]
        dentro = "" if not mn else (" ✓faixa" if float(mn) <= obs <= float(mx) else " ✗faixa")
        linha += f"{p:>8.2f} erro {p - obs:+.2f}{dentro:>7} "
    print(linha)
print()
for s in sistemas:
    if erros[s]:
        print(f"{s}: erro médio {statistics.fmean(erros[s]):.2f} m em {len(erros[s])} dia(s) conferido(s)")
    else:
        print(f"{s}: nenhum dia conferido ainda")
