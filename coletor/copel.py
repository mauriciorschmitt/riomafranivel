"""Leituras das estações da COPEL (Monitoramento Hidrológico, bacia do Iguaçu).

A página https://www.copel.com/mhbweb/paginas/bacia-iguacu.jsf é feita em JSF
(PrimeFaces) e não tem API. Cada estação tem um formulário próprio na página;
o botão "Atualizar" desse formulário pede a tabela de medições por AJAX.

Passos de cada coleta:
  1. GET da página: traz a sessão (cookie) e o ViewState do JSF.
  2. Acha o formulário da estação pelo título ("Fragosos", "Rio Negro"...).
     Os identificadores (j_idt164:9 etc.) são gerados pelo servidor e mudam
     quando a COPEL altera a página, então nada disso fica fixo no código.
  3. POST imitando o clique em "Atualizar", com as datas desejadas.
  4. Lê as linhas da tabela devolvida.

Os dados são horários, em hora de Brasília (GMT-03:00), com leitura da régua
(m), vazão (m³/s) e chuva (mm). A COPEL avisa que não são dados consistidos.
"""
from __future__ import annotations

import datetime as dt
import html
import os
import re
import time
import unicodedata
from zoneinfo import ZoneInfo

import requests

URL = "https://www.copel.com/mhbweb/paginas/bacia-iguacu.jsf"
TIMEOUT = 60
AGENTE = "Mozilla/5.0 (compatible; monitor-cheias-sc; +https://github.com)"
FUSO = ZoneInfo("America/Sao_Paulo")
JANELA_MAXIMA_DIAS = 3  # a página mostra 72 h por padrão; períodos maiores podem ser recusados


def agora_brasilia() -> dt.datetime:
    """Hora de Brasília, sem fuso (o servidor do GitHub roda em UTC)."""
    return dt.datetime.now(FUSO).replace(tzinfo=None, minute=0, second=0, microsecond=0)


def mensagem_do_site(texto: str) -> str:
    """Texto das mensagens que o site devolve junto com a tabela (erros de data etc.)."""
    blocos = re.findall(r'<update id="[^"]*(?:mensagem|messages)[^"]*"><!\[CDATA\[(.*?)\]\]>', texto, re.S)
    limpo = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", b)) for b in blocos)
    return re.sub(r"\s+", " ", limpo).strip()


def normalizar(texto: str) -> str:
    texto = unicodedata.normalize("NFD", html.unescape(texto or "")).encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", texto).strip().lower()


def _numero(texto: str) -> float | None:
    texto = html.unescape(re.sub(r"<[^>]+>", "", texto or "")).strip()
    if not texto or texto.lower().startswith("s/l"):
        return None
    texto = texto.replace(".", "").replace(",", ".")
    try:
        return float(texto)
    except ValueError:
        return None


def viewstate(texto: str) -> str | None:
    """ViewState da página inteira ou de uma resposta parcial do AJAX."""
    m = re.search(r'name="javax\.faces\.ViewState"[^>]*value="([^"]+)"', texto)
    if m:
        return html.unescape(m.group(1))
    m = re.search(r'<update id="[^"]*javax\.faces\.ViewState[^"]*"><!\[CDATA\[(.*?)\]\]>', texto, re.S)
    return m.group(1) if m else None


def mapear_estacoes(pagina: str) -> dict[str, dict]:
    """Acha cada estação pelo título do seu diálogo na página.

    Devolve {nome_normalizado: {"nome", "form", "janela", "link"}}. O conteúdo do
    diálogo (datas, botão, tabela) só existe depois que a estação é aberta.
    """
    estacoes = {}
    for m in re.finditer(r'id="([^"]+:formDialog):janela_title"[^>]*>([^<]+)<', pagina):
        form, titulo = m.group(1), html.unescape(m.group(2)).strip()
        nome = titulo.split(" - ")[0].strip()
        link = None
        for candidato in {nome, html.escape(nome, quote=False)}:
            achado = re.search(r'<a id="(form:[^"]+)"[^>]*>\s*' + re.escape(candidato) + r'\s*</a>', pagina)
            if achado:
                link = achado.group(1)
                break
        estacoes[normalizar(nome)] = {"nome": nome, "form": form, "janela": f"{form}:janela", "link": link}
    return estacoes


def mapear_formulario(texto: str, form: str) -> dict | None:
    """Campos de data e botão "Atualizar" de um diálogo já carregado."""
    js = html.unescape(texto)
    botao = re.search(r'PrimeFaces\.ab\(\{s:"(' + re.escape(form) + r':[^"]+)",f:"' + re.escape(form) + r'"[^}]*u:"[^"]*:tabela', js)
    inicio = re.search(r'name="(' + re.escape(form) + r':[^"]*dataInicial[^"]*_input)"', texto)
    final = re.search(r'name="(' + re.escape(form) + r':[^"]*dataFinal[^"]*_input)"', texto)
    if not (botao and inicio and final):
        return None
    extras = dict(re.findall(r'name="(' + re.escape(form) + r':tabela[^"]*(?:scrollState|activeIndex))"[^>]*value="([^"]*)"', texto))
    return {"botao": botao.group(1), "inicio": inicio.group(1), "fim": final.group(1), "extras": extras}


def interpretar_tabela(texto: str) -> list[dict]:
    """Lê as linhas da tabela (página inteira ou resposta parcial do AJAX).

    Colunas: Data/hora | Leitura da régua (m) | Vazão (m³/s) | Precipitação (mm) | Acumulada.
    """
    leituras = {}
    for linha in re.findall(r'<tr[^>]*data-ri="\d+"[^>]*>(.*?)</tr>', texto, re.S):
        celulas = re.findall(r"<td[^>]*>(.*?)</td>", linha, re.S)
        if len(celulas) < 2:
            continue
        rotulo = html.unescape(re.sub(r"<[^>]+>", "", celulas[0])).strip()
        m = re.match(r"(\d{2})/(\d{2})/(\d{2,4})\s+(\d{1,2})h", rotulo)
        if not m:
            continue
        dia, mes, ano, hora = (int(x) for x in m.groups())
        ano += 2000 if ano < 100 else 0
        quando = dt.datetime(ano, mes, dia, hora)
        leituras[quando] = {
            "hora": quando,
            "nivel_m": _numero(celulas[1]),
            "vazao_m3s": _numero(celulas[2]) if len(celulas) > 2 else None,
            "chuva_mm": _numero(celulas[3]) if len(celulas) > 3 else None,
        }
    return [leituras[h] for h in sorted(leituras)]


class Cliente:
    """Uma sessão na página da COPEL. Crie uma por execução do coletor."""

    def __init__(self, sessao: requests.Session | None = None):
        self.sessao = sessao or requests.Session()
        self.sessao.headers.update({"User-Agent": AGENTE, "Accept-Language": "pt-BR,pt;q=0.9"})
        self.pagina = None
        self.estado = None
        self.estacoes = {}
        self.depurar = bool(os.environ.get("COPEL_DEPURAR"))
        self.ultima_mensagem = ""

    def _abrir(self):
        if self.pagina is not None:
            return
        r = self._pedir("get", URL)
        self.pagina = r.text
        self.estado = viewstate(self.pagina)
        self.estacoes = mapear_estacoes(self.pagina)
        if self.depurar:
            print(f"[copel] GET {len(self.pagina)} bytes, ViewState={self.estado}, {len(self.estacoes)} estações")
        if not self.estado or not self.estacoes:
            raise RuntimeError("COPEL: não reconheci a página (ela pode ter mudado de formato).")

    def _pedir(self, metodo, url, tentativas=3, **kw):
        erro = None
        for tentativa in range(tentativas):
            try:
                r = getattr(self.sessao, metodo)(url, timeout=TIMEOUT, **kw)
                r.raise_for_status()
                return r
            except requests.RequestException as e:
                erro = e
                time.sleep(2 * (tentativa + 1))
        raise RuntimeError(f"COPEL indisponível: {erro}")

    def _ajax(self, dados: dict) -> str:
        cabecalhos = {
            "Faces-Request": "partial/ajax",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": URL,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        r = self._pedir("post", URL, data={**dados, "javax.faces.ViewState": self.estado}, headers=cabecalhos)
        if self.depurar:
            print(f"[copel] POST source={dados.get('javax.faces.source')} datas="
                  f"{[v for k, v in dados.items() if 'data' in k.lower()]} -> {len(r.text)} bytes, "
                  f"{len(interpretar_tabela(r.text))} linhas, mensagem='{mensagem_do_site(r.text)}'")
            print("[copel]   início da resposta:", re.sub(r"\s+", " ", r.text[:1200]))
        novo = viewstate(r.text)
        if novo:
            self.estado = novo
        return r.text

    def disponiveis(self) -> list[str]:
        self._abrir()
        return sorted(e["nome"] for e in self.estacoes.values())

    def _estacao(self, estacao: str) -> dict:
        self._abrir()
        e = self.estacoes.get(normalizar(estacao))
        if e is None:
            raise RuntimeError(f"COPEL: estação \"{estacao}\" não encontrada. Disponíveis: {', '.join(self.disponiveis())}")
        return e

    def _carregar(self, e: dict) -> str:
        """Abre a estação como a página faz: clique na lista e carga do diálogo."""
        if e.get("campos"):
            return ""
        if e["link"]:
            self._ajax({
                "javax.faces.partial.ajax": "true",
                "javax.faces.source": e["link"],
                "javax.faces.partial.execute": "@all",
                e["link"]: e["link"],
                "form": "form",
            })
        resposta = self._ajax({
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": e["janela"],
            "javax.faces.partial.execute": e["janela"],
            "javax.faces.partial.render": e["janela"],
            f"{e['janela']}_contentLoad": "true",
            e["form"]: e["form"],
        })
        e["campos"] = mapear_formulario(resposta, e["form"]) or mapear_formulario(self.pagina, e["form"])
        if not e["campos"]:
            raise RuntimeError(f"COPEL: não consegui abrir a estação \"{e['nome']}\" (a página pode ter mudado).")
        return resposta

    def recentes(self, estacao: str) -> list[dict]:
        """Últimas ~72 horas. Falha com a mensagem do site se não vier nenhuma leitura."""
        e = self._estacao(estacao)
        linhas = interpretar_tabela(self._carregar(e))
        if not linhas:
            agora = agora_brasilia()
            linhas = self.leituras(estacao, agora - dt.timedelta(hours=72), agora)
        if not linhas:
            detalhe = f" Mensagem do site: \"{self.ultima_mensagem}\"." if self.ultima_mensagem else " O site não mandou mensagem."
            raise RuntimeError(f"COPEL: {e['nome']} veio sem leituras.{detalhe}")
        return linhas

    def leituras(self, estacao: str, inicio: dt.datetime, fim: dt.datetime) -> list[dict]:
        """Leituras horárias de uma estação entre duas datas (hora de Brasília, nunca no futuro)."""
        e = self._estacao(estacao)
        self._carregar(e)
        c = e["campos"]
        fim = min(fim, agora_brasilia())
        resposta = self._ajax({
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": c["botao"],
            "javax.faces.partial.execute": e["form"],
            "javax.faces.partial.render": f"{e['form']}:tabela {e['form']}:mensagem",
            c["botao"]: c["botao"],
            e["form"]: e["form"],
            c["inicio"]: inicio.strftime("%d/%m/%Y %H"),
            c["fim"]: fim.strftime("%d/%m/%Y %H"),
            **c["extras"],
        })
        self.ultima_mensagem = mensagem_do_site(resposta)
        return [l for l in interpretar_tabela(resposta) if inicio <= l["hora"] <= fim]

    def historico(self, estacao: str, inicio: dt.datetime, fim: dt.datetime, janela_dias: int = JANELA_MAXIMA_DIAS) -> list[dict]:
        """Busca para trás em blocos de 3 dias até `inicio`, parando quando a COPEL não tiver mais dados."""
        todas, vazias, cursor = {}, 0, min(fim, agora_brasilia())
        while cursor > inicio and vazias < 3:
            comeco = max(inicio, cursor - dt.timedelta(days=janela_dias))
            bloco = self.leituras(estacao, comeco, cursor)
            if not bloco and not todas:
                # o bloco mais recente sempre deveria ter dados: é problema, não fim do histórico
                detalhe = f" Mensagem do site: \"{self.ultima_mensagem}\"." if self.ultima_mensagem else " O site não mandou mensagem."
                raise RuntimeError(f"COPEL: {estacao} veio sem leituras de {comeco:%d/%m %Hh} a {cursor:%d/%m %Hh}.{detalhe}")
            vazias = vazias + 1 if not bloco else 0
            todas.update({l["hora"]: l for l in bloco})
            cursor = comeco
            time.sleep(1)  # sem pressa: não sobrecarregar o servidor da COPEL
        return [todas[h] for h in sorted(todas)]


if __name__ == "__main__":
    # python -m coletor.copel             -> lista as estações
    # python -m coletor.copel Fragosos    -> últimas leituras de uma estação
    import sys

    cliente = Cliente()
    if len(sys.argv) < 2:
        print("Estações da COPEL (bacia do Iguaçu):")
        for nome in cliente.disponiveis():
            print(" ", nome)
    else:
        for l in cliente.recentes(" ".join(sys.argv[1:]))[-12:]:
            print(f"{l['hora']:%d/%m %Hh}  nível {l['nivel_m']} m  vazão {l['vazao_m3s']} m³/s  chuva {l['chuva_mm']} mm")
