# Monitor de Cheias SC

Painel público e gratuito de nível de rio, com previsão de 7 dias, régua de impactos da cidade, análise histórica de cheias e contatos de emergência. Funciona com dados públicos (ANA e Open-Meteo), roda de graça no GitHub e serve para qualquer cidade que tenha uma estação telemétrica da ANA.

Custo: zero. Não precisa de servidor, banco de dados, chave de API nem sensor próprio.

## Como funciona

```
 a cada 30 min (GitHub Actions)
 ┌──────────────────────────────────────────────────────────────┐
 │ ANA telemetria ──┐                                           │
 │ Open-Meteo ──────┼──> coletor (Python) ──> docs/dados/*.json │
 │ GloFAS ──────────┘        │                                  │
 │                           └──> dados/ (base persistente)     │
 └──────────────────────────────────────────────────────────────┘
 docs/ (HTML + JS estático) ──> GitHub Pages ──> moradores
 toda segunda: retreina o modelo de previsão com o histórico acumulado
```

| Fonte | O que traz | Acesso |
|---|---|---|
| ANA, telemetria (`DadosHidrometeorologicos`) | Nível a cada 15 min, chuva e vazão da estação | Público, sem cadastro |
| ANA, série histórica (`HidroSerieHistorica`) | Cotas diárias desde o início da estação, para a análise de extremos | Público, sem cadastro |
| Open-Meteo, previsão | Chuva, temperatura e umidade do solo, 8 dias, em vários pontos da bacia | Gratuito, sem chave |
| Open-Meteo, reanálise | Chuva diária histórica, para treinar o modelo | Gratuito, sem chave |
| GloFAS (via Open-Meteo) | Vazão prevista para 30 dias pelo sistema europeu | Gratuito, sem chave |
| COPEL, Monitoramento Hidrológico | Estações horárias da bacia do Iguaçu (inclui algumas que não estão na ANA) | Página pública, sem cadastro |

## A previsão

É uma regressão linear que aprende, com o histórico da própria estação, quanto o rio sobe ou desce de um dia para o outro em função de: nível atual, variação recente, chuva dos últimos dias e dos próximos, solo encharcado (índice de chuva antecedente) e, se houver, o nível de uma estação rio acima. O modelo roda dia a dia com a chuva prevista para montar os 7 dias.

A faixa de incerteza vem de um teste retroativo: o modelo é aplicado no período de validação e o erro de cada horizonte vira a largura da faixa (80% dos casos). Como o teste usa a chuva que de fato caiu, a faixa é alargada para cobrir o erro da previsão do tempo (`fator_incerteza` e `crescimento_incerteza_dia`).

Enquanto não houver ao menos 120 dias de nível e chuva, o sistema usa coeficientes genéricos e o painel avisa que a previsão não está calibrada. Na primeira execução, o treino pede até 2 anos de telemetria à ANA; se a estação tiver esse histórico disponível, a previsão já sai calibrada no primeiro dia. Se não tiver, a base local vai crescendo a cada coleta.

Limitações honestas: é um modelo estatístico simples, não hidrodinâmico. Erra mais em eventos maiores que os do período de treino, e a previsão de chuva é a maior fonte de erro depois do 2º ou 3º dia. O painel diz isso para o morador e reforça que a referência oficial é a Defesa Civil.

## Rodar no seu computador

```bash
pip install -r coletor/requirements.txt

# ver o painel com dados fictícios (não precisa de internet)
python -m coletor.demo --cidade mafra-rionegro
cd docs && python -m http.server 8000     # abra http://localhost:8000

# dados reais
python -m coletor.treinar --cidade mafra-rionegro --historico   # uma vez (baixa histórico e treina)
python -m coletor.gerar --cidade mafra-rionegro                 # a cada atualização

# testes
pip install pytest && python -m pytest -q tests
```

## Publicar de graça no GitHub

1. Crie um repositório público e envie esta pasta (ou faça um fork).
2. Em **Settings > Pages**, escolha "Deploy from a branch", branch `main`, pasta `/docs`.
3. Em **Settings > Actions > General**, em "Workflow permissions", marque "Read and write permissions".
4. Em **Actions**, rode manualmente "Treinar modelo" marcando "Baixar também a série histórica". Depois rode "Atualizar dados".
5. O site fica em `https://<seu-usuario>.github.io/<repositorio>/`. Coloque esse endereço em `url_site` e o do repositório em `repositorio` na configuração da cidade.

Dali em diante tudo roda sozinho: coleta a cada 30 minutos e retreino toda segunda. Observações: o agendamento do GitHub pode atrasar alguns minutos em horários de pico, e repositórios sem nenhuma atividade por 60 dias têm o agendamento pausado (os commits automáticos de dados contam como atividade).

## Adicionar uma cidade

1. Encontre a estação telemétrica da ANA:
   ```bash
   python ferramentas/buscar_estacoes.py blumenau
   ```
   Ou pelo mapa do HidroTelemetria: https://www.snirh.gov.br/hidrotelemetria/
2. Copie `config/cidades/_modelo.json` para `config/cidades/<nome-da-cidade>.json` e preencha.
3. Rode `python -m coletor.treinar --cidade <nome> --historico` e depois `python -m coletor.gerar --cidade <nome>`.

Cada arquivo em `config/cidades/` vira uma cidade no mesmo site, com um seletor no topo. Também dá para linkar direto: `?cidade=<nome>`.

### O que configurar

| Campo | Para que serve |
|---|---|
| `estacao.codigo` | Estação telemétrica da ANA (a que transmite a cada 15 min) |
| `estacao.codigo_convencional` | Estação convencional no mesmo local, com série histórica longa. Costuma ter o código terminado em 0 |
| `estacao.offset_m` | Diferença entre a régua da ANA e a régua usada pela Defesa Civil, se houver |
| `estacao.ajuste_fuso_horas` | Use `-3` se as horas da ANA estiverem vindo em UTC (compare com o HidroTelemetria) |
| `estacao.copel` | Nome da mesma estação no site da COPEL, usada como reserva quando a ANA atrasa (bacia do Iguaçu) |
| `montante` | Estação rio acima: `codigo` (ANA) ou `estacao_copel` (nome no site da COPEL). O treino mede sozinho quantos dias a cheia leva para chegar e só usa a estação se ela melhorar a previsão |
| `bacia.pontos` | Pontos onde a chuva é consultada. O primeiro é a cidade; espalhe os demais pela bacia, principalmente rio acima |
| `cotas.faixas` | Cotas de atenção, alerta, emergência etc. Use as cotas oficiais do município |
| `regua` | O que acontece na cidade em cada nível (ruas, pontes, bairros). É a parte mais útil para o morador: vale construir com a Defesa Civil |
| `pontes` | Altura em que cada ponte é coberta. O painel calcula sozinho quais pontes cada cheia histórica cobriu |
| `cheias_historicas` | Grandes cheias com data, cota e descrição |
| `maximas_anuais_extra` | Anos que faltam na série da ANA (por exemplo, cheias anteriores à estação) |
| `contatos` | Defesa Civil municipal e abrigos. Itens sem telefone ou sem nome não aparecem |

Os níveis de impacto, pontes e cheias de Rio Negro/Mafra no exemplo vieram de um painel de terceiros e **precisam ser conferidos com a Defesa Civil** antes de o site ir ao ar. Os contatos municipais estão em branco de propósito.

## Estações da COPEL

Na bacia do Iguaçu (que inclui o Rio Negro), a COPEL publica estações horárias em https://www.copel.com/mhbweb/paginas/bacia-iguacu.jsf. Algumas, como Fragosos, não aparecem na ANA. Para ver os nomes disponíveis: `python -m coletor.copel`; para as últimas leituras de uma: `python -m coletor.copel Fragosos`.

A página não tem API: o coletor imita os cliques (abrir a estação e pedir a tabela) e acha os campos pelo nome da estação, então pequenas mudanças no site não quebram a coleta. Se a COPEL mudar a página a fundo, o coletor avisa no log e o painel continua funcionando com a ANA. Os dados de uma estação nova de rio acima entram no modelo depois de 90 dias acumulados junto com a estação principal.

## Alertas no Telegram (opcional)

1. Crie um bot com o @BotFather e guarde o token.
2. Crie um canal público e adicione o bot como administrador.
3. No GitHub, em **Settings > Secrets and variables > Actions**, crie `TELEGRAM_TOKEN`.
4. Na configuração da cidade, preencha `"alertas": {"telegram_canal": "@seu_canal"}`.

O bot avisa quando o rio muda de faixa (subindo ou descendo), e o botão "Receber alertas" aparece no painel.

## Estrutura

```
coletor/        Python: coleta, processamento, modelo, estatística, alertas
  gerar.py      executa a coleta e publica o JSON
  treinar.py    completa o histórico e treina o modelo
  demo.py       dados fictícios para testar o painel
config/cidades/ uma configuração por cidade
dados/          base persistente (telemetria, chuva, modelo, máximas anuais)
docs/           o site (HTML, CSS, JS) e os JSON publicados
ferramentas/    busca de estações e gerador de HTML único
tests/          testes automatizados
```

## Próximos passos possíveis

- Sensor próprio (ESP32 + sensor ultrassônico ou radar) enviando para o mesmo formato de `dados/<cidade>/telemetria.csv`.
- Mapa de manchas de inundação por cota, se a prefeitura tiver o levantamento.
- Notificação por WhatsApp (exige serviço pago ou a API oficial da Meta).

## Licença

MIT. Use, copie e adapte à vontade, inclusive em outras cidades e estados.
