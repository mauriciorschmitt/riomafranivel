import datetime as dt
import re
import json

from coletor import ana, base, demo, estatistica, modelo as mod
from coletor.processar import processar, status_para

XML_TELEMETRIA = """<?xml version="1.0" encoding="utf-8"?>
<DataTable xmlns="http://MRCS/">
  <diffgr:diffgram xmlns:diffgr="urn:schemas-microsoft-com:xml-diffgram-v1">
    <DocumentElement xmlns="">
      <DadosHidrometereologicos diffgr:id="1">
        <CodEstacao>65100001</CodEstacao>
        <DataHora>2026-09-26 09:45:00</DataHora>
        <Vazao />
        <Nivel>516.00</Nivel>
        <Chuva>0.00</Chuva>
      </DadosHidrometereologicos>
      <DadosHidrometereologicos diffgr:id="2">
        <CodEstacao>65100001</CodEstacao>
        <DataHora>2026-09-26 10:00:00</DataHora>
        <Vazao>231.95</Vazao>
        <Nivel>515,50</Nivel>
        <Chuva></Chuva>
      </DadosHidrometereologicos>
    </DocumentElement>
  </diffgr:diffgram>
</DataTable>"""

XML_SERIE = """<?xml version="1.0"?>
<DataTable><DocumentElement>
  <SerieHistorica><EstacaoCodigo>65100000</EstacaoCodigo><NivelConsistencia>1</NivelConsistencia>
    <DataHora>1983-07-01 00:00:00</DataHora><Maxima>1400</Maxima><Cota01>900</Cota01><Cota13>1400</Cota13></SerieHistorica>
  <SerieHistorica><EstacaoCodigo>65100000</EstacaoCodigo><NivelConsistencia>2</NivelConsistencia>
    <DataHora>1983-07-01 00:00:00</DataHora><Maxima>1457</Maxima><Cota01>910</Cota01><Cota13>1457</Cota13><Cota31>500</Cota31></SerieHistorica>
  <SerieHistorica><EstacaoCodigo>65100000</EstacaoCodigo><NivelConsistencia>2</NivelConsistencia>
    <DataHora>1983-02-01 00:00:00</DataHora><Cota30>999</Cota30></SerieHistorica>
</DocumentElement></DataTable>"""


def test_telemetria_converte_cm_e_virgula():
    leituras = ana.interpretar_telemetria(XML_TELEMETRIA)
    assert len(leituras) == 2
    assert leituras[0]["nivel_m"] == 5.16
    assert leituras[1]["nivel_m"] == 5.155
    assert leituras[1]["vazao_m3s"] == 231.95
    assert leituras[0]["vazao_m3s"] is None and leituras[1]["chuva_mm"] is None


def test_serie_historica_prefere_consistido_e_ignora_datas_invalidas():
    diario = ana.interpretar_serie_historica(XML_SERIE)
    assert diario[dt.date(1983, 7, 13)] == 14.57
    assert not any(d.month == 2 for d in diario)  # "30 de fevereiro" é descartado
    assert ana.maximas_anuais(diario, min_dias_por_ano=1) == {1983: 14.57}


def test_gumbel_bate_com_formula():
    maximas = [6.1, 7.4, 5.2, 9.9, 8.1, 6.6, 7.0, 12.3, 5.9, 6.8, 8.8, 7.7]
    p = estatistica.ajustar_gumbel(maximas)
    x100 = estatistica.cota_retorno(p, 100)
    assert abs(estatistica.chance_anual(p, x100) - 0.01) < 1e-9
    assert estatistica.cota_retorno(p, 2) < estatistica.cota_retorno(p, 10) < x100
    assert estatistica.ajustar_gumbel(maximas[:5]) is None


def _dados_demo():
    cfg = base.carregar_config("mafra-rionegro")
    agora = dt.datetime(2026, 9, 26, 10, 0)
    return cfg, agora, *demo.gerar_bruto(cfg, agora)


def test_modelo_calibra_e_faixas_crescem():
    cfg, agora, bruto, maximas, treino = _dados_demo()
    modelo = mod.treinar(treino["niveis"], treino["chuva"])
    assert modelo["tipo"] == "calibrado"
    assert modelo["rmse_horizonte"][0] < 0.6
    prev = mod.prever(modelo, agora.date(), 5.0, treino["niveis"], treino["chuva"], cota_inundacao=7.0)
    # a margem para cima nunca diminui (a de baixo pode encostar no nível mínimo já registrado)
    acima = [p["max"] - p["media"] for p in prev]
    assert len(prev) == 7 and all(b >= a - 0.011 for a, b in zip(acima, acima[1:]))
    assert all(p["min"] <= p["media"] <= p["max"] for p in prev)
    assert all(0 <= p["prob_inundacao"] <= 1 for p in prev)


def test_poucos_dados_usa_heuristico():
    niveis = {dt.date(2026, 1, 1) + dt.timedelta(days=i): 3.0 for i in range(30)}
    chuva = {d.isoformat(): 0.0 for d in niveis}
    modelo = mod.treinar(niveis, chuva)
    assert modelo["tipo"] == "heuristico" and "28 dias" in modelo["motivo"]
    prev = mod.prever(modelo, dt.date(2026, 1, 31), 3.0, niveis, chuva)
    assert prev[-1]["media"] <= 3.0  # sem chuva, o rio não sobe


def test_projecao_horaria_comeca_no_nivel_atual():
    diaria = [{"media": 4.0, "min": 3.8, "max": 4.5}, {"media": 3.5, "min": 3.2, "max": 4.4}]
    h = mod.projecao_horaria(dt.datetime(2026, 9, 26, 10), 5.0, -0.03, diaria)
    assert len(h) == 48
    assert abs(h[0]["media"] - 4.97) < 0.05
    assert h[23]["media"] == 4.0 and h[47]["media"] == 3.5


def test_status_por_faixa():
    cfg = base.carregar_config("mafra-rionegro")
    assert status_para(4.9, cfg)["id"] == "normal"
    assert status_para(5.0, cfg)["id"] == "atencao"
    assert status_para(7.5, cfg)["id"] == "emergencia"
    assert status_para(14.0, cfg)["id"] == "extremo"


def test_processar_ponta_a_ponta():
    cfg, agora, bruto, maximas, treino = _dados_demo()
    modelo = mod.treinar(treino["niveis"], treino["chuva"])
    saida = processar(cfg, bruto, modelo, maximas)
    json.dumps(saida)  # precisa ser serializável
    assert saida["atual"]["hora"] == "2026-09-26T10:00"
    assert len(saida["previsao_dias"]) == 8 and saida["previsao_dias"][0]["atual"]
    assert len(saida["previsao_horaria"]) == 48
    assert len(saida["serie_horaria"]) >= 700
    assert saida["extremos"]["n_anos"] >= 10
    assert {"chuva_7d", "solo", "glofas"} <= set(saida["fatores"])


def test_offset_da_estacao():
    cfg, agora, bruto, maximas, treino = _dados_demo()
    cfg = {**cfg, "estacao": {**cfg["estacao"], "offset_m": 0.5}}
    saida = processar(cfg, bruto, mod.modelo_heuristico({}), maximas)
    bruto_nivel = [l for l in bruto["telemetria"] if l["nivel_m"] is not None][-1]["nivel_m"]
    assert abs(saida["atual"]["nivel"] - (bruto_nivel + 0.5)) < 0.01


def test_limpeza_remove_codigo_de_erro_e_pico_isolado():
    t0 = dt.datetime(2025, 1, 22, 12)
    niveis = [1.28, 1.28, 1.29, 7777.777, 1.30, 1.31, 3.9, 1.32, 1.33, 1.34]
    leituras = [{"hora": t0 + dt.timedelta(hours=i), "nivel_m": n, "chuva_mm": 0, "vazao_m3s": None} for i, n in enumerate(niveis)]
    limpas = base.limpar_leituras(leituras)
    assert [l["nivel_m"] for l in limpas] == [1.28, 1.28, 1.29, 1.30, 1.31, 1.32, 1.33, 1.34]
    # subida real (várias leituras seguidas) não é removida
    subida = [{"hora": t0 + dt.timedelta(hours=i), "nivel_m": 1.0 + 0.6 * i, "chuva_mm": 0, "vazao_m3s": None} for i in range(8)]
    assert len(base.limpar_leituras(subida)) == 8


def test_faixa_empirica_assimetrica():
    cfg, agora, bruto, maximas, treino = _dados_demo()
    modelo = mod.treinar(treino["niveis"], treino["chuva"])
    # simula um modelo que sempre subestima subidas: erros negativos grandes
    modelo["erros_validacao"] = [[[c, -abs(e) * 3] for c, e in p] for p in modelo["erros_validacao"]]
    prev = mod.prever(modelo, agora.date(), 5.0, treino["niveis"], treino["chuva"], cota_inundacao=7.0)
    for p in prev:
        assert p["max"] - p["media"] >= p["media"] - p["min"]


# ------------------------------------------------------------------ COPEL
from pathlib import Path

from coletor import copel

DADOS_TESTE = Path(__file__).parent / "dados"


class _Resposta:
    def __init__(self, texto):
        self.text = texto

    def raise_for_status(self):
        pass


class _SessaoFalsa:
    """Imita o servidor da COPEL com a página e as respostas reais gravadas."""

    def __init__(self):
        self.headers = {}
        self.posts = []

    def get(self, url, **kw):
        return _Resposta((DADOS_TESTE / "copel_pagina.html").read_text(encoding="utf-8"))

    def post(self, url, data=None, **kw):
        self.posts.append(data)
        origem = data["javax.faces.source"]
        if origem.endswith(":janela"):
            arquivo = "copel_fragosos.xml" if origem.startswith("j_idt164:9:") else "copel_rionegro.xml"
            return _Resposta((DADOS_TESTE / arquivo).read_text(encoding="utf-8"))
        if "dataInicialPonto_input" in " ".join(data):
            # resposta do botão "Atualizar": a mesma tabela
            arquivo = "copel_fragosos.xml" if origem.startswith("j_idt164:9:") else "copel_rionegro.xml"
            return _Resposta((DADOS_TESTE / arquivo).read_text(encoding="utf-8"))
        return _Resposta("<partial-response><changes></changes></partial-response>")


def test_copel_acha_estacoes_na_pagina():
    pagina = (DADOS_TESTE / "copel_pagina.html").read_text(encoding="utf-8")
    est = copel.mapear_estacoes(pagina)
    assert {"fragosos", "rio negro", "sao bento", "uniao da vitoria"} <= set(est)
    assert est["fragosos"]["form"] == "j_idt164:9:formDialog"
    assert est["fragosos"]["link"].startswith("form:")


def test_copel_coleta_fragosos_como_o_navegador():
    sessao = _SessaoFalsa()
    cliente = copel.Cliente(sessao)
    leituras = cliente.recentes("Fragosos")
    assert len(leituras) == 73
    ultima = leituras[-1]
    assert ultima["hora"] == dt.datetime(2026, 9, 26, 16)
    assert ultima["nivel_m"] == 2.968 and ultima["vazao_m3s"] == 48.6 and ultima["chuva_mm"] == 0.0
    # 1º pedido: clique na lista; 2º: carga do diálogo
    assert sessao.posts[0]["javax.faces.source"].startswith("form:")
    assert sessao.posts[1]["j_idt164:9:formDialog:janela_contentLoad"] == "true"
    assert all(p["javax.faces.ViewState"] == "6588907434319500852:2981915742836487924" for p in sessao.posts)


def test_copel_consulta_por_datas_usa_formato_da_pagina():
    sessao = _SessaoFalsa()
    cliente = copel.Cliente(sessao)
    leituras = cliente.leituras("rio negro", dt.datetime(2026, 9, 25, 0), dt.datetime(2026, 9, 26, 16))
    consulta = sessao.posts[-1]
    assert consulta["javax.faces.source"] == "j_idt164:21:formDialog:j_idt173"
    assert consulta["j_idt164:21:formDialog:dataInicialPonto_input"] == "25/09/2026 00"
    assert leituras[-1]["nivel_m"] == 5.008 and leituras[0]["hora"] == dt.datetime(2026, 9, 25, 0)


def test_copel_estacao_inexistente_lista_as_disponiveis():
    cliente = copel.Cliente(_SessaoFalsa())
    try:
        cliente.recentes("Estação Que Não Existe")
    except RuntimeError as erro:
        assert "Fragosos" in str(erro)
    else:
        raise AssertionError("deveria falhar")


class _SessaoSemDados(_SessaoFalsa):
    """Servidor que abre a estação mas devolve a tabela vazia, com uma mensagem."""

    def post(self, url, data=None, **kw):
        self.posts.append(data)
        if data["javax.faces.source"].endswith(":janela"):
            texto = (DADOS_TESTE / "copel_fragosos.xml").read_text(encoding="utf-8")
            return _Resposta(re.sub(r'<tr[^>]*data-ri="\d+".*?</tr>', "", texto, flags=re.S))
        return _Resposta(
            '<partial-response><changes><update id="j_idt164:9:formDialog:mensagem"><![CDATA['
            '<div class="ui-messages-error">Período máximo de consulta: 3 dias</div>]]></update></changes></partial-response>'
        )


def test_copel_tabela_vazia_vira_erro_com_a_mensagem_do_site():
    cliente = copel.Cliente(_SessaoSemDados())
    try:
        cliente.recentes("Fragosos")
    except RuntimeError as erro:
        assert "Período máximo de consulta: 3 dias" in str(erro)
    else:
        raise AssertionError("tabela vazia não pode passar em silêncio")


def test_copel_nunca_pede_datas_no_futuro():
    sessao = _SessaoFalsa()
    cliente = copel.Cliente(sessao)
    futuro = copel.agora_brasilia() + dt.timedelta(hours=6)
    cliente.leituras("Fragosos", futuro - dt.timedelta(days=2), futuro)
    pedido_fim = sessao.posts[-1]["j_idt164:9:formDialog:dataFinalPonto_input"]
    assert dt.datetime.strptime(pedido_fim, "%d/%m/%Y %H") <= copel.agora_brasilia()
