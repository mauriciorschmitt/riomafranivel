"""Aviso no Telegram quando o rio muda de faixa (sobe ou desce).

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
import os
import sys

import requests

from . import base, cartao

ARQUIVO_PENDENTE = "alerta_pendente.json"  # fica fora do repositório (.gitignore)

ICONE = {"normal": "🟢", "atencao": "🟡", "alerta": "🟠", "emergencia": "🔴", "extremo": "🟣"}


def _formatar(n: float, casas: int = 2) -> str:
    return f"{n:.{casas}f}".replace(".", ",")


def mensagem(saida: dict, anterior: dict | None, teste: bool = False) -> str:
    cfg, atual = saida["config"], saida["atual"]
    st = atual["status"]
    if teste:
        verbo = "está em"
    else:
        verbo = "subiu para" if anterior is None or atual["nivel"] >= anterior.get("nivel", 0) else "baixou para"
    linhas = [f"{ICONE.get(st['id'], '')} {cfg['rio']} em {cfg['local']}: {verbo} {st['nome'].upper()}".strip()]
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


def enviar(saida: dict, texto: str, imagem: bytes | None = None) -> bool:
    """Manda no canal da cidade: a imagem com `texto` de legenda, ou só o texto."""
    token = os.environ.get("TELEGRAM_TOKEN")
    canal = (saida["config"].get("alertas") or {}).get("telegram_canal")
    if not token or not canal:
        print("     aviso: Telegram sem token (segredo TELEGRAM_TOKEN) ou sem canal (alertas.telegram_canal)")
        return False
    api = f"https://api.telegram.org/bot{token}"
    try:
        if imagem:
            r = requests.post(f"{api}/sendPhoto", data={"chat_id": canal, "caption": texto[:1024]},
                              files={"photo": ("boletim.png", imagem, "image/png")}, timeout=60)
        else:
            r = requests.post(f"{api}/sendMessage", json={"chat_id": canal, "text": texto}, timeout=20)
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


def verificar(slug: str, saida: dict) -> bool:
    caminho = base.pasta(slug) / "alerta.json"
    anterior = base.ler_json(caminho)
    atual = saida["atual"]
    base.salvar_json(caminho, {"status": atual["status"]["id"], "nivel": atual["nivel"], "hora": atual["hora"]})
    if saida.get("demo") or (anterior and anterior.get("status") == atual["status"]["id"]):
        return False
    if anterior is None:
        return False  # primeira execução: só registra o estado
    # o envio (com a imagem) fica para o passo "--pendentes"
    base.salvar_json(base.pasta(slug) / ARQUIVO_PENDENTE, {"texto": mensagem(saida, anterior), "hora": atual["hora"]})
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
        ok = bool(saida) and enviar(saida, pendente["texto"], cartao.imagem_boletim(slug))
        print(f"[{'ok' if ok else 'erro'}] {slug}: alerta {'enviado' if ok else 'não enviado'}")
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
