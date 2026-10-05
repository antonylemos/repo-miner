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

As subconsultas são executadas uma de cada vez, na ordem do catálogo. Para cada uma, a ferramenta pede páginas de 100 resultados ao GitHub, até no máximo 10 páginas (1.000 resultados, o limite da API).

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

### Etapa 5 — Enriquecer metadados

A busca de repositórios já devolve a data do último push, a linguagem, o tamanho e se o repositório é fork ou está arquivado. A busca de código não devolve: ela informa só o arquivo e um resumo do repositório.

Por isso, depois das buscas, os candidatos sem data de push entram numa fila de enriquecimento. A ferramenta consulta a API GraphQL em lotes de até 100 repositórios e grava, à parte e sem sobrescrever os metadados da busca, a data de criação, a do último push, os indicadores de fork, arquivado, template e espelho, o tamanho, a linguagem principal, as estrelas, os tópicos, a branch padrão e a descrição.

| Resultado | Significado |
| --- | --- |
| `ok` | Metadados obtidos. |
| `not_found` | O repositório foi removido ou ficou privado. Situação definitiva. |
| `failed` | Falha temporária. Será tentado de novo na retomada. |

### Etapa 6 — Aplicar o recorte temporal

Cada candidato recebe um `scope`, calculado no momento da exportação e nunca gravado no banco, para que uma mudança de regra não exija refazer a coleta:

1. Se o enriquecimento deu certo, vale a data de push obtida por ele.
2. Senão, vale a data de push informada pela busca.
3. Com uma data em mãos: `in_scope` se ela é igual ou posterior ao recorte, `out_of_scope_temporal` se é anterior.
4. Sem data utilizável: `unknown`.

A fonte da data (`enrichment` ou `search`) e o momento em que ela foi observada são exportados junto, para que qualquer pessoa possa conferir de onde veio a decisão.

Candidatos fora do recorte **não são apagados**: continuam nas exportações, apenas marcados. Retirar alguém da análise é uma decisão que precisa estar visível.

### Etapa 7 — Exportar e ler os resultados

Ao final, e também quando a rodada é interrompida, a ferramenta lê o banco e gera os arquivos abaixo. `report` regenera os mesmos arquivos a qualquer momento, sem token.

| Arquivo | Para que serve | Como ler |
| --- | --- | --- |
| `candidates.csv` | Lista de trabalho para a triagem. | Uma linha por repositório. Filtre por `scope = in_scope`. A coluna `strategies` mostra quais procedimentos o encontraram (`terminology;technology`, por exemplo). |
| `discovery-hits.csv` | Proveniência completa. | Uma linha por ocorrência, com consulta, subconsulta, texto exato enviado (`q_effective`), data de coleta e caminho do arquivo. Responde "por que este repositório está na lista?". |
| `coverage.json` | Números para análise. | Totais, contagens por recorte e por estratégia, interseções e cobertura de cada consulta e subconsulta. |
| `report.md` | Diagnóstico para leitura humana. | Comece por "Subconsultas que exigem revisão": se houver saturadas, a cobertura daquela consulta é parcial. |
| `manifest.json` | Reprodutibilidade. | Hash do catálogo, versões, revisão do código e se havia alterações não commitadas (`git.dirty`), além do SHA-256 de cada arquivo exportado, que mostra se algum foi alterado depois. |
| `discovery.sqlite` | Fonte de verdade. | Tudo o que foi coletado; os demais arquivos derivam dele. |

As interseções do relatório são calculadas só sobre candidatos `in_scope` e aparecem em três formas: exclusivas (encontrados por uma única estratégia), par a par e a interseção das três.

Os CSV preservam acentos e escapam vírgulas, aspas e quebras de linha conforme o padrão, então abrem corretamente em planilhas e em `pandas`.

### Etapa 8 — Interromper e retomar

Uma rodada pode levar horas. Se ela for interrompida (Ctrl+C, queda de rede, limite de uso), nada do que foi confirmado se perde. Para continuar:

```sh
pnpm run cli discover --resume data/discovery/mfe-rodada-001
```

A retomada usa o catálogo e as subconsultas gravados na rodada, nunca um arquivo novo. Ela continua cada subconsulta `failed` ou pendente a partir da página salva e refaz apenas os enriquecimentos pendentes ou com falha. Subconsultas `complete` ou `partial` não são buscadas de novo. Para mudar consultas ou refazer uma subconsulta saturada, ajuste o catálogo e crie uma rodada nova, num diretório novo.

A rodada só é considerada completa (código `0`) quando todas as subconsultas estão `complete` e nenhum enriquecimento está pendente ou com falha. Caso contrário, ela é parcial (código `2`), e o relatório diz o que falta.

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

1. **Expansão.** Numa rodada iniciada em 05/10/2026, com recorte em 01/01/2024, ela vira 33 subconsultas:
   - `technology-single-spa-repositories#created:<2019-01-01`, para os repositórios criados antes de 2019;
   - `…#created:2019-Q1` até `…#created:2026-Q3`, uma por trimestre;
   - `…#created:>=2026-10-01`, para o trimestre corrente.

   O texto enviado ao GitHub para o segundo trimestre de 2025, por exemplo, é:
   `"single-spa" in:name,description,readme pushed:>=2024-01-01 created:2025-04-01..2025-06-30`
2. **Dry-run.** A linha dessa subconsulta mostra o total. A consulta inteira tinha cerca de 2.500 repositórios ativos, então cada trimestre fica bem abaixo de 1.000.
3. **Busca.** Suponha que o trimestre tenha 140 resultados: a ferramenta busca 2 páginas (100 + 40), grava cada uma com seu checkpoint e marca a subconsulta como `complete`.
4. **Deduplicação.** Um desses resultados, um repositório fictício `exemplo/shell-app`, também aparece na consulta de código `"single-spa" filename:package.json`, no arquivo `apps/shell/package.json`. Ele continua sendo um único candidato, agora com dois hits.
5. **Enriquecimento.** Como ele foi encontrado primeiro pela busca de repositórios, que traz a data de push, não precisa ser enriquecido. Se tivesse aparecido só na busca de código, entraria na fila do GraphQL.
6. **Recorte.** Com último push em março de 2025, ele fica `in_scope`, com fonte `search`.
7. **Exportação.** Em `candidates.csv`, ele aparece uma vez, com `strategies = technology` (as duas consultas são de tecnologia). Em `discovery-hits.csv`, aparece duas vezes, uma por subconsulta, cada uma com seu texto exato e sua data de coleta.
8. **Triagem.** A partir daqui, um pesquisador verifica se `exemplo/shell-app` tem de fato duas ou mais unidades de frontend compostas por single-spa, e o classifica.

## Como os dados são tratados

| Dado | Onde fica | Tratamento |
| --- | --- | --- |
| Resposta de cada página | `discovery.sqlite`, tabela `pages` | Guardada como recebida, com caminhos de arquivo normalizados; nunca é sobrescrita, mesmo se a página for pedida de novo. |
| Repositório | Tabela `candidates` | Deduplicado pelo id numérico; mantém os metadados do primeiro encontro e a data desse encontro. |
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
| `0` | Ajuda exibida, relatório exportado, dry-run sem subconsulta acima de 1.000 resultados, ou rodada com todas as subconsultas `complete` e nenhum enriquecimento `pending` ou `failed`. |
| `1` | Erro fatal: opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato anterior, ou falha de requisição no dry-run. |
| `2` | Rodada parcial (subconsulta saturada, incompleta ou com falha, enriquecimento pendente ou com falha, interrupção) ou dry-run com subconsulta acima de 1.000 resultados. |

## Limites de interpretação

- O GitHub pode alterar a indexação durante a rodada e marcar resultados como incompletos; os arquivos registram a cobertura observada naquele momento, não um inventário completo.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB.
- Frequências de candidatos não são prevalência do fenômeno nem casos confirmados; pertinência, classificação e elegibilidade dependem de triagem humana.
