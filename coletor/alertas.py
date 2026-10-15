"""Aviso no Telegram quando o rio muda de faixa (sobe ou desce).

Configuração (opcional):
  * Crie um bot com o @BotFather e um canal público; adicione o bot como admin.
  * No GitHub: Settings > Secrets > Actions > TELEGRAM_TOKEN.
  * Na configuração da cidade: "alertas": {"telegram_canal": "@nome_do_canal"}.
Sem token ou sem canal, nada é enviado e o resto funciona normalmente.

Para testar o canal (manda o último boletim publicado):
  python -m coletor.alertas --teste --cidade mafra-rionegro
"""
from __future__ import annotations

import argparse
import os
import sys

import requests

from . import base

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


def enviar(saida: dict, texto: str) -> bool:
    """Manda `texto` no canal da cidade. Sem token ou sem canal, não faz nada."""
    token = os.environ.get("TELEGRAM_TOKEN")
    canal = (saida["config"].get("alertas") or {}).get("telegram_canal")
    if not token or not canal:
        print("     aviso: Telegram sem token (segredo TELEGRAM_TOKEN) ou sem canal (alertas.telegram_canal)")
        return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": canal, "text": texto}, timeout=20)
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
    return enviar(saida, mensagem(saida, anterior))


def teste(slug: str) -> bool:
    """Manda o último boletim publicado no site, avisando que é um teste."""
    saida = base.ler_json(base.PASTA_SITE / "dados" / f"{slug}.json")
    if not saida:
        print(f"[erro] {slug}: nenhum boletim publicado ainda")
        return False
    texto = f"Mensagem de teste: o canal de alertas está funcionando.\n\n{mensagem(saida, None, teste=True)}"
    ok = enviar(saida, texto)
    print(f"[{'ok' if ok else 'erro'}] {slug}: teste {'enviado' if ok else 'não enviado'}")
    return ok


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Alertas no Telegram")
    parser.add_argument("--cidade", required=True)
    parser.add_argument("--teste", action="store_true", help="manda o boletim atual como mensagem de teste")
    args = parser.parse_args(argv)
    if not args.teste:
        parser.error("use --teste (os alertas de verdade saem sozinhos na coleta)")
    return 0 if teste(args.cidade) else 1


if __name__ == "__main__":
    sys.exit(main())
