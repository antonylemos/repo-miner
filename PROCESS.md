# Como o repo-miner funciona

Este guia é para quem nunca viu o projeto: pesquisadores que vão usar os dados, revisores que precisam confiar neles e desenvolvedores que vão mantê-lo. Ele acompanha uma mineração do começo ao fim e explica, em cada etapa, o que acontece e o que é feito com os dados.

## Em uma frase

Você descreve num catálogo **o que buscar e por quê**. O repo-miner transforma isso em buscas no GitHub, recupera todos os resultados, junta as repetições sem perder de onde cada uma veio, completa as informações que faltam, marca quem está dentro do recorte de tempo e entrega planilhas e um relatório que dizem exatamente o que foi encontrado e com que cobertura.

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
 │  expansão em │─▶│ busca e     │─▶│ gravação e   │─▶│ enriquecimento│─▶│ recorte e    │
 │ subconsultas │  │ paginação   │  │ deduplicação │  │ (GraphQL)     │  │ exportação   │
 └──────────────┘  └─────────────┘  └──────────────┘  └───────────────┘  └──────┬───────┘
                                                                               ▼
                                     candidates.csv · discovery-hits.csv · coverage.json
                                     report.md · manifest.json · discovery.sqlite
                                               │
                                               ▼
                                       triagem humana
```

O diagrama mostra o caminho dos dados. Na execução, as duas buscas e o enriquecimento podem se sobrepor, conforme as etapas 3 e 5.

## Vocabulário

| Termo | O que significa aqui |
| --- | --- |
| **Catálogo** | Arquivo JSON com as consultas de um estudo, o recorte de tempo e a justificativa de cada consulta. |
| **Consulta** | Uma busca declarada no catálogo, como `"single-spa" in:name,description,readme`. |
| **Estratégia** | O procedimento a que a consulta pertence: `terminology` (termos que nomeiam o fenômeno), `technology` (tecnologias ou artefatos associados) ou `broader` (termos amplos ou adjacentes). |
| **Subconsulta** | Um pedaço de uma consulta, gerado pela ferramenta, por exemplo restrito aos repositórios criados num trimestre. É a unidade que realmente vai ao GitHub. |
| **Partição** | A regra que divide uma consulta em subconsultas: por data de criação (repositórios) ou por tamanho de arquivo (código). |
| **Hit** | Uma ocorrência: o repositório X apareceu na subconsulta Y, no arquivo Z. |
| **Candidato** | Um repositório distinto, identificado pelo id numérico do GitHub. Vários hits podem apontar para o mesmo candidato. |
| **Rodada** | Uma execução completa de um catálogo, gravada num diretório próprio. |
| **Checkpoint** | A marca de até onde cada subconsulta foi buscada; permite retomar sem repetir trabalho. |
| **Saturação** | Quando uma subconsulta tem mais de 1.000 resultados, o máximo que o GitHub entrega. |
| **Enriquecimento** | A busca de metadados adicionais para candidatos que vieram só da busca de código. |
| **Recorte (scope)** | A classificação de cada candidato quanto à atividade recente: `in_scope`, `out_of_scope_temporal` ou `unknown`. |
| **Proveniência** | O registro de como, quando e por qual consulta um dado foi obtido. |

## A jornada passo a passo

### Etapa 0 — Da pergunta ao catálogo

Tudo começa com uma pergunta de pesquisa, por exemplo "como micro-frontends aparecem em repositórios?". O catálogo traduz a pergunta em buscas, combinando as três estratégias para não depender de um único vocabulário: repositórios que **dizem** ser do tema (`terminology`), que **usam** tecnologias do tema (`technology`) e que descrevem o tema com **outras palavras** (`broader`).

Cada consulta tem uma justificativa (`rationale`) escrita por quem a criou. Isso deixa o catálogo auditável: um revisor consegue saber por que cada busca existe.

Algumas lições práticas, aprendidas no caso de uso de micro-frontends:

- Termos com hífen vão entre aspas. Sem aspas, `single-spa` vira "single" OU "spa" e traz centenas de milhares de resultados irrelevantes.
- Tópicos (`topic:nome`) são os metadados mais precisos e costumam ter poucos resultados.
- Para encontrar quem usa uma tecnologia, busque artefatos, como `filename:package.json` ou arquivos de configuração, em vez de prosa.

Os qualificadores `pushed:`, `created:` e `size:` não podem ser escritos à mão: a ferramenta os gera a partir do recorte e da partição.

### Etapa 1 — Pré-visualizar o volume (dry-run)

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --dry-run > dry-run.md
```

O dry-run faz a expansão (etapa 2) e pergunta ao GitHub apenas **quantos** resultados cada subconsulta tem, pedindo um único item por subconsulta. Ele imprime uma tabela com a consulta, a subconsulta, o texto efetivamente enviado, o total e uma marca nas subconsultas acima de 1.000.

Nenhum arquivo é criado. Se alguma subconsulta saturar, o comando retorna `2`, e o ajuste é feito no catálogo: um intervalo menor (de trimestre para mês, por exemplo) ou mais faixas de tamanho. Repete-se o dry-run até tudo caber, ou até que a saturação restante seja uma decisão consciente e registrada.

### Etapa 2 — Iniciar a rodada e expandir o catálogo

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --output data/discovery/mfe-rodada-001
```

Ao iniciar, a ferramenta:

1. **Valida o catálogo.** Identificadores únicos, estratégias e endpoints conhecidos, justificativas presentes, partições compatíveis com o endpoint. Qualquer erro interrompe tudo antes de qualquer busca.
2. **Calcula o hash do catálogo** (SHA-256 de uma forma canônica do JSON). O hash identifica exatamente o que foi buscado e impede que uma retomada use um catálogo diferente.
3. **Expande cada consulta em subconsultas.** Para consultas de repositórios, acrescenta `pushed:>=<data do recorte>`. Se houver partição por data de criação, gera um balde inicial (`created:<início>`), um intervalo por período e um intervalo final aberto até hoje. Se houver partição por tamanho, gera uma faixa para cada intervalo de `bounds`. A data de criação da rodada fixa o último intervalo, então a expansão é sempre a mesma para o mesmo catálogo e a mesma data.
4. **Grava tudo em `discovery.sqlite`**: o catálogo, o hash, o recorte, a data de expansão e a lista de subconsultas, cada uma com um checkpoint "pendente".

### Etapa 3 — Buscar e paginar

Os endpoints de busca de repositórios e de código executam em paralelo. Dentro de cada endpoint, as subconsultas seguem a ordem do catálogo, uma de cada vez, e suas páginas também são sequenciais. Para cada subconsulta, a ferramenta pede páginas de 100 resultados ao GitHub, até no máximo 10 páginas (1.000 resultados, o limite da API). O GraphQL processa lotes completos de enriquecimento durante as buscas; os candidatos restantes são tratados ao final.

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

`first_seen_at` continua sendo a data do primeiro encontro. A data da observação selecionada é usada em `pushed_at_observed_at` quando a fonte efetiva do push é a busca; quando é enriquecimento, usa a data de coleta do GraphQL.

### Etapa 5 — Enriquecer metadados

A busca de repositórios já devolve a data do último push, a linguagem, o tamanho e se o repositório é fork ou está arquivado. A busca de código não devolve: ela informa só o arquivo e um resumo do repositório.

Por isso, candidatos sem push de busca válido entram numa fila de enriquecimento. A ferramenta consulta a API GraphQL em lotes de até 100 repositórios: lotes completos enquanto as buscas continuam e os restantes ao final. Ela grava, à parte e sem sobrescrever os metadados da busca, a data de criação, a do último push, os indicadores de fork, arquivado, template e espelho, o tamanho, a linguagem principal, as estrelas, os tópicos, a branch padrão e a descrição.

| Resultado | Significado |
| --- | --- |
| `ok` | Metadados obtidos. |
| `not_found` | O repositório foi removido ou ficou privado. Situação definitiva. |
| `failed` | Falha temporária. Será tentado de novo na retomada. |

Um campo legitimamente nulo, inclusive `pushedAt`, não é uma falha: se o nó válido não tem erro associado, permanece `ok`. Numa resposta parcial, um erro em um campo ou nó marca apenas o candidato afetado como `failed`; irmãos sem erro continuam `ok`. Erros sem caminho que identifique confiavelmente um alvo afetam o lote inteiro. `NOT_FOUND` só gera `not_found` quando o nó está ausente e o caminho aponta diretamente para ele (`nodes`, índice); `NOT_FOUND` em campo aninhado é `failed`. Um nó ausente sem prova definitiva de remoção também é `failed`. Os motivos armazenados ocultam o token.

Se uma observação REST com push válido chegar depois de um enriquecimento `pending` ou `failed`, ele deixa de ser necessário e não é reenviado. O registro histórico e seu motivo são preservados; uma chamada GraphQL já em andamento também tem seu resultado conservado. Cada candidato necessário é tentado no máximo uma vez por invocação; falhas restantes aguardam a retomada.

### Etapa 6 — Aplicar o recorte temporal

Cada candidato recebe um `scope`, calculado no momento da exportação e nunca gravado no banco, para que uma mudança de regra não exija refazer a coleta:

1. Se o enriquecimento está `ok` e seu push é válido, vale essa data, mesmo se foi observada antes da REST.
2. Senão (inclusive push enriquecido nulo ou inválido), vale o push válido da observação de busca selecionada.
3. Com uma data em mãos: `in_scope` se ela é igual ou posterior ao recorte, `out_of_scope_temporal` se é anterior.
4. Sem data utilizável: `unknown`.

A fonte da data (`enrichment` ou `search`) e o momento em que ela foi observada são exportados junto, para que qualquer pessoa possa conferir de onde veio a decisão.

**O que conta como atividade.** A data comparada é a do **último push** ao GitHub, não a data dos commits. Com recorte em 01/04/2025, um repositório entra quando recebeu algum push entre essa data e o momento da coleta. Isso tem quatro consequências:

- Commits criados em março de 2025 e enviados em abril contam como atividade em abril; um commit datado de abril que nunca foi enviado não conta.
- Um push em qualquer branch atualiza a data, mesmo que o branch principal esteja parado.
- "Até hoje" quer dizer até a coleta: a data é lida quando o repositório aparece na busca ou é enriquecido, e um push feito depois da rodada não muda o resultado dela.
- Estar ativo não significa que o fenômeno estudado foi implementado recentemente. Um repositório antigo com um ajuste em 2025 entra no recorte; se o estudo exigir commits recentes no branch principal, esse é outro critério, não aplicado hoje.

Candidatos fora do recorte **não são apagados**: continuam nas exportações, apenas marcados. Retirar alguém da análise é uma decisão que precisa estar visível.

### Etapa 7 — Exportar e ler os resultados

Ao final, e também quando a rodada é interrompida, a ferramenta lê o banco e gera os arquivos abaixo. `report` regenera os mesmos arquivos a qualquer momento, sem token.

Todas as leituras de uma exportação usam a mesma fotografia do SQLite: CSV, cobertura, catálogo, resumo de enriquecimento e estado da rodada refletem um único instante. O CSV continua sendo escrito por streaming. Durante a coleta, outra conexão pode confirmar páginas sem bloquear esse cursor; essas páginas aparecem na exportação seguinte. Uma falha de escrita encerra o cursor e libera a transação de leitura, permitindo tentar exportar novamente.

O banco em arquivo usa WAL e pode manter `discovery.sqlite-wal` e `discovery.sqlite-shm` enquanto estiver aberto. Eles são arquivos auxiliares do SQLite. Por diretório, mantenha no máximo um writer de descoberta e um exporter ativo. `report` durante a coleta é suportado; duas exportações simultâneas para os mesmos arquivos, inclusive `report` sobreposto à exportação final de `discover`, ficam fora desse limite.

| Arquivo | Para que serve | Como ler |
| --- | --- | --- |
| `candidates.csv` | Lista de trabalho para a triagem. | Uma linha por repositório. Filtre por `scope = in_scope`. A coluna `strategies` mostra quais procedimentos o encontraram (`terminology;technology`, por exemplo). |
| `discovery-hits.csv` | Proveniência completa. | Uma linha por ocorrência, com consulta, subconsulta, texto exato enviado (`q_effective`), data de coleta e caminho do arquivo. Responde "por que este repositório está na lista?". |
| `coverage.json` | Números para análise. | Totais, contagens por recorte e por estratégia, interseções e cobertura de cada consulta e subconsulta. |
| `report.md` | Diagnóstico para leitura humana. | Comece por "Subconsultas que exigem revisão": se houver saturadas, a cobertura daquela consulta é parcial. |
| `manifest.json` | Reprodutibilidade. | Hash do catálogo, versões, revisão do código e se havia alterações não commitadas (`git.dirty`), além do SHA-256 de cada arquivo exportado, que mostra se algum foi alterado depois. |
| `discovery.sqlite` | Fonte de verdade. | Tudo o que foi coletado; os demais arquivos derivam dele. |

As interseções do relatório são calculadas só sobre candidatos `in_scope` e aparecem em três formas: exclusivas (encontrados por uma única estratégia), par a par e a interseção das três.

`coverage.json.enrichment` conta os estados históricos `pending`, `ok`, `not_found` e `failed`; o CSV mantém esse histórico em `enrichment_status`. Os campos `enrichmentRequired` e `enrichmentSuperseded` contam separadamente `pending` e `failed` ainda necessários e dispensados por push REST válido. O relatório Markdown também mostra essa distinção. Assim, uma falha histórica pode continuar visível numa rodada sem pendências efetivas.

Os CSV preservam acentos e escapam vírgulas, aspas e quebras de linha conforme o padrão, então abrem corretamente em planilhas e em `pandas`.

### Etapa 8 — Interromper e retomar

Uma rodada pode levar horas. Se ela for interrompida (Ctrl+C, queda de rede, limite de uso), nada do que foi confirmado se perde. Para continuar:

```sh
pnpm run cli discover --resume data/discovery/mfe-rodada-001
```

A retomada usa o catálogo e as subconsultas gravados na rodada, nunca um arquivo novo. Ela continua cada subconsulta `failed` ou pendente a partir da página salva e refaz apenas os enriquecimentos pendentes ou com falha ainda necessários. Numa resposta GraphQL parcial, só os candidatos afetados e ainda necessários são reenviados. Subconsultas `complete` ou `partial` não são buscadas de novo. Para mudar consultas ou refazer uma subconsulta saturada, ajuste o catálogo e crie uma rodada nova, num diretório novo.

A rodada só é considerada completa (código `0`) quando todas as subconsultas estão `complete` e nenhum enriquecimento ainda necessário está pendente ou com falha. Registros históricos dispensados por REST não impedem a conclusão. Caso contrário, ela é parcial (código `2`), e o relatório diz o que falta.

Rodadas SQLite v2 existentes continuam aceitas. Executar `report` recupera metadados a partir dos hits REST já armazenados e recalcula o recorte e o diagnóstico atual, sem rede nem token. Ele não altera o estado persistido da rodada: uma rodada antiga pode continuar com `run.state = partial` mesmo sem pendências necessárias. Só `discover --resume` recalcula e grava esse estado; se todas as buscas terminaram e a REST dispensa as falhas, isso ocorre sem novas chamadas ao GitHub.

A recuperação usa apenas informações registradas. Erros GraphQL antigos que não foram armazenados são irrecuperáveis; um registro antigo `ok` com `pushedAt: null` não recebe um motivo de erro inventado nem é reenviado automaticamente. Formatos anteriores já rejeitados continuam incompatíveis e exigem uma rodada nova.

### Etapa 9 — Depois da descoberta

A descoberta entrega **candidatos**, não conclusões. Um repositório que menciona um termo, ou que declara uma dependência, ainda precisa ser examinado para saber se de fato pertence ao fenômeno. A triagem, a seleção da amostra e a mineração de artefatos são etapas posteriores, feitas por pessoas sobre estes arquivos.

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

1. **Expansão.** Numa rodada iniciada em 05/10/2026, com recorte em 01/04/2025, ela vira 33 subconsultas:
   - `technology-single-spa-repositories#created:<2019-01-01`, para os repositórios criados antes de 2019;
   - `…#created:2019-Q1` até `…#created:2026-Q3`, uma por trimestre;
   - `…#created:>=2026-10-01`, para o trimestre corrente.

   O texto enviado ao GitHub para o segundo trimestre de 2025, por exemplo, é:
   `"single-spa" in:name,description,readme pushed:>=2025-04-01 created:2025-04-01..2025-06-30`
2. **Dry-run.** A linha dessa subconsulta mostra o total. A consulta inteira tinha cerca de 1.700 repositórios ativos, então cada trimestre fica bem abaixo de 1.000.
3. **Busca.** Suponha que o trimestre tenha 140 resultados: a ferramenta busca 2 páginas (100 + 40), grava cada uma com seu checkpoint e marca a subconsulta como `complete`.
4. **Deduplicação.** Um desses resultados, um repositório fictício `exemplo/shell-app`, também aparece na consulta de código `"single-spa" filename:package.json`, no arquivo `apps/shell/package.json`. Ele continua sendo um único candidato, agora com dois hits.
5. **Enriquecimento.** Como ele foi encontrado primeiro pela busca de repositórios, que traz a data de push, não precisa ser enriquecido. Se tivesse aparecido só na busca de código, entraria na fila do GraphQL.
6. **Recorte.** Com `pushed_at = 2025-05-01T00:00:00Z` e recorte `2025-04-01`, ele fica `in_scope`, com fonte `search`. Um último push em março de 2025 ficaria `out_of_scope_temporal`.
7. **Exportação.** Em `candidates.csv`, ele aparece uma vez, com `strategies = technology` (as duas consultas são de tecnologia). Em `discovery-hits.csv`, aparece duas vezes, uma por subconsulta, cada uma com seu texto exato e sua data de coleta.
8. **Triagem.** A partir daqui, um pesquisador verifica se `exemplo/shell-app` tem de fato duas ou mais unidades de frontend compostas por single-spa, e o classifica.

## Como os dados são tratados

| Dado | Onde fica | Tratamento |
| --- | --- | --- |
| Resposta de cada página | `discovery.sqlite`, tabela `pages` | Guardada como recebida, com caminhos de arquivo normalizados; nunca é sobrescrita, mesmo se a página for pedida de novo. |
| Repositório | Tabela `candidates` | Deduplicado pelo id numérico; mantém os metadados originais do primeiro encontro e sua data. A leitura para análise projeta uma única observação REST dos hits, com sua própria data de observação. |
| Ocorrência | Tabela `hits` | Uma por subconsulta, repositório e caminho; guarda a consulta de origem e a data de coleta. |
| Metadados extras | Tabela `enrichments` | Separados dos metadados da busca, com status, data e motivo de falha. |
| Recorte | Calculado na exportação | Derivado das datas disponíveis; nunca gravado, para poder ser recalculado. |
| Token do GitHub | Apenas na memória do processo | Nunca gravado; removido de qualquer mensagem de erro. |
| Integridade | `manifest.json` | Hash do catálogo, revisão do código, estado da árvore git e SHA-256 de cada arquivo exportado. |

## Para desenvolvedores

### Estrutura do código

| Caminho | Responsabilidade |
| --- | --- |
| `src/cli/main.ts` | Comandos, opções, códigos de saída, dry-run, início e retomada. |
| `src/discovery/catalog.ts` | Validação do catálogo e hash canônico. |
| `src/discovery/expansion.ts` | Expansão determinística em subconsultas. |
| `src/discovery/http.ts` | Política de rede comum: cadência, timeout, tentativas, limites de taxa e ocultação do token. |
| `src/discovery/github.ts` | Busca REST (repositórios e código) e contagem do dry-run. |
| `src/discovery/enrichment.ts` | Enriquecimento pela API GraphQL. |
| `src/discovery/runner.ts` | Execução das subconsultas, enriquecimento e estado final da rodada. |
| `src/discovery/storage.ts` | Banco SQLite: esquema, gravações transacionais e leituras. |
| `src/discovery/scope.ts` | Data de push efetiva e classificação temporal. |
| `src/discovery/report.ts` | Exportações, interseções e manifesto. |
| `src/discovery/types.ts` | Tipos compartilhados. |
| `config/catalogs/` | Catálogos de estudos; `micro-frontends.json` é o caso de uso atual. |
| `tests/` | Testes de cada módulo, sem acesso à rede. |

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
| `0` | Ajuda exibida, relatório exportado, dry-run sem subconsulta acima de 1.000 resultados, ou rodada com todas as subconsultas `complete` e nenhum enriquecimento ainda necessário `pending` ou `failed`. |
| `1` | Erro fatal: opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato anterior, ou falha de requisição no dry-run. |
| `2` | Rodada parcial (subconsulta saturada, incompleta ou com falha, enriquecimento ainda necessário pendente ou com falha, interrupção) ou dry-run com subconsulta acima de 1.000 resultados. |

## Limites de interpretação

- O GitHub pode alterar a indexação durante a rodada e marcar resultados como incompletos; os arquivos registram a cobertura observada naquele momento, não um inventário completo.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB.
- Frequências de candidatos não são prevalência do fenômeno nem casos confirmados; pertinência, classificação e elegibilidade dependem de triagem humana.
