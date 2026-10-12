# Como o repo-miner funciona

Este guia é para quem nunca viu o projeto: pesquisadores que vão usar os dados, revisores que precisam confiar neles e desenvolvedores que vão mantê-lo. Ele acompanha uma mineração do começo ao fim e explica, em cada etapa, o que acontece e o que é feito com os dados.

## Em uma frase

Você descreve num catálogo **o que buscar e por quê**. O repo-miner transforma isso em buscas no GitHub, recupera todos os resultados, junta as repetições sem perder de onde cada uma veio e, se houver um protocolo de elegibilidade, coleta só os fatos que as regras pedem e avalia cada candidato. No fim, entrega planilhas e um relatório que dizem exatamente o que foi encontrado e com que cobertura.

```text
 pergunta de pesquisa
        │
        ▼
 ┌──────────────┐   dry-run    ┌────────────────────────┐
 │  catálogo    │ ───────────▶ │ totais por subconsulta │──▶ ajustar partições
 │  (JSON)      │              └────────────────────────┘
 └──────┬───────┘
        │ discover
        ▼
 ┌──────────────┐  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐
 │  expansão em │─▶│ busca e     │─▶│ gravação e   │─▶│ elegibilidade │─▶│ exportação   │
 │ subconsultas │  │ paginação   │  │ deduplicação │  │ (opcional)    │  │              │
 └──────────────┘  └─────────────┘  └──────────────┘  └───────────────┘  └──────┬───────┘
                                                                               ▼
                                     candidates.csv · discovery-hits.csv · coverage.json
                                     report.md · manifest.json · discovery.sqlite
                                               │
                                               ▼
                                  sample (sorteio) → clone (git)
                                               │
                                               ▼
                                       triagem humana
```

O diagrama mostra o caminho dos dados. Na execução, a busca e a coleta de fatos da elegibilidade podem se sobrepor, conforme as etapas 3 e 5.

## Vocabulário

| Termo | O que significa aqui |
| --- | --- |
| **Catálogo** | Arquivo JSON com as consultas de um estudo e a justificativa de cada uma. |
| **Consulta** | Uma busca declarada no catálogo, como `"single-spa" in:name,description,readme`. |
| **Estratégia** | Um rótulo livre, escolhido pelo estudo, para o procedimento de descoberta a que a consulta pertence (por exemplo `package-manifest`). Os relatórios contam e cruzam os rótulos presentes no catálogo. |
| **Subconsulta** | Um pedaço de uma consulta, gerado pela ferramenta, por exemplo restrito aos repositórios criados num trimestre. É a unidade que realmente vai ao GitHub. |
| **Partição** | A regra que divide uma consulta em subconsultas: por data de criação (repositórios) ou por tamanho de arquivo (código). |
| **Hit** | Uma ocorrência: o repositório X apareceu na subconsulta Y, no arquivo Z. |
| **Candidato** | Um repositório distinto, identificado pelo id numérico do GitHub. Vários hits podem apontar para o mesmo candidato. |
| **Rodada** | Uma execução completa de um catálogo, gravada num diretório próprio. |
| **Checkpoint** | A marca de até onde cada subconsulta foi buscada; permite retomar sem repetir trabalho. |
| **Saturação** | Quando uma subconsulta tem mais de 1.000 resultados, o máximo que o GitHub entrega. |
| **Protocolo** | Arquivo opcional com regras de elegibilidade (`last_push`, `recent_commit`). Sem regras, todo candidato fica `not_applied`. |
| **Fato** | Um dado coletado porque uma regra o pede: metadados do repositório ou o histórico de commits. |
| **Elegibilidade** | O resultado da avaliação de um candidato: `pass`, `fail`, `unknown` ou `not_applied`. |
| **Proveniência** | O registro de como, quando e por qual consulta um dado foi obtido. |

## A jornada passo a passo

### Etapa 0 — Da pergunta ao catálogo

Tudo começa com uma pergunta de pesquisa, por exemplo "como micro-frontends aparecem em repositórios?". O catálogo traduz a pergunta em buscas e as agrupa em estratégias, para não depender de um único vocabulário. No estudo de micro-frontends, as estratégias escolhidas são: repositórios que **dizem** ser do tema (`terminology`), que **usam** tecnologias do tema (`technology`) e que descrevem o tema com **outras palavras** (`broader`). Esses rótulos são uma escolha do estudo; outro estudo declara os seus.

Cada consulta tem uma justificativa (`rationale`) escrita por quem a criou. Isso deixa o catálogo auditável: um revisor consegue saber por que cada busca existe.

Algumas lições práticas, aprendidas no caso de uso de micro-frontends:

- Termos com hífen vão entre aspas. Sem aspas, `single-spa` vira "single" OU "spa" e traz centenas de milhares de resultados irrelevantes.
- Tópicos (`topic:nome`) são os metadados mais precisos e costumam ter poucos resultados.
- Para encontrar quem usa uma tecnologia, busque artefatos, como `filename:package.json` ou arquivos de configuração, em vez de prosa.

Os qualificadores `pushed:`, `created:` e `size:` não podem ser escritos à mão: a ferramenta os gera a partir das regras `last_push` do protocolo e das partições.

### Etapa 1 — Pré-visualizar o volume (dry-run)

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --dry-run > dry-run.md
```

O dry-run faz a expansão (etapa 2) e pergunta ao GitHub apenas **quantos** resultados cada subconsulta tem, pedindo um único item por subconsulta. Ele imprime uma tabela com a consulta, a subconsulta, o texto efetivamente enviado, o total e uma marca nas subconsultas acima de 1.000. Com `--protocol`, o texto enviado inclui o recorte `pushed:` das regras `last_push`.

Nenhum arquivo é criado. Se alguma subconsulta saturar, o comando retorna `2`, e o ajuste é feito no catálogo: um intervalo menor (de trimestre para mês, por exemplo) ou mais faixas de tamanho. Repete-se o dry-run até tudo caber, ou até que a saturação restante seja uma decisão consciente e registrada.

### Etapa 2 — Iniciar a rodada e expandir o catálogo

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --protocol config/protocols/micro-frontends.json --output data/discovery/mfe-rodada-001
```

Ao iniciar, a ferramenta:

1. **Valida o catálogo e o protocolo.** Identificadores únicos, rótulos de estratégia válidos, endpoints conhecidos, justificativas presentes, partições compatíveis com o endpoint. Qualquer erro interrompe tudo antes de qualquer busca.
2. **Calcula o hash do catálogo e do protocolo** (SHA-256 de uma forma canônica do JSON). Os hashes identificam exatamente o que foi buscado e avaliado e impedem que uma retomada use uma configuração diferente.
3. **Expande cada consulta em subconsultas.** Se o protocolo tem regras `last_push`, as consultas de repositórios recebem `pushed:>=<data>`, com a data mais recente entre essas regras; as de código nunca recebem esse filtro, e sem regra `last_push` nenhuma o recebe. Se houver partição por data de criação, gera um balde inicial (`created:<início>`), um intervalo por período e um intervalo final aberto até hoje. Se houver partição por tamanho, gera uma faixa para cada intervalo de `bounds`. A data de criação da rodada fixa o último intervalo, então a expansão é sempre a mesma para o mesmo catálogo, o mesmo protocolo e a mesma data.
4. **Grava tudo em `discovery.sqlite`**: o catálogo, o protocolo, os hashes, a data de expansão e a lista de subconsultas, cada uma com um checkpoint "pendente".

### Etapa 3 — Buscar e paginar

Os endpoints de busca de repositórios e de código executam em paralelo. Dentro de cada endpoint, as subconsultas seguem a ordem do catálogo, uma de cada vez, e suas páginas também são sequenciais. Para cada subconsulta, a ferramenta pede páginas de 100 resultados ao GitHub, até no máximo 10 páginas (1.000 resultados, o limite da API). Quando o protocolo tem regras, a coleta dos fatos que elas pedem acontece durante as buscas e ao final (etapa 5).

Para não ser bloqueada, ela respeita intervalos mínimos entre pedidos: 2 segundos na busca de repositórios, 6 segundos na busca de código e 1 segundo no GraphQL. Falhas de rede e erros do servidor são tentados de novo até três vezes, com espera crescente. Quando o GitHub avisa que o limite de uso foi atingido, a ferramenta espera o tempo indicado por ele (ou um minuto, se ele não indicar) antes de tentar outra vez.

Cada subconsulta termina num destes estados:

| Estado | Quando acontece | O que significa |
| --- | --- | --- |
| `complete` | Todas as páginas foram obtidas. | Cobertura integral daquela subconsulta. |
| `partial` | Mais de 1.000 resultados, ou o GitHub marcou os resultados como incompletos. | Cobertura parcial, registrada com o motivo; não é refeita nesta rodada. |
| `failed` | Um erro persistiu após as tentativas. | Será retomada a partir da página em que parou. |

### Etapa 4 — Gravar e deduplicar

Cada página recebida é gravada junto com seu checkpoint numa única transação: ou os dois ficam salvos, ou nenhum fica. Assim, uma queda no meio nunca deixa dados pela metade.

Nessa gravação, os dados são organizados em dois níveis:

- **Candidatos**: um registro por repositório, identificado pelo id numérico do GitHub, que não muda mesmo se o repositório for renomeado. Os metadados guardados são os do primeiro encontro.
- **Hits**: um registro por ocorrência (subconsulta, repositório e caminho do arquivo). Se o mesmo repositório aparece em cinco subconsultas, ele é **um** candidato com **cinco** hits.

É isso que permite responder "este repositório foi encontrado pela terminologia, pela tecnologia ou pelas duas?" sem contar ninguém duas vezes. A página bruta também é guardada, com os caminhos de arquivo normalizados, como fotografia do que o GitHub devolveu naquele momento.

Para análise e exportação, uma projeção seleciona um único hit REST de busca de repositórios, sem regravar os metadados originais do candidato. Ela prefere observações com `pushed_at` válido (string não vazia que representa uma data finita); entre observações com a mesma validade, escolhe a menor data de coleta (`fetched_at`), desempata por `subquery_id` e depois por `path`. Nome, URL e todos os metadados vêm dessa mesma observação. Sem hit REST, usa o primeiro encontro. Assim, um hit de código que chega primeiro não impede o uso posterior de metadados REST completos.

`first_seen_at` continua sendo a data do primeiro encontro. Cada observação de metadados guarda a data em que foi feita, e é ela que as regras de elegibilidade citam como evidência.

### Etapa 5 — Coletar os fatos que as regras pedem

A busca de repositórios já devolve a data do último push, a linguagem, o tamanho e se o repositório é fork ou está arquivado. A busca de código não devolve: ela informa só o arquivo e um resumo do repositório.

Sem protocolo, ou com protocolo sem regras, **nada é coletado além da busca**: todo candidato fica `not_applied`, e candidatos encontrados só pela busca de código continuam sem esses metadados.

Com regras, a coleta é dirigida por elas:

- `last_push` precisa do push do repositório. Se o candidato não tem um push válido vindo da busca, a ferramenta pede os metadados pela API GraphQL, em lotes de até 100 repositórios: lotes completos enquanto as buscas continuam e os restantes ao final. Os metadados coletados incluem a data do último push, a branch padrão e seu commit, e ficam à parte, sem sobrescrever os da busca.
- `recent_commit` precisa do histórico de commits. Antes de coletá-lo, a ferramenta obtém os metadados do candidato; depois lista as branches e pagina os commits dentro dos orçamentos de `--activity-*`.

Cada candidato é reavaliado a cada fato novo. Se uma regra já reprova o candidato, os fatos pedidos só pelas regras seguintes não são coletados.

| Resultado de uma coleta | Significado |
| --- | --- |
| `complete` | Fatos obtidos. |
| `limited` | O orçamento de requisições ou de duração se esgotou. A regra fica `unknown`. |
| `failed` | Falha. A tarefa é retomada com `discover --resume`. |

Um campo legitimamente nulo, inclusive `pushedAt`, não é uma falha. Numa resposta parcial do GraphQL, um erro em um campo ou nó afeta apenas o candidato associado; erros sem caminho que identifique confiavelmente um alvo afetam o lote inteiro. Os motivos armazenados ocultam o token.

### Etapa 6 — Avaliar a elegibilidade

Cada candidato recebe uma avaliação por regra e uma agregada:

| Agregada | Quando |
| --- | --- |
| `fail` | Alguma regra falha. |
| `unknown` | Nenhuma falha, e alguma regra está indeterminada (dados ausentes, coleta incompleta, orçamento esgotado ou autoria indeterminada). Nunca vira `fail` por falta de dados. |
| `pass` | Todas as regras passam. |
| `not_applied` | O protocolo não tem regras. |

**Regra `last_push`.** Compara o último push do repositório com a data configurada. O push dos metadados coletados tem precedência sobre o da busca. A data comparada é a do push ao GitHub, não a data dos commits: commits criados em março de 2025 e enviados em abril contam como atividade em abril, e um push em qualquer branch atualiza a data. "Até hoje" quer dizer até a coleta.

**Regra `recent_commit`.** Procura ao menos um commit com `committedDate` desde a data configurada (meia-noite UTC inclusiva) até o instante de inspeção gravado para o candidato, nas branches pedidas e, com `authors: "human"`, de autor humano. O autor do commit, e não o committer, determina a autoria.

Estar ativo não significa que o fenômeno estudado foi implementado recentemente, e a elegibilidade não confirma pertencimento ao fenômeno.

Candidatos que não passam **não são apagados**: continuam nas exportações, apenas marcados. Retirar alguém da análise é uma decisão que precisa estar visível.

### Etapa 7 — Exportar e ler os resultados

Ao final, e também quando a rodada é interrompida, a ferramenta lê o banco e gera os arquivos abaixo. `report` regenera os mesmos arquivos a qualquer momento, sem token.

Todas as leituras de uma exportação usam a mesma fotografia do SQLite: CSV, cobertura, catálogo, resumo da coleta e estado da rodada refletem um único instante. O CSV é escrito por streaming. Durante a coleta, outra conexão pode confirmar páginas sem bloquear esse cursor; essas páginas aparecem na exportação seguinte. Uma falha de escrita encerra o cursor e libera a transação de leitura, permitindo tentar exportar novamente.

O banco em arquivo usa WAL e pode manter `discovery.sqlite-wal` e `discovery.sqlite-shm` enquanto estiver aberto. Eles são arquivos auxiliares do SQLite. Por diretório, mantenha no máximo um writer de descoberta e um exporter ativo. `report` durante a coleta é suportado; duas exportações simultâneas para os mesmos arquivos, inclusive `report` sobreposto à exportação final de `discover`, ficam fora desse limite.

| Arquivo | Para que serve | Como ler |
| --- | --- | --- |
| `candidates.csv` | Lista de trabalho para a triagem. | Uma linha por repositório. A coluna `strategies` mostra quais procedimentos o encontraram (`terminology;technology`, por exemplo). Com regras de elegibilidade, filtre por `eligibility_status = pass`; `eligibility_results_json` e `evidence_json` trazem o resultado de cada regra e as evidências usadas. |
| `discovery-hits.csv` | Proveniência completa. | Uma linha por ocorrência, com consulta, subconsulta, texto exato enviado (`q_effective`), data de coleta e caminho do arquivo. Responde "por que este repositório está na lista?". |
| `coverage.json` | Números para análise. | Totais, contagens e interseções por estratégia e cobertura de cada consulta e subconsulta. Com regras, também contagens por elegibilidade, motivos de `unknown` e o resumo da coleta. |
| `report.md` | Diagnóstico para leitura humana. | Comece por "Subconsultas que exigem revisão": se houver saturadas, a cobertura daquela consulta é parcial. |
| `manifest.json` | Reprodutibilidade. | Hashes do catálogo e do protocolo, versões, revisão do código e se havia alterações não commitadas (`git.dirty`), além do SHA-256 de cada arquivo exportado, que mostra se algum foi alterado depois. |
| `discovery.sqlite` | Fonte de verdade. | Tudo o que foi coletado; os demais arquivos derivam dele. |

As interseções do relatório aparecem em três formas: exclusivas (encontrados por uma única estratégia), par a par e a interseção de todas as estratégias. São calculadas sobre todos os candidatos e, quando há regras, também sobre os candidatos `pass`.

Os CSV preservam acentos e escapam vírgulas, aspas e quebras de linha conforme o padrão, então abrem corretamente em planilhas e em `pandas`.

### Etapa 8 — Interromper e retomar

Uma rodada pode levar horas. Se ela for interrompida (Ctrl+C, queda de rede, limite de uso), nada do que foi confirmado se perde. Para continuar:

```sh
pnpm run cli discover --resume data/discovery/mfe-rodada-001
```

A retomada usa o catálogo, o protocolo e as subconsultas gravados na rodada, nunca um arquivo novo. Ela continua cada subconsulta `failed` ou pendente a partir da página salva e retoma a coleta de fatos dos checkpoints, em uma nova invocação com seus próprios orçamentos. Subconsultas `complete` ou `partial` não são buscadas de novo. Antes de qualquer requisição, a retomada escreve em stderr, mesmo sem terminal interativo, uma linha como `Retomando: 3 subconsultas e 1250 tarefas pendentes.` Em rodadas grandes, a primeira etapa é a fase "Avaliando": só os candidatos cujas evidências mudaram desde a última avaliação são reavaliados, e o progresso mostra quantos faltam. Ctrl+C responde também nessa fase; a próxima retomada continua dos candidatos que ficaram sem avaliação, sem refazer os já avaliados. Para mudar consultas ou refazer uma subconsulta saturada, ajuste o catálogo e crie uma rodada nova, num diretório novo.

A rodada só é considerada completa (código `0`) quando todas as subconsultas estão `complete` e nenhum trabalho de coleta necessário está pendente, com falha ou limitado. Caso contrário, ela é parcial (código `2`), e o relatório diz o que falta.


### Etapa 9 — Amostrar e clonar

Quando a triagem é feita sobre uma amostra, e não sobre todos os candidatos, o sorteio acontece depois da exportação e antes da triagem humana. Ele parte das linhas do `candidates.csv` exportado, e não do banco, porque o CSV é a fotografia publicada da rodada, com hash, e pode ser auditada sem a ferramenta. O banco pode mudar depois da exportação (`discover --resume`), e uma amostra tirada dele teria outra população que o CSV e o `report.md` citados na pesquisa.

```sh
pnpm run cli sample --config config/samples/mfe-sample-001.json --output data/samples/mfe-sample-001
pnpm run cli clone --sample data/samples/mfe-sample-001
```

1. **Conferir a fonte.** `sample` compara o SHA-256 do `candidates.csv` com o `manifest.json` da rodada (detecta um CSV editado ou trocado) e as contagens lidas com o `coverage.json` (detecta uma leitura errada). Se algo diverge, recusa a fonte e não grava nada.
2. **Recortar a população.** O filtro da configuração mantém certos status de elegibilidade e descarta certos motivos (no estudo, `pass` e `unknown`, sem `push_unavailable`). O recorte é uma decisão da análise, não do protocolo, e por isso fica na configuração da amostra. As exclusões, por status e por motivo, vão para o `manifest.json` da amostra.
3. **Sortear.** Os N candidatos restantes são ordenados pelo SHA-256 de `seed:id`, e os `size` primeiros formam a amostra. Qualquer pessoa com o CSV, a seed e uma implementação de SHA-256 refaz o sorteio e obtém a mesma lista, qualquer que seja a ordem das linhas.
4. **Clonar.** `clone` confere os hashes do ranking e da amostra contra o manifesto, baixa cada repositório (`git clone --filter=blob:none`), registra o commit clonado e, quando um clone falha, usa o próximo do ranking e registra a substituição. É retomável: o `clones.csv` é a fonte de verdade das tentativas.
5. **Catalogar.** O `catalog.csv` recebe uma linha por repositório clonado. O pesquisador preenche a classificação à mão; a ferramenta só acrescenta linhas novas e nunca altera o que já foi escrito.

O `id` do repositório no GitHub é a chave em todos os arquivos, então qualquer linha da amostra volta ao `candidates.csv` de origem. Detalhes de configuração, arquivos e códigos de saída estão no [README](README.md).

### Etapa 10 — Depois da descoberta

A descoberta entrega **candidatos**, não conclusões. Um repositório que menciona um termo, ou que declara uma dependência, ainda precisa ser examinado para saber se de fato pertence ao fenômeno. A seleção da amostra (etapa 9) é automatizada; a triagem, a classificação e a mineração de artefatos são etapas posteriores, feitas por pessoas sobre estes arquivos.

Os números também têm limites claros: eles descrevem o que estas consultas encontraram nesta data, e não quantos repositórios do tema existem no GitHub.

## Exemplo acompanhado: uma consulta de micro-frontends

O catálogo `config/catalogs/micro-frontends.json` contém esta consulta:

```json
{
  "id": "technology-single-spa-repositories",
  "strategy": "technology",
  "endpoint": "repositories",
  "q": "\"single-spa\" in:name,description,readme",
  "rationale": "Menção à tecnologia; com aspas para evitar a separação do hífen (§3.1, procedimento 2).",
  "partition": { "by": "created", "from": "2019-01-01", "interval": "quarter" }
}
```

1. **Expansão.** Numa rodada iniciada em 05/10/2026, ela vira 33 subconsultas:
   - `technology-single-spa-repositories#created:<2019-01-01`, para os repositórios criados antes de 2019;
   - `…#created:2019-Q1` até `…#created:2026-Q3`, uma por trimestre;
   - `…#created:>=2026-10-01`, para o trimestre corrente.

   O protocolo do estudo (`config/protocols/micro-frontends.json`) tem a regra `last_push` com `since` em `2025-04-01`, então a subconsulta de repositórios recebe `pushed:>=2025-04-01` antes do `created:`. O texto enviado ao GitHub para o segundo trimestre de 2025, por exemplo, é:
   `"single-spa" in:name,description,readme pushed:>=2025-04-01 created:2025-04-01..2025-06-30`
2. **Dry-run.** A linha dessa subconsulta mostra o total. O objetivo é que cada trimestre fique abaixo de 1.000; se algum saturar, o catálogo é ajustado.
3. **Busca.** Suponha que o trimestre tenha 140 resultados: a ferramenta busca 2 páginas (100 + 40), grava cada uma com seu checkpoint e marca a subconsulta como `complete`.
4. **Deduplicação.** Um desses resultados, um repositório fictício `exemplo/shell-app`, também aparece na consulta de código `"single-spa" filename:package.json`, no arquivo `apps/shell/package.json`. Ele continua sendo um único candidato, agora com dois hits.
5. **Coleta de fatos.** O protocolo avalia `recent-push` primeiro; só se o push passar a regra `recent-human-commit` pede o histórico de commits. Para esses candidatos, antes disso, a ferramenta obtém os metadados do repositório pelo GraphQL (branch padrão e seu commit), lista as branches e pagina os commits desde 01/04/2025, dentro dos orçamentos de `--activity-*`.
6. **Elegibilidade.** Um candidato com push anterior a 01/04/2025 (comum entre os achados só pela busca de código) fica `fail` (`push_before_threshold`) e a avaliação para aí, sem coleta de commits. Se o push passa e algum commit desse intervalo, em qualquer branch, tem autor humano, a regra passa e o candidato fica `pass`, com as evidências registradas. Se a coleta termina completa e nenhum commit qualifica, fica `fail`. Se o orçamento acaba antes, fica `unknown`, nunca `fail`.
7. **Exportação.** Em `candidates.csv`, ele aparece uma vez, com `strategies = technology` (as duas consultas são de tecnologia) e o resultado da regra. Em `discovery-hits.csv`, aparece duas vezes, uma por subconsulta, cada uma com seu texto exato e sua data de coleta.
8. **Triagem.** A partir daqui, um pesquisador verifica se `exemplo/shell-app` tem de fato duas ou mais unidades de frontend compostas por single-spa, e o classifica.

## Como os dados são tratados

| Dado | Onde fica | Tratamento |
| --- | --- | --- |
| Resposta de cada página | `discovery.sqlite`, tabela `pages` | Guardada como recebida, com caminhos de arquivo normalizados; nunca é sobrescrita, mesmo se a página for pedida de novo. |
| Repositório | Tabela `candidates` | Deduplicado pelo id numérico; mantém os metadados originais do primeiro encontro e sua data. A leitura para análise projeta uma única observação REST dos hits, com sua própria data de observação. |
| Ocorrência | Tabela `hits` | Uma por subconsulta, repositório e caminho; guarda a consulta de origem e a data de coleta. |
| Fatos coletados | Tabelas `repository_observations`, `activity_commits`, `activity_refs` e `collection_*` | Metadados e histórico de commits pedidos pelas regras, separados dos metadados da busca, com tarefas, tentativas e invocações. |
| Elegibilidade | Tabela `evaluations` | Avaliação por candidato, ligada à revisão dos fatos usada; a exportação reavalia sobre a fotografia quando ela está desatualizada, sem gravar. |
| Token do GitHub | Apenas na memória do processo | Nunca gravado; removido de qualquer mensagem de erro. |
| Integridade | `manifest.json` | Hash do catálogo e do protocolo, revisão do código, estado da árvore git e SHA-256 de cada arquivo exportado. |

## Para desenvolvedores

### Estrutura do código

| Caminho | Responsabilidade |
| --- | --- |
| `src/cli/` | Ponto de entrada. `main.ts` registra os comandos e converte erros em código de saída; `options.ts` valida as flags; `runtime.ts` traz interrupção, espera e redação do token; `commands/discover.ts` (início, retomada e dry-run) e `commands/report.ts` executam cada comando. Não conhece SQL. |
| `src/common/` | Funções sem domínio (`canonicalJson`, `isIsoDate`, `isRecord`, leitura e escrita de CSV em `csv.ts`, `sha256File` em `hash.ts`), que não importam nada de `src/`. |
| `src/modules/sampling/` | Amostragem e clone, ligados à descoberta só pelo formato do `candidates.csv`: `config.ts` (configuração), `population.ts` (conferência da fonte e filtro), `ranking.ts` (hash e ordenação), `sample.ts` (grava a amostra), `clone.ts` (tentativas, substituição e retomada) e `catalog.ts` (acréscimos ao `catalog.csv`). `commands/sample.ts` e `commands/clone.ts` em `src/cli/` os executam. |
| `src/modules/discovery/` | O módulo de descoberta; as linhas seguintes são suas pastas. |
| `src/modules/discovery/study/catalog.ts` | Validação das consultas e hash canônico do catálogo. |
| `src/modules/discovery/study/config.ts` | Catálogo e protocolo juntos: validação e plano de busca. |
| `src/modules/discovery/eligibility/` | Protocolo, avaliação e o registro de regras (`registry.ts`). Cada regra (`last_push`, `recent_commit`) é um módulo em `rules/` que declara tipo, versão, `parse`, `evaluate` e, se restringir a busca, `searchSince`. Para criar uma regra nova: (1) um módulo em `rules/` com sua `RuleDefinition`, (2) uma linha em `registry.ts` e (3) um membro na união `EligibilityRule` em `model/study.ts`. |
| `src/modules/discovery/collection/` | Coleta dos fatos que as regras pedem, com orçamentos. |
| `src/modules/discovery/study/expansion.ts` | Expansão determinística em subconsultas. |
| `src/modules/discovery/http/client.ts` | Política de rede comum: cadência, timeout, tentativas, limites de taxa e ocultação do token. |
| `src/modules/discovery/search/github-client.ts` | Busca REST (repositórios e código) e contagem do dry-run. |
| `src/modules/discovery/search/run-search.ts` | Execução da busca paginada por subconsulta, com checkpoints e cobertura. |
| `src/modules/discovery/collection/enrichment-client.ts` | Cliente GraphQL de metadados de repositório. |
| `src/modules/discovery/pipeline/run-discovery.ts` | Execução da busca e da coleta e estado final da rodada. |
| `src/modules/discovery/storage/` | Banco SQLite: esquema, gravações transacionais e leituras. |
| `src/modules/discovery/report/` | Exportações, interseções e manifesto. |
| `src/modules/discovery/model/` | Contratos compartilhados: só `export type`/`interface`, importando apenas de `model/`. Qualquer camada pode importá-los sem puxar código de execução. |
| `config/catalogs/` | Catálogos de estudos; `micro-frontends.json` é o caso de uso atual. |
| `tests/` | Testes sem acesso à rede. `unit/` espelha `src/`: o teste de `src/modules/discovery/study/catalog.ts` fica em `tests/unit/modules/discovery/study/catalog.test.ts`. `integration/` reúne os que atravessam módulos (CLI, pipeline com banco real, catálogo versionado em `config/` e arquitetura). `helpers.ts` e `fixtures/` ficam na raiz. |

### Dependências e imports

A direção das dependências é `cli → pipeline → (search | collection | eligibility | storage | report) → (http | study) → model`, e todos podem usar `src/common/`. `storage/` não depende de `pipeline/`, `report/` nem de `cli/`. O teste `tests/integration/architecture.test.ts` verifica essa direção, a ausência de ciclos e o espelhamento de `tests/unit/`.

Um import na mesma pasta usa `./x.js`. Qualquer outro import interno usa `@/…` (a partir de `src/`) ou `@tests/…` (a partir de `tests/`), sempre com a extensão `.js`. `../` não aparece em `src/` nem em `tests/`. O alias resolve no `tsc` (`paths`), no Vitest (`resolve.alias`) e em `dist/` (`tsc-alias`, executado por `pnpm build`).

### Armazenamento (`src/modules/discovery/storage/`)

O contrato `DiscoveryStore` fica em `model/store.ts`. `store.ts` traz `openStore` e `inspectStore` e compõe os módulos abaixo em um único `DiscoveryStore`. Cada módulo responde a uma pergunta:

| Arquivo | Conteúdo |
|---|---|
| `schema.ts` | DDL multilinha, uma constante por tabela, em ordem de dependência. |
| `connection.ts` | Abertura do banco, validação de bancos existentes e transações. |
| `database.ts` | `get`, `all`, `run`, `tx`, `insertIfAbsent` e leituras que falham com erro conhecido. |
| `search-data.ts` | Consultas, subconsultas, páginas, acertos e checkpoints da busca. |
| `runs.ts` | Rodada, invocações e limites. |
| `facts.ts` | Candidatos, observações, inspeção e avaliações. |
| `tasks.ts` | Tarefas de coleta e os fatos que cada passo grava. |
| `attempts.ts` | Tentativas, orçamento por invocação e durações. |
| `summary.ts` | Resumo e métricas da coleta. |
| `snapshot.ts` | Leitura consistente de um instante do banco. |
| `stored-run.ts` | Leituras somente leitura de uma rodada existente, antes de abrir o banco para escrita: configuração armazenada e tamanhos de página originais. |

Convenção de espaçamento: uma linha em branco entre declarações de topo e entre os membros de objetos de API. O Biome não verifica isso, então a revisão é quem garante.

`INSERT`s nomeiam as colunas e o DDL não é derivado com `String.replace`.

### Ambiente e verificações

O projeto fixa Node.js `26.9.0` em `.nvmrc` e pnpm `9.15.9` em `package.json`:

```sh
fnm install
fnm use
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

O build é necessário antes de usar a CLI, porque `pnpm run cli` executa `dist/src/cli/main.js`.

```sh
pnpm run check      # Biome (formatação e lint)
pnpm run typecheck  # TypeScript
pnpm test           # Vitest
pnpm run build      # compila para dist/
```

### Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | Ajuda exibida, relatório exportado, amostra gravada pelo `sample`, amostra completa no `clone`, dry-run sem subconsulta acima de 1.000 resultados, ou rodada com todas as subconsultas `complete` e nenhum trabalho de coleta necessário pendente, com falha ou limitado. |
| `1` | Erro fatal: opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato incompatível, falha de requisição no dry-run, `git` ausente ou diretório sem amostra no `clone`, ou, no `sample`, configuração inválida, fonte alterada ou divergente do `coverage.json`, `size` maior que N e diretório de saída já usado. |
| `2` | Rodada parcial (subconsulta saturada, incompleta ou com falha, coleta ainda necessária pendente, com falha ou limitada por orçamento, interrupção) ou dry-run com subconsulta acima de 1.000 resultados; no `clone`, menos de `size` repositórios clonados. |

## Limites de interpretação

- O GitHub pode alterar a indexação durante a rodada e marcar resultados como incompletos; os arquivos registram a cobertura observada naquele momento, não um inventário completo.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB.
- Frequências de candidatos não são prevalência do fenômeno nem casos confirmados; pertinência, classificação e elegibilidade dependem de triagem humana.
