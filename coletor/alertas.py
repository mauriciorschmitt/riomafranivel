"""Aviso no Telegram quando o rio muda de faixa (sobe ou desce).

Configuração (opcional):
  * Crie um bot com o @BotFather e um canal público; adicione o bot como admin.
  * No GitHub: Settings > Secrets > Actions > TELEGRAM_TOKEN.
  * Na configuração da cidade: "alertas": {"telegram_canal": "@nome_do_canal"}.
Sem token ou sem canal, nada é enviado e o resto funciona normalmente.
"""
from __future__ import annotations

import os

import requests

from . import base


def _formatar(n: float) -> str:
    return f"{n:.2f}".replace(".", ",")


def mensagem(saida: dict, anterior: dict | None) -> str:
    cfg, atual = saida["config"], saida["atual"]
    subiu = anterior is None or atual["nivel"] >= anterior.get("nivel", 0)
    seta = "subiu para" if subiu else "baixou para"
    linhas = [
        f"{cfg['rio']} em {cfg['local']}: {seta} {atual['status']['nome'].upper()}",
        f"Nível: {_formatar(atual['nivel'])} m às {atual['hora'][11:16]}",
    ]
    if atual.get("tendencia_cm_h") is not None:
        linhas.append(f"Tendência: {atual['tendencia_cm_h']:+.1f} cm/h".replace(".", ","))
    amanha = saida["previsao_dias"][1]
    linhas.append(f"Previsão para amanhã: {_formatar(amanha['min'])} a {_formatar(amanha['max'])} m")
    if cfg.get("url_site"):
        linhas.append(cfg["url_site"])
    linhas.append("Emergência: Defesa Civil 199")
    return "\n".join(linhas)


def verificar(slug: str, saida: dict) -> bool:
    caminho = base.pasta(slug) / "alerta.json"
    anterior = base.ler_json(caminho)
    atual = saida["atual"]
    base.salvar_json(caminho, {"status": atual["status"]["id"], "nivel": atual["nivel"], "hora": atual["hora"]})
    if saida.get("demo") or (anterior and anterior.get("status") == atual["status"]["id"]):
        return False
    if anterior is None:
        return False  # primeira execução: só registra o estado

    token = os.environ.get("TELEGRAM_TOKEN")
    canal = (saida["config"].get("alertas") or {}).get("telegram_canal")
    if not token or not canal:
        return False
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": canal, "text": mensagem(saida, anterior)},
            timeout=20,
        ).raise_for_status()
        return True
    except requests.RequestException as erro:
        print(f"     aviso: Telegram falhou ({erro})")
        return False
