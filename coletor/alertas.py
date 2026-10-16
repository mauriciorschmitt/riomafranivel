"""Telegram: alerta quando o rio muda de faixa e boletins de rotina.

Dois tipos de mensagem, sempre com a imagem do boletim:
  * MUDANÇA DE FAIXA (subiu para Alerta, baixou para Atenção...): na hora, COM som;
  * BOLETIM DE ROTINA: SEM som (aparece no canal, mas não apita), com frequência
    conforme a faixa. Padrão: Normal 1x por dia (7h), Atenção 3x (7h, 12h, 18h) e
    Alerta, Emergência e Extremo a cada leitura nova (de hora em hora). A cidade
    pode mudar em "alertas": {"boletins": {"normal": [7], "alerta": "toda_hora", ...}}.
O som fica reservado para o que muda a situação; assim ninguém silencia o canal.

Configuração (opcional):
  * Crie um bot com o @BotFather e um canal público; adicione o bot como admin.
  * No GitHub: Settings > Secrets > Actions > TELEGRAM_TOKEN.
  * Na configuração da cidade: "alertas": {"telegram_canal": "@nome_do_canal"}.
Sem token ou sem canal, nada é enviado e o resto funciona normalmente.

O alerta vai como FOTO (a mesma imagem do boletim do site, gerada por cartao.py)
com o texto embaixo. A coleta (gerar.py) só marca o alerta como pendente; quem manda
é `--pendentes`, num passo à parte do GitHub Actions que instala o navegador só
quando precisa. Se a imagem falhar, o alerta vai só em texto.

  python -m coletor.alertas --pendentes                     # manda os alertas marcados
  python -m coletor.alertas --teste --cidade mafra-rionegro # manda o boletim atual como teste
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import requests

from . import base, cartao

ARQUIVO_PENDENTE = "alerta_pendente.json"  # fica fora do repositório (.gitignore)
ARQUIVO_BOLETINS = "boletins.json"         # o último boletim de rotina mandado (fica no repositório)
BOLETINS_PADRAO = {"normal": [7], "atencao": [7, 12, 18], "alerta": "toda_hora", "emergencia": "toda_hora", "extremo": "toda_hora"}
IDADE_MAXIMA_ROTINA_MIN = 180  # leitura mais velha que isso (estação parada): não manda boletim de rotina

ICONE = {"normal": "🟢", "atencao": "🟡", "alerta": "🟠", "emergencia": "🔴", "extremo": "🟣"}


def _formatar(n: float, casas: int = 2) -> str:
    return f"{n:.{casas}f}".replace(".", ",")


ORDEM_FAIXAS = ["normal", "atencao", "alerta", "emergencia", "extremo"]


def _subiu(anterior: dict | None, atual: dict) -> bool:
    """Pela ordem das faixas (Atenção < Alerta...); sem faixa anterior, pelo nível."""
    antes, agora = (anterior or {}).get("status"), atual["status"]["id"]
    if antes in ORDEM_FAIXAS and agora in ORDEM_FAIXAS:
        return ORDEM_FAIXAS.index(agora) > ORDEM_FAIXAS.index(antes)
    return anterior is None or atual["nivel"] >= anterior.get("nivel", 0)


def mensagem(saida: dict, anterior: dict | None, teste: bool = False, rotina: bool = False) -> str:
    cfg, atual = saida["config"], saida["atual"]
    st = atual["status"]
    if rotina:
        topo = f"Boletim das {int(atual['hora'][11:13])}h: {cfg['rio']} em {cfg['local']} está em {st['nome'].upper()}"
    else:
        verbo = "está em" if teste else "subiu para" if _subiu(anterior, atual) else "baixou para"
        topo = f"{cfg['rio']} em {cfg['local']}: {verbo} {st['nome'].upper()}"
    linhas = [f"{ICONE.get(st['id'], '')} {topo}".strip()]
    nivel = f"Nível: {_formatar(atual['nivel'])} m às {atual['hora'][11:16]}"
    t = atual.get("tendencia_cm_h")
    if t is not None:
        nivel += ", estável" if abs(t) < 0.5 else f", {'subindo' if t > 0 else 'baixando'} {_formatar(abs(t), 1)} cm por hora"
    linhas.append(nivel)
    amanha = saida["previsao_dias"][1] if len(saida.get("previsao_dias", [])) > 1 else {}
    if amanha.get("min") is not None:
        ate = amanha.get("pico_max") or amanha["max"]
        linhas.append(f"Amanhã: deve ficar entre {_formatar(amanha['min'], 1)} e {_formatar(ate, 1)} m")
    if cfg.get("url_site"):
        linhas.append(f"Previsão e o que fazer: {cfg['url_site']}")
    linhas.append("Emergência: Defesa Civil 199")
    return "\n".join(linhas)


def enviar(saida: dict, texto: str, imagem: bytes | None = None, silencioso: bool = False) -> bool:
    """Manda no canal da cidade: a imagem com `texto` de legenda, ou só o texto. Silencioso: sem som."""
    token = os.environ.get("TELEGRAM_TOKEN")
    canal = (saida["config"].get("alertas") or {}).get("telegram_canal")
    if not token or not canal:
        print("     aviso: Telegram sem token (segredo TELEGRAM_TOKEN) ou sem canal (alertas.telegram_canal)")
        return False
    api = f"https://api.telegram.org/bot{token}"
    try:
        if imagem:
            r = requests.post(f"{api}/sendPhoto", data={"chat_id": canal, "caption": texto[:1024], "disable_notification": "true" if silencioso else "false"},
                              files={"photo": ("boletim.png", imagem, "image/png")}, timeout=60)
        else:
            r = requests.post(f"{api}/sendMessage", json={"chat_id": canal, "text": texto, "disable_notification": silencioso}, timeout=20)
    except requests.RequestException as erro:
        print(f"     aviso: Telegram falhou ({type(erro).__name__})")  # sem a URL: ela contém o token
        return False
    if not r.ok:  # o Telegram diz o motivo (bot não é admin, canal com outro nome...)
        try:
            motivo = r.json().get("description", "")
        except ValueError:
            motivo = ""
        print(f"     aviso: Telegram recusou ({r.status_code}): {motivo}")
    return r.ok


def vez_do_boletim(saida: dict) -> str | None:
    """Qual boletim de rotina vale agora. Muda de valor quando é hora de mandar outro.

    Com horários fixos ([7, 12, 18]) é o último horário que já passou: se a coleta
    das 12h atrasar, o boletim sai às 12h40, e não se perde. Com "toda_hora" é a
    hora da leitura: só sai boletim quando chega leitura nova da estação.
    """
    st = saida["atual"]["status"]["id"]
    regras = {**BOLETINS_PADRAO, **((saida["config"].get("alertas") or {}).get("boletins") or {})}
    regra = regras.get(st)
    if regra == "toda_hora":
        return f"leitura {saida['atual']['hora'][:13]}"
    horas = sorted(int(h) for h in (regra or []))
    if not horas:
        return None
    agora = dt.datetime.fromisoformat(saida["gerado_em"])
    passadas = [h for h in horas if h <= agora.hour]
    if passadas:
        return f"{agora.date().isoformat()} {passadas[-1]:02d}h"
    return f"{(agora.date() - dt.timedelta(days=1)).isoformat()} {horas[-1]:02d}h"


def verificar(slug: str, saida: dict) -> bool:
    """Marca para envio (passo "--pendentes") o alerta de mudança de faixa ou o boletim de rotina."""
    caminho = base.pasta(slug) / "alerta.json"
    anterior = base.ler_json(caminho)
    atual = saida["atual"]
    base.salvar_json(caminho, {"status": atual["status"]["id"], "nivel": atual["nivel"], "hora": atual["hora"]})
    if saida.get("demo"):
        return False
    caminho_boletins = base.pasta(slug) / ARQUIVO_BOLETINS
    ultimo = (base.ler_json(caminho_boletins) or {}).get("vez")
    vez = vez_do_boletim(saida)
    mudou = anterior is not None and anterior.get("status") != atual["status"]["id"]
    if mudou:
        pendente = {"texto": mensagem(saida, anterior), "silencioso": False}
    elif vez and vez != ultimo and atual.get("idade_min", 0) <= IDADE_MAXIMA_ROTINA_MIN:
        pendente = {"texto": mensagem(saida, None, rotina=True), "silencioso": True}
    else:
        return False
    # o alerta também conta como o boletim desta vez: não sai um boletim repetido logo depois
    base.salvar_json(caminho_boletins, {"vez": vez, "hora": atual["hora"]})
    base.salvar_json(base.pasta(slug) / ARQUIVO_PENDENTE, {**pendente, "hora": atual["hora"]})
    return True


def _boletim_publicado(slug: str) -> dict | None:
    saida = base.ler_json(base.PASTA_SITE / "dados" / f"{slug}.json")
    if saida:
        saida["config"] = base.carregar_config(slug)  # a configuração de agora (canal recém-trocado, por exemplo)
    return saida


def enviar_pendentes() -> int:
    """Manda os alertas marcados pela coleta, com a imagem do boletim. Devolve quantos falharam."""
    falhas = 0
    for slug in base.listar_cidades():
        caminho = base.pasta(slug) / ARQUIVO_PENDENTE
        pendente = base.ler_json(caminho)
        if not pendente:
            continue
        saida = _boletim_publicado(slug)
        silencioso = bool(pendente.get("silencioso"))
        ok = bool(saida) and enviar(saida, pendente["texto"], cartao.imagem_boletim(slug), silencioso)
        tipo = "boletim de rotina (sem som)" if silencioso else "alerta de mudança de faixa"
        print(f"[{'ok' if ok else 'erro'}] {slug}: {tipo} {'enviado' if ok else 'não enviado'}")
        falhas += not ok
        caminho.unlink(missing_ok=True)  # não reenviar o mesmo alerta na próxima coleta
    return falhas


def teste(slug: str) -> bool:
    """Manda o último boletim publicado no site, avisando que é um teste."""
    saida = _boletim_publicado(slug)
    if not saida:
        print(f"[erro] {slug}: nenhum boletim publicado ainda")
        return False
    texto = f"Mensagem de teste: o canal de alertas está funcionando.\n\n{mensagem(saida, None, teste=True)}"
    ok = enviar(saida, texto, cartao.imagem_boletim(slug))
    print(f"[{'ok' if ok else 'erro'}] {slug}: teste {'enviado' if ok else 'não enviado'}")
    return ok


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Alertas no Telegram")
    parser.add_argument("--cidade")
    parser.add_argument("--teste", action="store_true", help="manda o boletim atual como mensagem de teste")
    parser.add_argument("--pendentes", action="store_true", help="manda os alertas marcados pela coleta")
    args = parser.parse_args(argv)
    if args.pendentes:
        return 1 if enviar_pendentes() else 0
    if args.teste and args.cidade:
        return 0 if teste(args.cidade) else 1
    parser.error("use --pendentes, ou --teste --cidade <nome>")


if __name__ == "__main__":
    sys.exit(main())
