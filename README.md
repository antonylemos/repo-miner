# repo-miner

CLI em TypeScript para descobrir repositórios públicos do GitHub a partir de um catálogo de consultas, de forma reproduzível e auditável. Para cada repositório encontrado, a ferramenta registra por qual consulta, em que data e por qual caminho ele apareceu, e exporta os resultados em CSV, JSON e Markdown.

A ferramenta não depende de um tema. O tema de um estudo está no catálogo, e o código não sabe nada sobre ele. O mesmo processo serve a qualquer estudo de mineração de repositórios: adoção de uma tecnologia, uso de um padrão arquitetural, presença de uma prática.

**O que a ferramenta faz:** executa buscas no GitHub, recupera integralmente cada consulta particionada, deduplica repositórios sem perder as origens, avalia regras opcionais de elegibilidade (coletando só os fatos que as regras pedem) e documenta a cobertura obtida.

**O que ela não faz:** não confirma que um candidato pertence ao fenômeno pesquisado, não classifica repositórios e não mede prevalência. Os candidatos seguem para triagem humana.

O guia [PROCESS.md](PROCESS.md) descreve, passo a passo e para quem não conhece o projeto, como a mineração acontece e como os dados são tratados.

## Requisitos e instalação

- Node.js 26.9.0, conforme `.nvmrc`.
- pnpm 9.15.9, declarado em `package.json`.
- Um token do GitHub com acesso de leitura a repositórios públicos.

Com fnm e Corepack instalados:

```sh
fnm install
fnm use
corepack enable
pnpm install --frozen-lockfile
pnpm run build
```

Verificações locais:

```sh
pnpm run check
pnpm run typecheck
pnpm test
```

## Credencial do GitHub

As buscas exigem `GITHUB_TOKEN` no ambiente do processo. O token é usado apenas por `discover` e nunca é gravado no banco, nos relatórios ou nas mensagens de erro. `report` e `--help` não precisam dele.

```sh
export GITHUB_TOKEN='<token>'
```

## Uso rápido

```sh
# 1. Conferir o volume de cada subconsulta, sem criar arquivos
pnpm run cli discover --queries <catalogo.json> --dry-run > dry-run.md

# 2. Executar uma rodada num diretório novo
pnpm run cli discover --queries <catalogo.json> --output data/discovery/rodada-001

# 2b. Idem, com regras de elegibilidade (protocolo opcional)
pnpm run cli discover --queries <catalogo.json> --protocol <protocolo.json> --output data/discovery/rodada-001

# 3. Retomar uma rodada interrompida ou parcial
pnpm run cli discover --resume data/discovery/rodada-001

# 4. Regenerar os relatórios a partir do banco, sem token
pnpm run cli report --run data/discovery/rodada-001

# 5. Sortear uma amostra aleatória de uma rodada já exportada, sem rede nem token
pnpm run cli sample --config config/samples/<amostra>.json --output data/samples/amostra-001

# 6. Clonar a amostra para a catalogação manual (rede e git; sem token)
pnpm run cli clone --sample data/samples/amostra-001

# 7. Adquirir snapshots normalizados dos repositórios anotados como finais (git local; sem rede nem token)
pnpm run cli acquire --config config/acquisitions/<aquisicao>.json --output data/acquisitions/aquisicao-001

# 8. Localizar artefatos e padrões nos snapshots adquiridos (sem rede, git nem token)
pnpm run cli mine --config config/mining/<mineracao>.json --output data/mining/mineracao-001

# 9. Listar as dependências declaradas nos manifestos, ligadas às ocorrências da mineração (sem rede, git nem token)
pnpm run cli inspect-dependencies --config config/inspections/<inspecao>.json --output data/inspections/inspecao-001
```

O dry-run retorna `2` quando alguma subconsulta passa de 1.000 resultados, sinal de que a partição precisa ser refinada antes da rodada. Uma rodada nova não reutiliza um diretório que já contenha `discovery.sqlite`.

As buscas de repositórios e de código executam em paralelo; dentro de cada endpoint, as subconsultas e suas páginas seguem em sequência. Quando há regras de elegibilidade, a coleta dos fatos que elas pedem acontece durante as buscas e ao final.

`report` regenera os arquivos a partir do banco, sem rede nem token, e não altera o estado persistido da rodada: só `discover --resume` recalcula e grava esse estado.

## Catálogo

O catálogo é um arquivo JSON com um único campo, `queries`, que descreve o que buscar e por quê. Exemplo mínimo:

```json
{
  "queries": [
    {
      "id": "terminology-topic-example",
      "strategy": "terminology",
      "endpoint": "repositories",
      "q": "topic:example-term",
      "rationale": "Tópico explícito que nomeia o fenômeno estudado."
    },
    {
      "id": "technology-example-package-code",
      "strategy": "technology",
      "endpoint": "code",
      "q": "\"example-library\" filename:package.json",
      "rationale": "Dependência declarada, independente da terminologia.",
      "partition": { "by": "size", "bounds": [0, 1000, 2000, 4000] }
    }
  ]
}
```

| Campo | Significado |
| --- | --- |
| `id` | Identificador único e estável da consulta. |
| `strategy` | Rótulo livre, escolhido pelo estudo, para o procedimento de descoberta a que a consulta pertence. Aceita letras minúsculas, dígitos e `-` ou `_` internos (`package-manifest`, `readme_terms`). Os relatórios contam e cruzam os rótulos presentes no catálogo, na ordem da primeira ocorrência; não existe um conjunto fixo. |
| `endpoint` | `repositories` (nome, descrição, README e tópicos) ou `code` (conteúdo de arquivos). |
| `q` | Expressão de busca do GitHub, sem `pushed:`, `created:` ou `size:`, que a ferramenta gera. |
| `rationale` | Por que a consulta existe. Obrigatório. |
| `partition` | Opcional. `{"by": "created", "from": "AAAA-MM-01", "interval": "month" \| "quarter" \| "year"}` para `repositories`, ou `{"by": "size", "bounds": [0, …]}` para `code`. |

A API de busca devolve no máximo 1.000 resultados por consulta. A partição divide uma consulta grande em subconsultas menores, para que nenhum resultado seja perdido pelo corte do GitHub. Para mudar o catálogo, crie uma rodada nova; uma rodada sempre usa o catálogo gravado quando foi criada.

O catálogo só lê `queries`; outros campos são ignorados. Para recortar por data de atividade, declare uma regra `last_push` no protocolo (veja abaixo).

## Protocolo de elegibilidade

O protocolo é opcional e fica em um arquivo separado, passado por `--protocol`. Sem protocolo, ou com `"eligibility": []`, a rodada registra um protocolo vazio: todo candidato fica `not_applied`, não há coleta de metadados nem de atividade, e nenhuma subconsulta recebe filtro temporal. As opções `--activity-*` exigem um protocolo com regras e são rejeitadas fora dele, inclusive na retomada de uma rodada que não tem regras.

```json
{
  "eligibility": [
    {
      "id": "recent-human-commit",
      "type": "recent_commit",
      "since": "2025-04-01",
      "dateField": "committedDate",
      "branches": "all",
      "authors": "human"
    }
  ]
}
```

Há dois tipos de regra:

- `recent_commit` procura ao menos um commit com autor humano desde meia-noite UTC inclusiva da data configurada, usando `committedDate`, em qualquer branch existente. A branch padrão tem prioridade operacional. O autor é a referência, independentemente do committer, merges, auto-merges, rebases ou cherry-picks. A janela termina no instante de inspeção persistido para o candidato. Essa regra não acrescenta filtro de push à busca.
- `last_push` compara o último push do repositório com a data configurada e é a forma de recortar a rodada por atividade. Com a regra, a ferramenta acrescenta `pushed:>=<data>` às subconsultas de `repositories` (a data mais recente entre as regras `last_push`), inclusive no dry-run. A busca de código não aceita esse filtro: para candidatos encontrados só por código, sem push conhecido, a ferramenta coleta os metadados do repositório pelo GraphQL e avalia a regra com o push coletado.

O catálogo e o protocolo ficam fixos ao criar a rodada. O que conta como atividade em `last_push`:

- **Push não é commit.** O que conta é quando os commits chegaram ao GitHub, não a data registrada neles.
- **Qualquer branch conta.** Um push em um branch que não é o principal também atualiza a data.
- **"Até hoje" significa até a coleta.** A data é lida quando o repositório aparece na busca ou quando seus metadados são coletados; pushes posteriores à rodada não alteram o resultado dela.
- **Atividade recente não é implementação recente.** Para critérios sobre commits, use `recent_commit`.

A coleta de fatos é dirigida pelas regras que ainda precisam deles. As opções `--activity-max-requests` (20), `--activity-commits-per-page` (30), `--activity-branches-per-page` (100) e `--activity-max-duration-ms` (sem teto por padrão) controlam a operação. Todos os valores são inteiros positivos, e páginas aceitam no máximo 100 itens. Cada tentativa de atividade, inclusive retry, consome o orçamento por candidato/invocação; a duração ativa inclui espera HTTP e retries, sem o tempo parado na fila. Na retomada, os tamanhos de página omitidos herdam os valores da primeira invocação; mudanças explícitas incompatíveis em `--activity-commits-per-page` ou `--activity-branches-per-page` são rejeitadas. Os orçamentos de requisições e duração podem mudar por invocação. Resume registra nova invocação e preserva consumo e checkpoints anteriores; não aceita substituir `--queries` ou `--protocol`. Ao retomar, a CLI escreve em stderr quantas subconsultas e tarefas de coleta continuam pendentes e, em rodadas grandes, mostra a fase "Avaliando" (reavaliação só dos candidatos com evidências novas) antes das primeiras requisições; Ctrl+C interrompe essa fase em segundos e a próxima retomada continua de onde parou.

Limite, falha ou autoria indeterminada produzem `unknown`, nunca reprovação automática. Uma ambiguidade terminal de autor com cobertura completa permite rodada `complete`; trabalho necessário ainda pendente, com erro ou limitado deixa a rodada parcial. A elegibilidade não confirma a presença do fenômeno pesquisado.

Dry-run aceita protocolo e expande o plano de busca, consulta apenas totais e aponta saturação. Ele não coleta commits nem avalia elegibilidade dos candidatos e rejeita opções explícitas de orçamento de atividade.

A execução de descoberta é serializada: apenas um processo ativo pode possuir uma rodada. Há proteção de propriedade dentro do processo; retomadas concorrentes em processos diferentes não são suportadas e exigiriam um lease externo. Execute `discover --resume` somente depois de encerrar o processo anterior.

## Saídas

Cada rodada grava em seu diretório:

| Arquivo | Conteúdo |
| --- | --- |
| `discovery.sqlite` | Fonte de verdade da rodada: catálogo, protocolo, subconsultas, páginas brutas, candidatos, hits, fatos coletados, tarefas, checkpoints e invocações. |
| `candidates.csv` | Um registro por repositório: `id`, `full_name`, `url`, `strategies` (rótulos do catálogo que o encontraram, separados por `;`, na ordem do catálogo) e `metadata_json`, com só os campos de análise da busca (`description`, `topics`, `language`, `license`, `created_at`, `pushed_at`, `size`, `stargazers_count`, `forks_count`, `archived`, `fork`, `default_branch`, `homepage`). Com regras de elegibilidade, acrescenta `eligibility_status`, `eligibility_results_json` e `evidence_json`. |
| `discovery-hits.csv` | Cada ocorrência de um repositório numa subconsulta, com consulta, subconsulta, `q` efetivo, endpoint, data de coleta e caminho do arquivo. |
| `coverage.json` | Totais, contagens e interseções por estratégia (`byStrategy.all`, `intersections.all`) e cobertura por consulta e por subconsulta. Com regras, acrescenta `byEligibility`, `unknownReasons`, `byStrategy.pass`, `intersections.pass` e `collection` (resumo e custo da coleta). |
| `report.md` | Diagnóstico legível: cobertura por consulta, subconsultas que exigem revisão, contagens e interseções por estratégia e limitações. Com regras, inclui as seções de elegibilidade, coleta e custo e refs observadas. |
| `manifest.json` | Identificação da rodada, hashes do catálogo e do protocolo, data de expansão, versões dos avaliadores, ambiente, revisão e estado da árvore git (`git.dirty`) e SHA-256 dos arquivos exportados. |

Sem protocolo (ou com protocolo sem regras), as colunas e seções de elegibilidade não existem, e a rodada não coleta metadados além dos devolvidos pela busca: candidatos encontrados só pela busca de código não trazem `pushed_at`, estrelas ou data de criação. Quem precisa desses metadados, ou de recorte temporal, declara uma regra `last_push`.

Os metadados originais do primeiro encontro e os hits permanecem preservados no banco. Para análise, a ferramenta projeta uma única observação REST de repositório: prefere push válido e, entre observações equivalentes, a menor data de coleta, com desempate por subconsulta e caminho. Todos os campos dessa projeção vêm da mesma observação; sem hit REST, usa o primeiro encontro.

Cada exportação lê uma fotografia consistente do SQLite, incluindo CSV, cobertura e estado da rodada. Durante a coleta, `report` pode exportar enquanto outra conexão grava páginas; novas gravações aparecem na exportação seguinte. Enquanto o banco estiver aberto, podem existir `discovery.sqlite-wal` e `discovery.sqlite-shm`, arquivos auxiliares do modo WAL. Use no máximo um processo de descoberta gravando e um exporter ativo por diretório; evite sobrepor `report` à exportação final de `discover`.

## Amostragem

`sample` sorteia uma amostra aleatória simples dos candidatos de uma rodada **já exportada**. Ele lê só o `candidates.csv` da rodada, sem rede, sem `GITHUB_TOKEN` e sem abrir o `discovery.sqlite`, e não altera nenhum arquivo da rodada.

```sh
pnpm run cli sample --config config/samples/mfe-sample-001.json --output data/samples/mfe-sample-001
```

**Configuração** (`config/samples/<nome>.json`; campos desconhecidos são erro):

```json
{
  "run": "data/discovery/mfe-round-002",
  "filter": {
    "eligibilityStatus": ["pass", "unknown"],
    "excludeReasons": ["push_unavailable"]
  },
  "size": 380,
  "seed": "mfe-sample-001"
}
```

| Campo | Significado |
| --- | --- |
| `run` | Diretório da rodada exportada, relativo ao diretório de trabalho. Precisa ter `candidates.csv`, `coverage.json` e `manifest.json`. |
| `size` | Tamanho X da amostra (inteiro positivo). |
| `seed` | Texto não vazio que define o sorteio. |
| `filter` | Opcional. `eligibilityStatus` mantém só os candidatos com esses status (`pass`, `fail`, `unknown`, `not_applied`); depois, `excludeReasons` descarta quem tem ao menos um resultado de regra com um desses motivos. Exige que o `candidates.csv` tenha as colunas de elegibilidade. |

O recorte é uma decisão da análise, não do protocolo de elegibilidade. Por isso fica na configuração da amostra, e não no código nem numa nova descoberta.

**Conferência da fonte, antes de sortear.** `sample` recusa a rodada (código `1`, nada gravado) quando:

1. o SHA-256 do `candidates.csv` difere do registrado em `manifest.json` (por exemplo, o arquivo foi aberto e salvo numa planilha); a mensagem traz os dois hashes;
2. as contagens recalculadas a partir das linhas diferem do `coverage.json`: o total contra `totals.uniqueCandidates`, os status contra `byEligibility` e os motivos distintos dos candidatos `unknown` contra `unknownReasons` (ignorando `pending_evaluation`).

**Método de sorteio.** A população filtrada (N candidatos) é ordenada pelo SHA-256 hexadecimal de `seed + ":" + id`, em ordem crescente, com desempate pelo `id` numérico. A amostra são os `size` primeiros. O resultado depende só da seed e do conjunto de candidatos, nunca da ordem das linhas, e uma amostra menor é sempre o começo de uma maior com a mesma seed. Qualquer pessoa com o `candidates.csv`, a seed e uma implementação de SHA-256 reproduz o sorteio.

**Saídas** (o diretório não pode conter `sample.csv`, `ranking.csv`, `manifest.json`, `clones.csv` nem `catalog.csv`; uma amostra existente nunca é sobrescrita):

| Arquivo | Conteúdo |
| --- | --- |
| `ranking.csv` | A população filtrada inteira, em ordem de sorteio: `rank`, `id`, `full_name`, `url`, `strategies`, `eligibility_status`, `hash`. |
| `sample.csv` | Os `size` primeiros do ranking, com as mesmas colunas. Os valores de `id`, `full_name`, `url`, `strategies` e `eligibility_status` são cópias do `candidates.csv` de origem, e o `id` é a chave para voltar a ele. |
| `manifest.json` | Caminho e `run.id` da rodada, SHA-256 do `candidates.csv` e resultado das conferências, configuração e seu hash, seed, totais (`source`, `population` = N, `size` = X), exclusões por status e por motivo (`exclusions`; um candidato com dois motivos excluídos conta uma vez em cada), data de criação e SHA-256 do `ranking.csv` e do `sample.csv`. |

## Clone da amostra

`clone --sample <dir>` clona os repositórios de uma amostra feita por `sample` e prepara a planilha da catalogação manual. Ele exige o executável `git` no `PATH` e acesso de rede ao GitHub, mas não usa `GITHUB_TOKEN`: o clone é anônimo, com `GIT_TERMINAL_PROMPT=0`, então um repositório privado ou apagado falha sem pedir credenciais.

```sh
pnpm run cli clone --sample data/samples/mfe-sample-001
```

**Modo de clone.** Cada repositório é clonado de `https://github.com/<full_name>.git` com `git clone --filter=blob:none` em `<dir>/repos/<owner>__<name>/`. Esse modo traz o histórico de commits e as referências de todas as branches, mas só baixa os arquivos (blobs) da branch padrão; os demais chegam sob demanda, quando o repositório é usado (a primeira leitura de um arquivo de outra branch precisa de rede). O clone é sequencial e mostra o repositório atual na barra de progresso.

**Substituição.** Quando um clone falha, o repositório é substituído pelo próximo do `ranking.csv` que ainda não foi tentado, até que `size` repositórios estejam clonados ou o ranking acabe. Como o ranking é a população inteira em ordem de sorteio, a amostra final continua sendo uma amostra aleatória simples dos repositórios acessíveis.

**Arquivos gravados no diretório da amostra:**

| Arquivo | Conteúdo |
| --- | --- |
| `repos/` | Um diretório por repositório clonado. Cada clone vai antes para `repos/.<owner>__<name>.partial` e só é renomeado depois de bem-sucedido. |
| `clones.csv` | Uma linha por tentativa, só com acréscimos: `rank`, `id`, `full_name`, `status` (`cloned` ou `failed`), `commit_sha` e `branch` (o HEAD clonado, vazios em falha), `attempted_at`, `replaces` (o `id` do repositório que este substitui, vazio para os sorteados originalmente) e `error` (a mensagem do git em falha, para distinguir um 404 de um timeout). |
| `catalog.csv` | A planilha de catalogação: `id`, `url` e `classification`, uma linha por repositório clonado, em ordem de rank. **A classificação é 100% manual:** a ferramenta nunca preenche a coluna. |

**Integridade.** Antes de clonar, o `clone` confere o SHA-256 do `sample.csv` e do `ranking.csv` contra o `manifest.json` gravado pelo `sample`. Assim a ordem de substituição é sempre a do sorteio original; um arquivo editado à mão faz o comando falhar com os dois hashes na mensagem.

**Retomada.** Execute `clone` de novo sobre o mesmo diretório para continuar. O estado vem do `clones.csv`: o que já está registrado (clonado ou falho) não é tentado outra vez, um diretório em `repos/` sem linha no `clones.csv` é descartado e clonado de novo, e uma amostra já completa não tenta nada. Uma falha de rede passageira conta como falha definitiva e gera substituição; repetir a tentativa ficaria fora da regra de substituição. Ctrl+C descarta o clone em andamento, sem registrá-lo, e mantém o que já foi gravado.

**O `catalog.csv` só recebe acréscimos.** A ferramenta nunca reescreve o arquivo: só acrescenta linhas para `id`s que ainda não estão nele, preservando as classificações e as colunas que o pesquisador adicionar. Se o arquivo não terminar em quebra de linha (por exemplo, depois de salvar numa planilha), ela acrescenta uma antes. Ao salvar numa planilha, **mantenha vírgula como separador e UTF-8**; se o arquivo ficar ilegível, o `clone` falha com código `1` em vez de duplicar linhas.

**Códigos de saída do `clone`:** `0` quando `size` repositórios estão clonados; `1` em erro de entrada ou ambiente (sem `sample.csv`, `ranking.csv` ou `manifest.json`, `git` ausente, ou um hash de `sample.csv` ou `ranking.csv` diferente do `manifest.json`); `2` quando termina com menos de `size` clones (ranking esgotado ou interrupção por Ctrl+C).

## Aquisição dos snapshots

`acquire --config <arquivo> --output <dir>` parte de uma amostra já clonada e das anotações do pesquisador e grava, para cada repositório selecionado, um **snapshot normalizado**: os arquivos da árvore do commit classificado, menos o que as regras de normalização removem, com o registro do que foi removido e por quê. Ele exige o executável `git` 2.44 ou mais novo no `PATH`; não usa rede nem `GITHUB_TOKEN` e não altera a amostra, os clones nem as anotações.

```sh
pnpm run cli acquire --config config/acquisitions/mfe-corpus-001.json --output data/acquisitions/mfe-corpus-001
```

**Configuração.** O JSON declara tudo o que depende do estudo; o código não conhece classificações, estados nem nomes de campos. Os caminhos são relativos ao diretório de trabalho. Campo desconhecido, tipo inválido ou preset inexistente terminam com código `1`, sem gravar nada.

| Campo | Significado |
| --- | --- |
| `sample` | Diretório da amostra (com `sample.csv`, `ranking.csv`, `clones.csv`, `catalog.csv`, `manifest.json` e `repos/`). |
| `include.classification`, `include.status` | Valores aceitos da `classification` e do estado da anotação. Só as anotações que casam nos dois são adquiridas. |
| `annotations.files` | Padrão glob dos arquivos de anotação (Markdown com front matter YAML). |
| `annotations.statusField` | Onde fica o estado; padrão `annotation.status`. Caminhos com ponto leem mapas aninhados. |
| `annotations.required` | Campos que toda anotação selecionada deve ter: existir, não ser `null` e, se for lista, não ser vazia. |
| `annotations.export` | Campos da anotação copiados para colunas do `acquisition.csv` (listas unidas por `;`, mapas em JSON, `null` vazio). |
| `exclude.presets` | Presets de exclusão (abaixo). |
| `exclude.paths` | Padrões glob extras sobre o caminho com `/` (por exemplo `**/*.min.js`). |
| `exclude.maxFileBytes` | Remove arquivos maiores que esse tamanho. |

**Anotações.** Cada arquivo precisa de front matter entre `---` com `schema: 1`, `id`, `full_name`, `commit` (SHA de 40 caracteres), `classification` e o campo de estado. O YAML é lido em YAML 1.2, em que `yes` e `no` são texto. O corpo Markdown e o significado dos valores não são interpretados.

**Validação antes de gravar.** O comando confere o SHA-256 do `sample.csv` e do `ranking.csv` contra o `manifest.json` da amostra e cruza as anotações com `clones.csv` (só `cloned`) e `catalog.csv`. Recusa a execução, listando **todos** os problemas e sem criar arquivos em `--output`, quando há `id` duplicado ou fora da amostra, `full_name` ou `commit` diferentes do `clones.csv`, classificação diferente da do `catalog.csv`, classificação vazia no catálogo para um `id` anotado, classificação incluída no catálogo sem anotação, ou campo obrigatório ausente, nulo ou vazio.

**Snapshot.** O commit é o `commit_sha` do `clones.csv`, o mesmo avaliado na classificação, e não a branch em checkout nem a última release. Os arquivos são lidos do banco de objetos do clone (`git ls-tree` e `git cat-file`) com `GIT_NO_LAZY_FETCH=1`: um conteúdo que falta no clone parcial faz o snapshot falhar, nunca uma busca na rede. Submódulos e links simbólicos não são seguidos: ficam registrados no `normalization.json` com o commit ou o alvo.

**Presets de exclusão.** Decididos por segmento de diretório do caminho e por extensão:

| Preset | Remove |
| --- | --- |
| `node` | `node_modules`, `bower_components`, `.pnpm-store`, `.yarn/cache` |
| `python` | `.venv`, `venv`, `__pycache__`, `.tox` e arquivos `*.pyc` |
| `build-output` | `dist`, `build`, `out`, `.next`, `.nuxt`, `.output`, `.angular`, `.svelte-kit`, `.turbo`, `.cache`, `coverage` |
| `binaries` | extensões de imagem, mídia, fonte, arquivo compactado e executável, e qualquer arquivo com byte NUL nos primeiros 8 KB |

Lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `poetry.lock`, `Cargo.lock` e outros) nunca são removidos por um preset, porque a mineração de artefatos os usa. Um diretório `build/` que seja código-fonte pode ser preservado trocando o preset por padrões explícitos em `exclude.paths`; como isso muda a configuração, exige um novo diretório de saída.

**Saídas em `--output`:**

| Arquivo | Conteúdo |
| --- | --- |
| `corpus/<owner>__<name>/files/` | Os arquivos mantidos do snapshot. |
| `corpus/<owner>__<name>/normalization.json` | `id`, commit, data de aquisição, regras efetivas, caminhos removidos com motivo e tamanho (`preset:<nome>`, `path:<padrão>`, `max-file-bytes`), submódulos e links simbólicos, arquivos e bytes mantidos, bytes por linguagem e o `contentSha256`, hash do conteúdo adquirido que não depende da ordem de leitura nem do sistema de arquivos. |
| `acquisition.csv` | Uma linha por repositório adquirido, em ordem de rank: `id`, `full_name`, `url`, `commit_sha`, `default_branch`, `discovered_at` (menor `fetched_at` do repositório no `discovery-hits.csv` da rodada de origem), `acquired_at`, `strategies`, `discovery_language` e `discovery_size_kb` (vazios quando a descoberta não os registrou, como nos achados só pela busca de código), `files`, `bytes`, `languages_by_extension`, `content_sha256` e os campos de `annotations.export`. É regravado inteiro a cada execução. |
| `manifest.json` | SHA-256 canônico da configuração, hashes do `sample.csv` e do `ranking.csv`, SHA-256 do arquivo de anotação lido por repositório adquirido e os repositórios que deixaram de ser selecionados. |

**Linguagens por extensão.** `languages_by_extension` soma os bytes por extensão de arquivo (`.ts` e `.tsx` são TypeScript, `.vue` é Vue, e assim por diante; o que não está no mapa vai para `Other`). É uma **aproximação**, não uma detecção por conteúdo, e é independente da linguagem que o GitHub registrou na descoberta (`discovery_language`).

**Retomada e reprodutibilidade.** Rodar de novo sobre o mesmo `--output` mantém os snapshots completos (diretório com `normalization.json`), descarta os `.partial` e adquire só os que faltam, em ordem de rank. Uma configuração ou amostra diferente da registrada no `manifest.json` termina com código `1` sem alterar nada: use outro diretório de saída. Um repositório já adquirido que deixa de ser selecionado (por exemplo, uma anotação reaberta para `review`) mantém o snapshot no disco, sai do `acquisition.csv`, entra na lista de não selecionados do `manifest.json` e é avisado na saída. Ctrl+C descarta o snapshot em andamento e mantém os completos.

**Códigos de saída do `acquire`:** `0` quando todos os repositórios selecionados têm snapshot; `1` em erro de configuração, de entrada ou de ambiente (anotações inconsistentes, amostra alterada, saída com outra configuração, `git` ausente ou anterior a 2.44); `2` quando termina com algum selecionado sem snapshot, por falha de leitura do commit ou por interrupção.

## Mineração de artefatos

`mine --config <arquivo> --output <dir>` lê uma aquisição já feita e localiza, dentro de cada snapshot, os arquivos por **tipo de artefato** e as ocorrências dos **padrões** de um catálogo. Não usa rede, `git` nem `GITHUB_TOKEN` e não altera a aquisição. A saída **localiza e não interpreta**: não classifica evidência, não atribui força, não infere relações entre unidades e não afirma que um repositório pertence ao fenômeno. É o ponto de partida da inspeção manual.

```sh
pnpm run cli mine --config config/mining/mfe-mining-001.json --output data/mining/mfe-mining-001
```

**Configuração.** Tipos de artefato e padrões vêm do JSON, nunca do código. Campo desconhecido, ausente ou de tipo inválido, `id` repetido, tipo de artefato não definido e expressão regular inválida terminam com código `1`, sem gravar nada.

| Campo | Significado |
| --- | --- |
| `acquisition` | Diretório da aquisição (com `manifest.json`, `acquisition.csv` e `corpus/`). |
| `version` | Versão do catálogo, texto não vazio, declarada pelo pesquisador e alterada a cada revisão. |
| `artifactTypes` | Mapa de id para lista de globs sobre o caminho relativo a `files/`, com `/`. Um arquivo recebe **todos** os tipos cujos globs casam, ou nenhum. |
| `patterns[].id` | Identificador único do padrão. |
| `patterns[].artifactTypes` | Tipos de artefato em que o padrão se aplica (lista não vazia de ids definidos em `artifactTypes`). |
| `patterns[].regex` | Expressão regular avaliada **linha a linha**. Sem ela, o padrão é de presença: uma ocorrência por arquivo dos seus tipos, sem linha nem trecho. |
| `patterns[].ignoreCase` | Ignora maiúsculas e minúsculas; padrão `false`. |
| `patterns[].rationale` | Justificativa curta, obrigatória. |
| `units.artifactTypes` | Tipos cujos arquivos marcam uma unidade candidata. |

**Integridade da aquisição.** Antes de gravar, o comando confere, para cada linha do `acquisition.csv`, que o snapshot existe, que o `contentSha256` do `normalization.json` é igual ao `content_sha256` da linha e que o hash recalculado dos arquivos de `files/` é igual a ambos (caminho, bit de execução e SHA-256 de cada arquivo). Lista **todos** os problemas e termina com código `1`, sem gravar nada.

**Busca.** Cada arquivo é lido como UTF-8 (caracteres inválidos são substituídos) e dividido em linhas, sem `\r`. Uma linha gera no máximo uma ocorrência por padrão, com o trecho limitado a 300 caracteres. Não há análise sintática, busca em várias linhas nem resolução de imports: um padrão deve casar com a linha onde a construção começa. As **unidades candidatas** são os diretórios que contêm diretamente um arquivo com tipo de `units.artifactTypes` (a raiz é `.`).

**Saídas em `--output`:**

| Arquivo | Conteúdo |
| --- | --- |
| `repos/<owner>__<name>/artifacts.csv` | Todos os arquivos do snapshot: `path`, `artifact_types` (ids unidos por `;`, na ordem da configuração) e `bytes`. |
| `repos/<owner>__<name>/matches.csv` | `pattern`, `path`, `line` e `excerpt`, na ordem do catálogo, caminho e linha; `line` e `excerpt` vazios nos padrões de presença. |
| `repos/<owner>__<name>/units.csv` | `directory` e `markers` (caminhos unidos por `;`). |
| `summary.csv` | Uma linha por par (repositório, padrão), na ordem do `acquisition.csv` e do catálogo: `id`, `full_name`, `pattern`, `matches` e `files`. Pares sem ocorrência aparecem com zero, para que a ausência fique registrada. |
| `manifest.json` | A configuração, seu SHA-256, `version`, os SHA-256 do `manifest.json` e do `acquisition.csv` da aquisição e o hash de conteúdo de cada snapshot. |

Caminhos são ordenados por code point, não pela localidade.

**Reexecução.** Rodar de novo com o mesmo `--output`, a mesma configuração e a mesma aquisição refaz toda a saída, com CSVs idênticos byte a byte. A saída é montada em `<output>.partial` e só então substitui `<output>`; uma falha deixa a saída anterior intacta. Uma configuração ou aquisição diferente da registrada no `manifest.json`, ou um diretório não vazio que não seja uma saída do `mine`, termina com código `1` sem alterar nada: use outro diretório de saída.

**Códigos de saída do `mine`:** `0` quando grava toda a saída; `1` em erro de configuração, de entrada, de integridade, de leitura ou de escrita.

## Inspeção de dependências

`inspect-dependencies --config <arquivo> --output <dir>` parte de uma saída do `mine` e da aquisição que ela usou. Lê cada `package.json` dos snapshots como JSON e lista as dependências dos pacotes das **tecnologias** declaradas na configuração, com manifesto, linha, seção e versão como escrita, ligadas às ocorrências da mineração no mesmo pacote e em outros. Não usa rede, `git` nem `GITHUB_TOKEN` e não altera a aquisição nem a mineração.

```sh
pnpm run cli inspect-dependencies --config config/inspections/mfe-dependencies-001.json --output data/inspections/mfe-dependencies-001
```

**O que é automático e o que é manual.** O comando extrai o que o manifesto declara e registra, por co-localização, onde a mineração achou configuração dessa tecnologia. Ele **não decide** se a dependência está em uso, se está configurada de fato ou se tem algum papel arquitetural: uma ocorrência no mesmo pacote não prova uso, e a ausência de uma não prova que não há. Esse julgamento exige ler o código e continua sendo do pesquisador.

**Configuração.** As tecnologias vêm do JSON, nunca do código. Campo desconhecido, ausente ou de tipo inválido, `id` repetido, expressão regular inválida e id de padrão que não existe no catálogo da mineração terminam com código `1`, sem gravar nada.

| Campo | Significado |
| --- | --- |
| `mining` | Diretório de saída de um `mine`. |
| `version` | Versão da configuração, texto não vazio, declarada pelo pesquisador e alterada a cada revisão. |
| `technologies[].id` | Identificador único da tecnologia. |
| `technologies[].packages` | Lista não vazia de expressões regulares aplicadas ao nome do pacote, usadas como escritas (sem âncoras implícitas). |
| `technologies[].patterns` | Lista não vazia de ids de padrões do catálogo da mineração, de qualquer tipo de artefato, cujas ocorrências são ligadas às dependências da tecnologia. |

**Limite: dependência vazia não é ausência da tecnologia.** O comando só lista pacotes declarados. Uma tecnologia que vem embutida em outra ferramenta, como o Module Federation do webpack 5 (`webpack.container.ModuleFederationPlugin`), não tem pacote próprio, e o repositório fica com `dependencies.csv` só com o cabeçalho e zeros no `summary.csv`, mesmo configurando a tecnologia. Esses casos só aparecem pelas ocorrências `cfg-*` do `mine`; no piloto (`mfe-dependencies-001`), 5 dos 15 repositórios estão assim.

**Integridade das entradas.** Antes de gravar, o comando verifica a aquisição que o `manifest.json` da mineração registra, como o `mine`, e confere que os SHA-256 do `manifest.json` e do `acquisition.csv` e o hash de conteúdo de cada snapshot são os que a mineração registrou, que cada repositório tem `matches.csv` e que os padrões das tecnologias existem no catálogo da mineração. Lista **todos** os problemas e termina com código `1`, sem gravar nada.

**Extração.** Todo arquivo chamado `package.json` é lido. As seções `dependencies`, `devDependencies`, `peerDependencies` e `optionalDependencies` são examinadas, e cada entrada cujo nome casa com um pacote de uma tecnologia gera uma dependência por tecnologia (um pacote que casa com duas tecnologias gera duas linhas). Um pacote citado só em um script não é dependência. A versão é gravada como escrita (`^19.0.0`, `workspace:*`, `file:../shared`); um valor que não é texto é gravado em JSON canônico. A linha é a primeira, depois da que abre a seção, que contém o nome entre aspas seguido de `:`; fica vazia se não for encontrada. Um manifesto que não é JSON válido é registrado como `invalid`, sem dependências, e não interrompe a execução.

**Pacote.** O pacote de um arquivo é o diretório do `package.json` mais próximo que o contém no snapshot, comparando segmentos (`app` não contém `app-2/x`); `.` é o `package.json` da raiz. Todo `package.json` conta, válido ou não. Um arquivo que nenhum `package.json` contém tem pacote vazio e não está no mesmo pacote de nenhum manifesto. Subdiretórios sem `package.json` próprio, como `src/` de um projeto Angular ou `projects/<app>/` de um workspace, pertencem ao pacote acima deles. As unidades do `units.csv` da mineração não são usadas.

**Saídas em `--output`:**

| Arquivo | Conteúdo |
| --- | --- |
| `repos/<owner>__<name>/dependencies.csv` | `manifest`, `line`, `section`, `package`, `version`, `technology`, `same_package_matches` e `other_package_matches`. As duas últimas são listas `caminho:linha` (ou só `caminho`, em ocorrência sem linha) unidas por `;`, ordenadas por caminho e linha: as ocorrências dos padrões da tecnologia no pacote do manifesto e nos demais. Ordenado por manifesto, seção, pacote e ordem das tecnologias na configuração. |
| `repos/<owner>__<name>/manifests.csv` | `manifest` e `state` (`ok` ou `invalid`), ordenado por manifesto. |
| `summary.csv` | Uma linha por par (repositório, tecnologia), na ordem do `acquisition.csv` e da configuração: `id`, `full_name`, `technology`, `dependencies` e `dependencies_with_same_package_matches`. Pares sem dependência aparecem com zero. |
| `manifest.json` | A configuração, seu SHA-256, `version`, o diretório e o SHA-256 do `manifest.json` da mineração. |

Caminhos são ordenados por code point, não pela localidade.

**Reexecução.** Rodar de novo com o mesmo `--output`, a mesma configuração e a mesma mineração refaz toda a saída, com CSVs idênticos byte a byte. A saída é montada em `<output>.partial` e só então substitui `<output>`; uma falha deixa a saída anterior intacta. Uma configuração ou mineração diferente da registrada no `manifest.json`, ou um diretório não vazio que não seja uma saída do `inspect-dependencies`, termina com código `1` sem alterar nada: use outro diretório de saída.

**Códigos de saída do `inspect-dependencies`:** `0` quando grava toda a saída; `1` em erro de configuração, de entrada, de integridade, de leitura ou de escrita.

## Códigos de saída

- `0`: ajuda exibida, relatório exportado, amostra gravada pelo `sample`, amostra completa no `clone`, todos os selecionados adquiridos no `acquire`, saída completa gravada pelo `mine` ou pelo `inspect-dependencies`, dry-run sem subconsulta acima de 1.000 resultados, ou rodada com busca completa e todo trabalho necessário concluído, inclusive quando resta autoria terminal `unknown`.
- `1`: erro fatal, como opções ou catálogo inválidos, token ausente, diretório ou banco inexistente ou conflitante, banco de formato incompatível, falha de requisição no dry-run, `git` ausente ou diretório sem amostra no `clone`, ou, no `acquire`, configuração ou anotações inválidas, amostra alterada e saída feita com outra configuração, ou, no `mine`, configuração inválida, snapshot ausente ou alterado e saída feita com outra configuração ou aquisição, ou, no `inspect-dependencies`, configuração inválida, mineração ou aquisição alterada depois da mineração e saída feita com outra configuração ou mineração, ou, no `sample`, configuração inválida, rodada com arquivos faltando, `candidates.csv` alterado ou com contagens divergentes do `coverage.json`, `size` maior que N e diretório de saída que já contém uma amostra.
- `2`: rodada parcial (subconsulta saturada, incompleta ou com falha, coleta ainda necessária pendente, com falha ou limitada por orçamento, interrupção) ou dry-run com subconsulta acima de 1.000 resultados; no `clone`, menos de `size` repositórios clonados (ranking esgotado ou interrupção); no `acquire`, algum selecionado sem snapshot (falha de leitura ou interrupção).

## Limitações

- A busca depende da indexação do GitHub, que pode mudar durante a rodada e marcar resultados como incompletos. Os totais descrevem as consultas executadas, não a população de repositórios.
- As APIs de busca excluem forks por padrão.
- A busca de código considera apenas a branch padrão e arquivos de até 384 KB, e não aceita filtros de data. Para recortar esses candidatos por data, declare uma regra `last_push`: a ferramenta coleta os metadados de que ela precisa.
- Contagens não são prevalência nem casos confirmados. Pertinência, classificação e elegibilidade ficam para a triagem humana.

## Caso de uso: micro-frontends

O catálogo [`config/catalogs/micro-frontends.json`](config/catalogs/micro-frontends.json) foi construído para o estudo *What Do Micro-Frontends Look Like in Software Repositories?*, que caracteriza como implementações de micro-frontends (MFEs) aparecem em repositórios. A descoberta produz o conjunto de candidatos que depois passa por triagem e classificação (*MFE-implemented*, *Non-MFE* ou *Uncertain*).

**As três estratégias deste estudo** (28 consultas). Os rótulos `terminology`, `technology` e `broader` são escolha do estudo, declarados no catálogo, e não um vocabulário da ferramenta:

| Estratégia | Consultas | Exemplos |
| --- | ---: | --- |
| `terminology` | 8 | `topic:microfrontends`; `"micro frontend" in:name,description,readme` |
| `technology` | 15 | Module Federation (`topic:module-federation`, `ModuleFederationPlugin remotes extension:js`, plugins Vite e Angular), single-spa (`"single-spa" filename:package.json`) e Web Components |
| `broader` | 5 | `"frontend composition"`, `"frontend orchestration"`, `"micro apps" frontend` |

**Decisões do estudo:**

- **Protocolo de atividade** ([`config/protocols/micro-frontends.json`](config/protocols/micro-frontends.json)): exige, nesta ordem, (1) push desde 01/04/2025 (`last_push`), que filtra a busca de repositórios com `pushed:>=2025-04-01` e reprova os inativos vindos só da busca de código; e (2) commit de autor humano com `committedDate` desde a mesma data na branch padrão (`recent_commit` com `branches: "default"`), coletado só para quem passou no push. O catálogo mantém as mesmas 28 consultas. O critério não data a introdução da arquitetura MFE.
- **Pré-requisitos da rodada oficial:** árvore git limpa (para que `manifest.json` registre `git.dirty: false`), Node 26.9.0 via `fnm use` (conforme `.nvmrc`) e um dry-run com `--protocol` antes da rodada, para confirmar que nenhuma partição passa de 1.000 resultados.
- **Partições:** termos MFE e `"module federation"` são particionados por mês de criação, porque cada termo soma entre 8 e 13 mil repositórios ativos. Consultas de código são particionadas por tamanho de arquivo, porque a busca de código não aceita datas.
- **Termos com hífen entre aspas:** sem aspas, `single-spa` é lido como "single" e "spa" (356 mil resultados contra 6 mil com aspas).
- **Tecnologias fixadas:** a estratégia `technology` cobre apenas Module Federation, single-spa e Web Components. Frameworks como qiankun, wujie, micro-app e Piral ficam de fora; repositórios que os usam e se descrevem como MFE ainda chegam pela terminologia.
- **Consultas de tecnologia sobre artefatos** (`package.json`, configurações com `remotes`, `registerApplication`), e não sobre prosa, para encontrar repositórios que usam a tecnologia sem se descrever como MFE.
- **Risco conhecido:** Web Components não tem um artefato que distinga uso como MFE de uma biblioteca de componentes. As duas consultas dessa abordagem exigem que o README também mencione micro-frontends, grafado como `"micro frontends"` ou `microfrontends`; os demais casos devem chegar pela terminologia e ser identificados na triagem.

**Execução:**

```sh
pnpm run cli discover --queries config/catalogs/micro-frontends.json --protocol config/protocols/micro-frontends.json --dry-run > dry-run.md
pnpm run cli discover --queries config/catalogs/micro-frontends.json --protocol config/protocols/micro-frontends.json --output data/discovery/mfe-rodada-001
```

O [PROCESS.md](PROCESS.md) acompanha uma consulta deste catálogo do início ao fim.
